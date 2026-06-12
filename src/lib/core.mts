// Consolidated backend core. Merged from: shared, style-guide, assets, codegen, review.
// Single shared module imported by src/agents/*.

import { Anthropic } from '@anthropic-ai/sdk';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Readable } from 'node:stream';
import { Resvg } from '@resvg/resvg-js';
import { appendAssetsReviewLog, type AssetsReviewOutput, assetsReviewOutputSchema, type AssetsReviewUsageTotals, logAssetsReviewAuditToConsole } from '../agents/creative-native-assets-review.mts';
import { type Browser, chromium, type Page } from 'playwright';
import { imageSizeFromFile } from 'image-size/fromFile';
import { pipeline } from 'node:stream/promises';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import mime from 'mime';
import { pathToFileURL } from 'node:url';
import type { UiReviewOutput } from '../agents/creative-native-ui-review.mts';

// ============================================================
// MODULE: shared
// ============================================================
// Auto-merged module: shared. Sources: repo-paths, anthropic-retry, image-search-types, anthropic-image-search, image-search, image-mime-sniff, asset-sidecar-files, asset-host-fail-fast, official-fetch, creative-pipeline-usage, studio-ad-formats.







// ===== repo-paths.mts =====
/** Repository root (parent of `src/`). Pass `import.meta.dirname` from any file under `src/`. */
export function repoRootFromModuleDir (moduleDirname: string): string {
  return join(moduleDirname, '..', '..');
}

/** Safe segment for `output/<name>/` (must match studio `isSafeOutputFolderSegment`). */
export function slugifyBrandForOutputDir (brandName: string): string {
  const trimmed = brandName.trim();
  if (trimmed.length === 0) {
    return 'brand';
  }
  const slug = trimmed
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'brand';
}

/** `output/<brand-slug>-<uuid>/` — easier to spot runs in the studio and on disk. */
export function buildOutputDirectoryName (brandName: string, uuid: string): string {
  return `${slugifyBrandForOutputDir(brandName)}-${uuid}`;
}

// ===== anthropic-retry.mts =====
/**
 * Retry avec backoff pour erreurs Anthropic transitoires (overloaded, 529, 503).
 */

export function isRetriableAnthropicError (err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const o = err as {
    type?: string;
    status?: number;
    message?: string;
    error?: { type?: string; error?: { type?: string; message?: string } };
  };

  if (o.type === 'overloaded_error' || o.type === 'rate_limit_error') {
    return true;
  }

  const status = o.status;
  if (status === 529 || status === 503 || status === 502) {
    return true;
  }

  const nestedType = o.error?.type ?? o.error?.error?.type;
  if (nestedType === 'overloaded_error' || nestedType === 'rate_limit_error') {
    return true;
  }

  const msg = `${o.message ?? ''} ${o.error?.error?.message ?? ''}`.toLowerCase();
  if (msg.includes('overloaded') || msg.includes('rate limit')) {
    return true;
  }

  return false;
}

function parseRetryIntEnv (name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(n, max);
}

function retryDelayMs (attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 1500);
  return Math.min(exp + jitter, 120_000);
}

export async function withAnthropicRetry<T> (
  label: string,
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<T> {
  const maxAttempts =
    options?.maxAttempts ?? parseRetryIntEnv('ANTHROPIC_RETRY_MAX_ATTEMPTS', 6, 12);
  const baseDelayMs =
    options?.baseDelayMs ?? parseRetryIntEnv('ANTHROPIC_RETRY_BASE_DELAY_MS', 8000, 60_000);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableAnthropicError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const waitMs = retryDelayMs(attempt, baseDelayMs);
      console.warn(
        `[anthropic-retry] ${label}: API temporairement surchargée (tentative ${String(attempt)}/${String(maxAttempts)}), nouvelle tentative dans ${String(Math.round(waitMs / 1000))}s…`
      );
      await new Promise((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
  }
  throw lastErr;
}

// ===== image-search-types.mts =====
export type ImageSearchProviderId = 'brave' | 'anthropic';

export type ImageSearchRow = {
  url: string;
  title: string;
  source: string;
  page_fetched?: string;
  thumbnail?: { src: string; width?: number; height?: number };
  properties?: {
    url: string;
    placeholder?: string;
    width?: number;
    height?: number;
  };
};

// ===== anthropic-image-search.mts =====
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const anthropicImageSearchSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            url: z.string().url(),
            title: z.string().optional(),
            source: z.string().optional()
          })
          .strict()
      )
      .describe('Direct HTTPS image URLs only (png, webp, jpg, jpeg, svg, gif)')
  })
  .strict();

function parseModelFromEnv (): string {
  const raw = process.env['CREATIVE_ANTHROPIC_IMAGE_SEARCH_MODEL']?.trim();
  return raw !== undefined && raw.length > 0 ? raw : DEFAULT_MODEL;
}

function looksLikeDirectImageUrl (url: string): boolean {
  const lower = url.toLowerCase();
  if (!/^https:\/\//iu.test(lower)) {
    return false;
  }
  return (
    /\.(png|jpe?g|webp|svg|gif)(\?|#|$)/iu.test(lower) ||
    /\/material\/|packshot|logo|wordmark|hero|banner/iu.test(lower)
  );
}

function buildUserPrompt (
  query: string,
  num: number,
  assetKind: 'logo' | 'product'
): string {
  const kindLabel = assetKind === 'logo' ? 'brand logo (transparent SVG or PNG preferred)' : 'product packshot / hero image';
  return (
    `Find up to ${String(num)} direct HTTPS image URLs for: ${query}\n\n` +
    `Asset type: ${kindLabel}.\n` +
    'Use web_search to find official or Wikimedia sources.\n' +
    'Return ONLY direct image file URLs (not HTML pages). Prefer official brand sites.\n' +
    'Each result must be a full URL starting with https:// ending with an image path or extension.'
  );
}

export async function anthropicImageSearch (params: {
  query: string;
  num: number;
  assetKind: 'logo' | 'product';
  officialHosts: readonly string[];
}): Promise<ImageSearchRow[]> {
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Missing ANTHROPIC_API_KEY for Anthropic image search.');
  }

  const model = parseModelFromEnv();
  const maxUses = Math.min(8, Math.max(2, Math.ceil(params.num / 2)));
  const client = new Anthropic({ apiKey });

  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: maxUses,
    ...(params.officialHosts.length > 0 ? { allowed_domains: [ ...params.officialHosts ] } : {})
  } as unknown as Anthropic.Messages.Tool;

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: buildUserPrompt(params.query, params.num, params.assetKind)
    }
  ];

  console.log(`[Anthropic images] query="${params.query}" model=${model} max_uses=${String(maxUses)}`);

  for (let turn = 0; turn < 6; turn += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      tools: [ webSearchTool ],
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      messages.push({
        role: 'user',
        content:
          'Continue searching if needed, then respond with the structured JSON list of direct image URLs only.'
      });
      continue;
    }

    const parseResponse = await client.messages.parse({
      model,
      max_tokens: 2048,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            `Output the final structured JSON with up to ${String(params.num)} direct image URLs from your search. No HTML page URLs.`
        }
      ],
      output_config: {
        format: zodOutputFormat(anthropicImageSearchSchema)
      }
    });

    const parsed = parseResponse.parsed_output;
    if (parsed === null || parsed.results.length === 0) {
      console.warn(`[Anthropic images] No structured URLs for "${params.query}"`);
      return [];
    }

    const rows: ImageSearchRow[] = [];
    for (const item of parsed.results) {
      if (!looksLikeDirectImageUrl(item.url)) {
        continue;
      }
      rows.push({
        url: item.url,
        title: item.title ?? '',
        source: item.source ?? 'anthropic-web-search',
        properties: { url: item.url, placeholder: '' }
      });
      if (rows.length >= params.num) {
        break;
      }
    }

    console.log(`[Anthropic images] ${String(rows.length)} URL(s) for "${params.query}"`);
    return rows;
  }

  console.warn(`[Anthropic images] Exceeded turns for "${params.query}"`);
  return [];
}

// ===== image-search.mts =====
export function resolveImageSearchProvider (override?: string): ImageSearchProviderId {
  const raw = (override ?? process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'] ?? 'brave').trim().toLowerCase();
  if (raw === 'brave' || raw === 'anthropic') {
    return raw;
  }
  throw new Error(
    `Invalid CREATIVE_IMAGE_SEARCH_PROVIDER "${raw}". Allowed values: brave, anthropic.`
  );
}

export function imageSearchLogPrefix (provider?: ImageSearchProviderId): string {
  const p = provider ?? resolveImageSearchProvider();
  return p === 'brave' ? '[Brave images]' : '[Anthropic images]';
}

export function assertImageSearchProviderConfigured (provider?: ImageSearchProviderId): void {
  const p = provider ?? resolveImageSearchProvider();
  const anthropicKey = process.env['ANTHROPIC_API_KEY']?.trim();
  if (anthropicKey === undefined || anthropicKey.length === 0) {
    throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
  }
  if (p === 'brave') {
    const braveKey = process.env['BRAVE_API_KEY']?.trim();
    if (braveKey === undefined || braveKey.length === 0) {
      throw new Error(
        'Missing BRAVE_API_KEY for Brave image search. Set CREATIVE_IMAGE_SEARCH_PROVIDER=anthropic to use Claude web_search instead.'
      );
    }
  }
}

export async function imageSearch (params: {
  query: string;
  num?: number;
  assetKind?: 'logo' | 'product';
  officialHosts?: readonly string[];
  provider?: ImageSearchProviderId;
}): Promise<ImageSearchRow[]> {
  const provider = params.provider ?? resolveImageSearchProvider();
  const num = params.num ?? 10;

  if (provider === 'brave') {
    const rows = await braveImageSearch({ query: params.query, num });
    return rows.map((row) => ({
      url: row.url,
      title: row.title ?? '',
      source: row.source ?? '',
      page_fetched: row.page_fetched,
      thumbnail: row.thumbnail,
      properties: row.properties
    }));
  }

  return anthropicImageSearch({
    query: params.query,
    num,
    assetKind: params.assetKind ?? 'product',
    officialHosts: params.officialHosts ?? []
  });
}

// ===== image-mime-sniff.mts =====
export type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export function isSvgAssetFile (fileName: string, buf?: Buffer): boolean {
  if (fileName.toLowerCase().endsWith('.svg')) {
    return true;
  }
  if (buf !== undefined && buf.length > 0) {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trim();
    return head.includes('<svg');
  }
  return false;
}

/** Detect raster MIME from magic bytes (not file extension). */
export function sniffImageMimeFromBuffer (buf: Buffer): AnthropicImageMediaType | null {
  if (buf.length < 3) {
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function readFileAsAnthropicImageBlock (absolutePath: string): Anthropic.ImageBlockParam | null {
  const buf = readFileSync(absolutePath);
  const mediaType = sniffImageMimeFromBuffer(buf);
  if (mediaType === null) {
    return null;
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: buf.toString('base64')
    }
  };
}

// ===== asset-sidecar-files.mts =====
/** Legacy sidecar names that may still exist under logos/ or products/ from older runs. */
export const LEGACY_LOGO_LOCK_FILE_NAME = 'logo-approved.json';
export const LEGACY_PRODUCT_SOURCES_FILE_NAME = 'asset-sources.json';

const ASSET_SIDECAR_FILE_NAMES = new Set([
  LEGACY_LOGO_LOCK_FILE_NAME,
  LEGACY_PRODUCT_SOURCES_FILE_NAME
]);

export function isAssetSidecarFileName (fileName: string): boolean {
  return ASSET_SIDECAR_FILE_NAMES.has(fileName);
}

/** True when the file name looks like a raster/vector image asset (not JSON sidecars). */
export function isAssetImageFileName (fileName: string): boolean {
  if (fileName.startsWith('.') || isAssetSidecarFileName(fileName)) {
    return false;
  }
  return /\.(svg|jpe?g|png|webp|gif|avif)$/iu.test(fileName);
}

export function filterAssetImageFileNames (fileNames: readonly string[]): string[] {
  return fileNames.filter((name) => isAssetImageFileName(name));
}

export function listAssetImageFiles (
  directoryPath: string,
  fileType: 'logos' | 'products'
): string[] {
  const subdirectoryPath = join(directoryPath, fileType);
  if (!existsSync(subdirectoryPath)) {
    return [];
  }
  return filterAssetImageFileNames(readdirSync(subdirectoryPath));
}

// ===== asset-host-fail-fast.mts =====
export function hostnameFromAssetUrl (url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** After `threshold` download failures on a hostname, skip further URLs on that host. */
export class AssetHostFailureTracker {
  private readonly failures = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly threshold: number;

  constructor (threshold: number = 2) {
    this.threshold = threshold;
  }

  isBlocked (url: string): boolean {
    const host = hostnameFromAssetUrl(url);
    return host !== null && this.blocked.has(host);
  }

  /** Returns true when the host just became blocked. */
  recordFailure (url: string): boolean {
    const host = hostnameFromAssetUrl(url);
    if (host === null) {
      return false;
    }
    const next = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, next);
    if (next >= this.threshold && !this.blocked.has(host)) {
      this.blocked.add(host);
      return true;
    }
    return false;
  }

  blockedHostForLog (): string | null {
    const first = this.blocked.values().next().value;
    return first ?? null;
  }
}

// ===== official-fetch.mts =====
export const OFFICIAL_SCRAPE_USER_AGENT =
  'Mozilla/5.0 (compatible; AframeCreativeAssetBot/1.0; +https://github.com/)';

export function officialPageFetchHeaders (): Record<string, string> {
  return {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': OFFICIAL_SCRAPE_USER_AGENT
  };
}

export function officialImageFetchHeaders (): Record<string, string> {
  return {
    Accept: 'image/*,*/*;q=0.8',
    'User-Agent': OFFICIAL_SCRAPE_USER_AGENT
  };
}

/** HEAD statuses where many CDNs still allow a small GET for content-type. */
export function shouldRetryImageMetadataWithGet (status: number): boolean {
  return status === 401 || status === 403 || status === 405;
}

// ===== creative-pipeline-usage.mts =====
export type PipelineAction =
  | 'style_guide'
  | 'assets_review'
  | 'assets_refresh'
  | 'asset_descriptions'
  | 'logo_vision_audit'
  | 'creative_generation'
  | 'creative_regeneration'
  | 'screenshots'
  | 'ui_review';

export type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export type UsageAccumulator = {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type PriceUsd = {
  input: number;
  output: number;
  total: number;
};

export type ApiCallTiming = {
  call_index: number;
  duration_ms: number;
  stop_reason?: string | null;
  label?: string;
};

export type PipelinePhase = 'style_guide' | 'creative';

export type PhaseDurationMs = {
  style_guide: number;
  creative: number;
};

export type SubStepTiming = {
  label: string;
  duration_ms: number;
};

export type PipelineUsageEntry = {
  action: PipelineAction;
  agent: string;
  model: string | null;
  timestamp: string;
  review_round: number | null;
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  billed_input_tokens: number;
  price_usd: PriceUsd;
  notes?: string;
  /** Studio job phase when the entry was recorded. */
  phase?: PipelinePhase;
  /** Wall-clock for the whole step (script), including non-API work. */
  duration_ms?: number;
  /** One row per Claude API response in this step. */
  api_call_timings?: ApiCallTiming[];
  /** Non-API sub-steps within a single ledger entry (e.g. asset downloads). */
  sub_step_timings?: SubStepTiming[];
};

export type PipelineUsageTotals = {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  billed_input_tokens: number;
  price_usd: PriceUsd;
  duration_ms: number;
  claude_api_duration_ms: number;
  wall_clock_ms: number;
  phase_duration_ms: PhaseDurationMs;
};

export type PipelineRunSummary = {
  wall_clock_ms: number;
  ended_at: string;
  claude_api_calls: number;
  claude_api_duration_ms: number;
  phase_duration_ms?: PhaseDurationMs;
  studio_job_id?: string;
};

export type PipelineUsageFile = {
  directoryUuid: string;
  updated_at: string;
  entries: PipelineUsageEntry[];
  totals: PipelineUsageTotals;
  run_summary?: PipelineRunSummary;
};

/** Human-readable duration as `m:ss` (e.g. `6:51`, `0:37`). */
export function formatDurationMinSec (ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min)}:${sec.toString().padStart(2, '0')}`;
}

export async function timedAnthropicCall<T> (
  _label: string,
  fn: () => Promise<T>
): Promise<{ result: T; duration_ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, duration_ms: Date.now() - start };
}

export async function timedStep<T> (
  _label: string,
  fn: () => Promise<T>
): Promise<{ result: T; duration_ms: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, duration_ms: Date.now() - start };
}

/** `PIPELINE_PHASE` set by style-guide studio jobs (`style_guide` | `creative`). */
export function resolvePipelinePhaseFromEnv (): PipelinePhase | undefined {
  const raw = process.env['PIPELINE_PHASE']?.trim();
  if (raw === 'style_guide' || raw === 'creative') {
    return raw;
  }
  return undefined;
}

export function inferPhaseFromEntry (entry: PipelineUsageEntry): PipelinePhase {
  if (entry.phase !== undefined) {
    return entry.phase;
  }
  if (entry.action === 'style_guide') {
    return 'style_guide';
  }
  return 'creative';
}

export function recomputePhaseTotals (entries: readonly PipelineUsageEntry[]): PhaseDurationMs {
  const totals: PhaseDurationMs = { style_guide: 0, creative: 0 };
  for (const e of entries) {
    const phase = inferPhaseFromEntry(e);
    totals[phase] += e.duration_ms ?? 0;
  }
  return totals;
}

export function logPhaseTotalsToConsole (phaseTotals: PhaseDurationMs): void {
  console.log(`=== phase style guide : ${formatDurationMinSec(phaseTotals.style_guide)} ===`);
  console.log(`=== phase format de pub : ${formatDurationMinSec(phaseTotals.creative)} ===`);
  console.log('');
}

function mergePhaseFields (
  params: { phase?: PipelinePhase; sub_step_timings?: SubStepTiming[] }
): Pick<PipelineUsageEntry, 'phase' | 'sub_step_timings'> {
  const phase = params.phase ?? resolvePipelinePhaseFromEnv();
  return {
    ...(phase !== undefined ? { phase } : {}),
    ...(params.sub_step_timings !== undefined && params.sub_step_timings.length > 0
      ? { sub_step_timings: params.sub_step_timings }
      : {})
  };
}

export function sumApiCallDurationMs (timings: readonly ApiCallTiming[] | undefined): number {
  if (timings === undefined || timings.length === 0) {
    return 0;
  }
  return timings.reduce((sum, t) => sum + t.duration_ms, 0);
}

export function codegenTurnTimingsToApiCallTimings (
  turns: ReadonlyArray<{
    turn: number;
    duration_ms: number;
    stop_reason: string | null;
    format_label?: string;
  }>
): ApiCallTiming[] {
  return turns.map((t) => ({
    call_index: t.turn,
    duration_ms: t.duration_ms,
    stop_reason: t.stop_reason,
    label:
      t.format_label !== undefined && t.format_label.length > 0
        ? `codegen ${t.format_label} turn ${String(t.turn)}`
        : `codegen turn ${String(t.turn)}`
  }));
}

function wallClockMsFromEntryTimestamps (entries: readonly PipelineUsageEntry[]): number {
  if (entries.length === 0) {
    return 0;
  }
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = 0;
  for (const e of entries) {
    const ms = Date.parse(e.timestamp);
    if (!Number.isFinite(ms)) {
      continue;
    }
    minMs = Math.min(minMs, ms);
    maxMs = Math.max(maxMs, ms);
  }
  if (!Number.isFinite(minMs) || maxMs <= minMs) {
    return 0;
  }
  return maxMs - minMs;
}

const DEFAULT_OPUS_INPUT_USD_PER_M = 5;
const DEFAULT_OPUS_OUTPUT_USD_PER_M = 25;
const DEFAULT_SONNET_INPUT_USD_PER_M = 3;
const DEFAULT_SONNET_OUTPUT_USD_PER_M = 15;
const DEFAULT_HAIKU_INPUT_USD_PER_M = 1;
const DEFAULT_HAIKU_OUTPUT_USD_PER_M = 5;

function parseEnvUsdPerM (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function getModelPricing (model: string | null): { inputUsdPerM: number; outputUsdPerM: number } {
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) {
    return {
      inputUsdPerM: parseEnvUsdPerM('CREATIVE_HAIKU_INPUT_USD_PER_M', DEFAULT_HAIKU_INPUT_USD_PER_M),
      outputUsdPerM: parseEnvUsdPerM('CREATIVE_HAIKU_OUTPUT_USD_PER_M', DEFAULT_HAIKU_OUTPUT_USD_PER_M)
    };
  }
  if (m.includes('sonnet')) {
    return {
      inputUsdPerM: parseEnvUsdPerM('CREATIVE_SONNET_INPUT_USD_PER_M', DEFAULT_SONNET_INPUT_USD_PER_M),
      outputUsdPerM: parseEnvUsdPerM('CREATIVE_SONNET_OUTPUT_USD_PER_M', DEFAULT_SONNET_OUTPUT_USD_PER_M)
    };
  }
  return {
    inputUsdPerM: parseEnvUsdPerM('CREATIVE_OPUS_INPUT_USD_PER_M', DEFAULT_OPUS_INPUT_USD_PER_M),
    outputUsdPerM: parseEnvUsdPerM('CREATIVE_OPUS_OUTPUT_USD_PER_M', DEFAULT_OPUS_OUTPUT_USD_PER_M)
  };
}

export function createEmptyUsageAccumulator (): UsageAccumulator {
  return {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

export function addUsageToAccumulator (
  acc: UsageAccumulator,
  usage: UsageLike | null | undefined
): void {
  if (usage === null || usage === undefined) {
    return;
  }
  acc.api_calls += 1;
  acc.input_tokens += usage.input_tokens;
  acc.output_tokens += usage.output_tokens;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

export function mergeUsageAccumulators (into: UsageAccumulator, from: UsageAccumulator): void {
  into.api_calls += from.api_calls;
  into.input_tokens += from.input_tokens;
  into.output_tokens += from.output_tokens;
  into.cache_creation_input_tokens += from.cache_creation_input_tokens;
  into.cache_read_input_tokens += from.cache_read_input_tokens;
}

export function billedInputTokensFromAccumulator (acc: UsageAccumulator): number {
  return acc.input_tokens + acc.cache_creation_input_tokens + acc.cache_read_input_tokens;
}

export function billedInputFromUsage (usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

export function priceUsdFromTokens (
  billedInput: number,
  outputTokens: number,
  model: string | null
): PriceUsd {
  const { inputUsdPerM, outputUsdPerM } = getModelPricing(model);
  const input = (billedInput / 1_000_000) * inputUsdPerM;
  const output = (outputTokens / 1_000_000) * outputUsdPerM;
  return {
    input: roundUsd6(input),
    output: roundUsd6(output),
    total: roundUsd6(input + output)
  };
}

export function priceUsdFromAccumulator (acc: UsageAccumulator, model: string | null): PriceUsd {
  return priceUsdFromTokens(billedInputTokensFromAccumulator(acc), acc.output_tokens, model);
}

function roundUsd6 (n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function pipelineUsagePath (directoryPath: string): string {
  return join(directoryPath, 'pipeline-usage.json');
}

function normalizePipelineUsageFile (raw: PipelineUsageFile): PipelineUsageFile {
  return {
    ...raw,
    totals: recomputeTotals(raw.entries)
  };
}

export function recomputeTotals (entries: readonly PipelineUsageEntry[]): PipelineUsageTotals {
  const totals: PipelineUsageTotals = {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    billed_input_tokens: 0,
    price_usd: { input: 0, output: 0, total: 0 },
    duration_ms: 0,
    claude_api_duration_ms: 0,
    wall_clock_ms: 0,
    phase_duration_ms: { style_guide: 0, creative: 0 }
  };
  for (const e of entries) {
    totals.api_calls += e.api_calls;
    totals.input_tokens += e.input_tokens;
    totals.output_tokens += e.output_tokens;
    totals.cache_creation_input_tokens += e.cache_creation_input_tokens;
    totals.cache_read_input_tokens += e.cache_read_input_tokens;
    totals.billed_input_tokens += e.billed_input_tokens;
    totals.price_usd.input += e.price_usd.input;
    totals.price_usd.output += e.price_usd.output;
    totals.price_usd.total += e.price_usd.total;
    totals.duration_ms += e.duration_ms ?? 0;
    totals.claude_api_duration_ms += sumApiCallDurationMs(e.api_call_timings);
  }
  totals.price_usd.input = roundUsd6(totals.price_usd.input);
  totals.price_usd.output = roundUsd6(totals.price_usd.output);
  totals.price_usd.total = roundUsd6(totals.price_usd.total);
  totals.wall_clock_ms = wallClockMsFromEntryTimestamps(entries);
  totals.phase_duration_ms = recomputePhaseTotals(entries);
  return totals;
}

export function countClaudeApiCalls (entries: readonly PipelineUsageEntry[]): number {
  let n = 0;
  for (const e of entries) {
    if (e.api_call_timings !== undefined && e.api_call_timings.length > 0) {
      n += e.api_call_timings.length;
    } else {
      n += e.api_calls;
    }
  }
  return n;
}

export function appendPipelineUsage (
  directoryPath: string,
  entry: Omit<PipelineUsageEntry, 'timestamp'> & { timestamp?: string }
): PipelineUsageFile {
  const directoryUuid = directoryPath.split(/[/\\]/).pop() ?? directoryPath;
  const path = pipelineUsagePath(directoryPath);
  let file: PipelineUsageFile;
  if (existsSync(path)) {
    file = normalizePipelineUsageFile(JSON.parse(readFileSync(path, 'utf8')) as PipelineUsageFile);
  } else {
    file = {
      directoryUuid,
      updated_at: new Date().toISOString(),
      entries: [],
      totals: recomputeTotals([])
    };
  }
  const fullEntry: PipelineUsageEntry = {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString()
  };
  file.entries.push(fullEntry);
  file.directoryUuid = directoryUuid;
  file.updated_at = new Date().toISOString();
  file.totals = recomputeTotals(file.entries);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' });
  return file;
}

export function entryFromAccumulator (
  params: {
    action: PipelineAction;
    agent: string;
    model: string | null;
    acc: UsageAccumulator;
    review_round?: number | null;
    notes?: string;
    phase?: PipelinePhase;
    duration_ms?: number;
    api_call_timings?: ApiCallTiming[];
    sub_step_timings?: SubStepTiming[];
  }
): Omit<PipelineUsageEntry, 'timestamp'> {
  const billed = billedInputTokensFromAccumulator(params.acc);
  return {
    action: params.action,
    agent: params.agent,
    model: params.model,
    review_round: params.review_round ?? null,
    api_calls: params.acc.api_calls,
    input_tokens: params.acc.input_tokens,
    output_tokens: params.acc.output_tokens,
    cache_creation_input_tokens: params.acc.cache_creation_input_tokens,
    cache_read_input_tokens: params.acc.cache_read_input_tokens,
    billed_input_tokens: billed,
    price_usd: priceUsdFromAccumulator(params.acc, params.model),
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
    ...(params.duration_ms !== undefined ? { duration_ms: params.duration_ms } : {}),
    ...(params.api_call_timings !== undefined && params.api_call_timings.length > 0
      ? { api_call_timings: params.api_call_timings }
      : {}),
    ...mergePhaseFields(params)
  };
}

export function entryFromSingleUsage (
  params: {
    action: PipelineAction;
    agent: string;
    model: string | null;
    usage: UsageLike;
    review_round?: number | null;
    notes?: string;
    phase?: PipelinePhase;
    duration_ms?: number;
    api_call_timings?: ApiCallTiming[];
    sub_step_timings?: SubStepTiming[];
  }
): Omit<PipelineUsageEntry, 'timestamp'> {
  const billed = billedInputFromUsage(params.usage);
  return {
    action: params.action,
    agent: params.agent,
    model: params.model,
    review_round: params.review_round ?? null,
    api_calls: 1,
    input_tokens: params.usage.input_tokens,
    output_tokens: params.usage.output_tokens,
    cache_creation_input_tokens: params.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: params.usage.cache_read_input_tokens ?? 0,
    billed_input_tokens: billed,
    price_usd: priceUsdFromTokens(billed, params.usage.output_tokens, params.model),
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
    ...(params.duration_ms !== undefined ? { duration_ms: params.duration_ms } : {}),
    ...(params.api_call_timings !== undefined && params.api_call_timings.length > 0
      ? { api_call_timings: params.api_call_timings }
      : {}),
    ...mergePhaseFields(params)
  };
}

export function entryZeroCost (
  params: {
    action: PipelineAction;
    agent: string;
    review_round?: number | null;
    notes?: string;
    phase?: PipelinePhase;
    duration_ms?: number;
    sub_step_timings?: SubStepTiming[];
  }
): Omit<PipelineUsageEntry, 'timestamp'> {
  return {
    action: params.action,
    agent: params.agent,
    model: null,
    review_round: params.review_round ?? null,
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    billed_input_tokens: 0,
    price_usd: { input: 0, output: 0, total: 0 },
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
    ...(params.duration_ms !== undefined ? { duration_ms: params.duration_ms } : {}),
    ...mergePhaseFields(params)
  };
}

export function logPipelineUsageToConsole (entry: PipelineUsageEntry): void {
  console.log(`--- pipeline: ${entry.action} (${entry.agent}) ---`);
  if (entry.review_round !== null) {
    console.log(`review round : ${String(entry.review_round)}`);
  }
  if (entry.model !== null) {
    console.log(`model : ${entry.model}`);
  }
  if (entry.duration_ms !== undefined) {
    console.log(`step duration : ${formatDurationMinSec(entry.duration_ms)}`);
  }
  if (entry.sub_step_timings !== undefined && entry.sub_step_timings.length > 0) {
    for (const s of entry.sub_step_timings) {
      console.log(`  sub-step : ${s.label} — ${formatDurationMinSec(s.duration_ms)}`);
    }
  }
  if (entry.api_call_timings !== undefined && entry.api_call_timings.length > 0) {
    for (const t of entry.api_call_timings) {
      const label = t.label ?? `call ${String(t.call_index)}`;
      const stop = t.stop_reason !== undefined && t.stop_reason !== null ? ` (${t.stop_reason})` : '';
      console.log(`  claude api : ${label} — ${formatDurationMinSec(t.duration_ms)}${stop}`);
    }
    console.log(`  claude api sum : ${formatDurationMinSec(sumApiCallDurationMs(entry.api_call_timings))}`);
  }
  if (entry.phase !== undefined) {
    console.log(`phase : ${entry.phase}`);
  }
  if (entry.notes !== undefined && entry.notes.length > 0) {
    console.log(`notes : ${entry.notes}`);
  }
  console.log(`api calls : ${String(entry.api_calls)}`);
  console.log(`input token (billed) : ${String(entry.billed_input_tokens)}`);
  console.log(`output token : ${String(entry.output_tokens)}`);
  console.log(`input price (USD) : ${String(entry.price_usd.input)}`);
  console.log(`output price (USD) : ${String(entry.price_usd.output)}`);
  console.log(`total price (USD) : ${String(entry.price_usd.total)}`);
  console.log('');
}

export function logPipelineTotalsToConsole (directoryPath: string): void {
  const path = pipelineUsagePath(directoryPath);
  if (!existsSync(path)) {
    return;
  }
  const file = normalizePipelineUsageFile(JSON.parse(readFileSync(path, 'utf8')) as PipelineUsageFile);
  console.log('=== pipeline usage totals ===');
  console.log(`entries : ${String(file.entries.length)}`);
  console.log(`step duration sum : ${formatDurationMinSec(file.totals.duration_ms)}`);
  console.log(`claude api duration sum : ${formatDurationMinSec(file.totals.claude_api_duration_ms)}`);
  if (file.totals.wall_clock_ms > 0) {
    console.log(`wall clock (entry timestamps) : ${formatDurationMinSec(file.totals.wall_clock_ms)}`);
  }
  if (file.run_summary !== undefined) {
    console.log(`run wall clock : ${formatDurationMinSec(file.run_summary.wall_clock_ms)}`);
    console.log(`run claude api calls : ${String(file.run_summary.claude_api_calls)}`);
  }
  if (file.totals.phase_duration_ms.style_guide > 0 || file.totals.phase_duration_ms.creative > 0) {
    logPhaseTotalsToConsole(file.totals.phase_duration_ms);
  }
  console.log(`billed input tokens : ${String(file.totals.billed_input_tokens)}`);
  console.log(`output tokens : ${String(file.totals.output_tokens)}`);
  console.log(`total price (USD) : ${String(file.totals.price_usd.total)}`);
  console.log('');
}

export function appendPipelineRunSummary (
  directoryPath: string,
  params: { wall_clock_ms: number; studio_job_id?: string }
): PipelineUsageFile | null {
  const path = pipelineUsagePath(directoryPath);
  if (!existsSync(path)) {
    return null;
  }
  const file = normalizePipelineUsageFile(JSON.parse(readFileSync(path, 'utf8')) as PipelineUsageFile);
  file.run_summary = {
    wall_clock_ms: params.wall_clock_ms,
    ended_at: new Date().toISOString(),
    claude_api_calls: countClaudeApiCalls(file.entries),
    claude_api_duration_ms: file.totals.claude_api_duration_ms,
    phase_duration_ms: file.totals.phase_duration_ms,
    ...(params.studio_job_id !== undefined ? { studio_job_id: params.studio_job_id } : {})
  };
  file.updated_at = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8' });
  return file;
}

export function logAnthropicUsageAndCost (scriptLabel: string, acc: UsageAccumulator, model: string): void {
  const p = priceUsdFromAccumulator(acc, model);
  const pricing = getModelPricing(model);
  console.log(`--- ${scriptLabel} (cumulative) ---`);
  console.log(
    `call reason : ${String(acc.api_calls)} réponse(s) API — ${model} ($${String(pricing.inputUsdPerM)}/M input, $${String(pricing.outputUsdPerM)}/M output, cache inclus côté input)`
  );
  console.log(`input token : ${String(billedInputTokensFromAccumulator(acc))}`);
  console.log(`output token : ${String(acc.output_tokens)}`);
  console.log(`input price (USD) : ${String(p.input)}`);
  console.log(`output price (USD) : ${String(p.output)}`);
  console.log(`total price (USD) : ${String(p.total)}`);
  console.log('');
}

export function logReadableAnthropicCall (
  callReason: string,
  usage: UsageLike | null | undefined,
  durationMs?: number
): void {
  console.log(`call reason : ${callReason}`);
  if (durationMs !== undefined) {
    console.log(`duration : ${formatDurationMinSec(durationMs)}`);
  }
  if (usage === null || usage === undefined) {
    console.log('input token : —');
    console.log('output token : —');
    console.log('');
    return;
  }
  console.log(`input token : ${String(billedInputFromUsage(usage))}`);
  console.log(`output token : ${String(usage.output_tokens)}`);
  console.log('');
}

// ===== studio-ad-formats.mts =====
export interface ArcheSpec {
  headerPx: number;
  gutterPx: number;
  mainFocusWidthPx: number;
  maxTotalWeightKB: number;
  allowedRasterMime: readonly string[];
  trackingNote: string;
  companionPresetIds: readonly string[];
}

export interface AdFormatPreset {
  id: string;
  width: number;
  height: number;
  label: string;
  arche?: ArcheSpec;
}

export interface AdFormatSelection {
  id: string;
  width: number;
  height: number;
  arche?: ArcheSpec;
}

const MIN_DIM = 16;
const MAX_DIM = 4096;
const MAX_FORMATS = 8;

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseArcheSpec (value: unknown): ArcheSpec | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error('Preset "arche" must be an object when present.');
  }
  const o = value;
  const headerPx = typeof o['headerPx'] === 'number' && Number.isInteger(o['headerPx']) ? o['headerPx'] : null;
  const gutterPx = typeof o['gutterPx'] === 'number' && Number.isInteger(o['gutterPx']) ? o['gutterPx'] : null;
  const mainFocusWidthPx =
    typeof o['mainFocusWidthPx'] === 'number' && Number.isInteger(o['mainFocusWidthPx']) ? o['mainFocusWidthPx'] : null;
  const maxTotalWeightKB =
    typeof o['maxTotalWeightKB'] === 'number' && Number.isInteger(o['maxTotalWeightKB']) ? o['maxTotalWeightKB'] : null;
  const trackingNote = typeof o['trackingNote'] === 'string' ? o['trackingNote'].trim() : '';
  const mimeRaw = o['allowedRasterMime'];
  if (
    headerPx === null ||
    gutterPx === null ||
    mainFocusWidthPx === null ||
    maxTotalWeightKB === null ||
    trackingNote.length === 0 ||
    !Array.isArray(mimeRaw)
  ) {
    throw new Error('Invalid "arche" object in ad-formats preset (missing fields).');
  }
  const allowedRasterMime = mimeRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (allowedRasterMime.length === 0) {
    throw new Error('Invalid "arche.allowedRasterMime" in ad-formats preset.');
  }
  const compRaw = o['companionPresetIds'];
  if (!Array.isArray(compRaw)) {
    throw new Error('Invalid "arche.companionPresetIds" in ad-formats preset.');
  }
  const companionPresetIds = compRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return {
    headerPx,
    gutterPx,
    mainFocusWidthPx,
    maxTotalWeightKB,
    allowedRasterMime,
    trackingNote,
    companionPresetIds
  };
}

export function loadAdFormatPresets (repoRoot: string): AdFormatPreset[] {
  const path = join(repoRoot, 'shared', 'ad-formats.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { presets?: unknown };
  if (!Array.isArray(raw.presets)) {
    throw new Error(`Invalid shared/ad-formats.json: missing presets array (${path}).`);
  }
  const out: AdFormatPreset[] = [];
  for (const row of raw.presets) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
    const width = typeof o['width'] === 'number' ? o['width'] : Number.NaN;
    const height = typeof o['height'] === 'number' ? o['height'] : Number.NaN;
    const label = typeof o['label'] === 'string' ? o['label'].trim() : '';
    if (
      id.length === 0 ||
      label.length === 0 ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < MIN_DIM ||
      width > MAX_DIM ||
      height < MIN_DIM ||
      height > MAX_DIM
    ) {
      continue;
    }
    const arche = o['arche'] === undefined ? undefined : parseArcheSpec(o['arche']);
    out.push({ id, width, height, label, ...(arche !== undefined ? { arche } : {}) });
  }
  if (out.length === 0) {
    throw new Error(`No valid presets in shared/ad-formats.json (${path}).`);
  }
  return out;
}

function coerceDimension (v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return v;
  }
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

function selectionFromPreset (preset: AdFormatPreset): AdFormatSelection {
  return {
    id: preset.id,
    width: preset.width,
    height: preset.height,
    ...(preset.arche !== undefined ? { arche: preset.arche } : {})
  };
}

/** Normalize client JSON: array of { id, width, height } or partial + preset lookup. Arche metadata is taken only from server presets (never from client). */
export function normalizeApiAdFormats (
  raw: unknown,
  presets: readonly AdFormatPreset[]
): { ok: true; formats: AdFormatSelection[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: false, error: 'Missing adFormats (array of { id, width, height }).' };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'adFormats must be a JSON array.' };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'adFormats must contain at least one format.' };
  }
  if (raw.length > MAX_FORMATS) {
    return { ok: false, error: `adFormats must contain at most ${String(MAX_FORMATS)} formats.` };
  }

  const presetById = new Map(presets.map((p) => [ p.id, p ]));
  const seen = new Set<string>();
  const formats: AdFormatSelection[] = [];

  for (const item of raw) {
    if (!isPlainObject(item)) {
      return { ok: false, error: 'Each adFormats entry must be an object.' };
    }
    const idRaw = typeof item['id'] === 'string' ? item['id'].trim() : '';
    let width = coerceDimension(item['width'] ?? item['w']);
    let height = coerceDimension(item['height'] ?? item['h']);
    let id = idRaw;

    if ((width === null || height === null) && idRaw.length > 0) {
      const preset = presetById.get(idRaw);
      if (preset === undefined) {
        return { ok: false, error: `Unknown preset id "${idRaw}".` };
      }
      width = preset.width;
      height = preset.height;
      id = preset.id;
    }

    if (width === null || height === null) {
      return { ok: false, error: 'Each format needs width and height (integers), or a known preset id.' };
    }
    if (width < MIN_DIM || width > MAX_DIM || height < MIN_DIM || height > MAX_DIM) {
      return {
        ok: false,
        error: `Dimensions out of range (${String(MIN_DIM)}–${String(MAX_DIM)} px): ${String(width)}×${String(height)}.`
      };
    }
    const key = `${width}x${height}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const finalId = id.length > 0 ? id : key;
    let presetMatch = presetById.get(finalId);
    if (presetMatch === undefined) {
      const byDims = presets.filter((p) => p.width === width && p.height === height);
      if (byDims.length === 1) {
        presetMatch = byDims[0];
      }
    }
    if (
      presetMatch !== undefined &&
      (presetMatch.width !== width || presetMatch.height !== height)
    ) {
      return {
        ok: false,
        error: `Dimensions mismatch for preset "${finalId}" (expected ${String(presetMatch.width)}×${String(presetMatch.height)}).`
      };
    }
    formats.push(
      presetMatch !== undefined
        ? selectionFromPreset(presetMatch)
        : { id: finalId, width, height }
    );
  }

  if (formats.length === 0) {
    return { ok: false, error: 'adFormats resolved to empty list (duplicates?).' };
  }
  return { ok: true, formats };
}

export function parseCreativeAdFormatsFromEnv (
  envValue: string | undefined,
  presets: readonly AdFormatPreset[]
): AdFormatSelection[] {
  const trimmed = envValue?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    const first = presets[0];
    if (first === undefined) {
      throw new Error('No presets loaded; cannot default ad formats.');
    }
    return [ selectionFromPreset(first) ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('CREATIVE_AD_FORMATS must be valid JSON.');
  }
  const normalized = normalizeApiAdFormats(parsed, presets);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  return normalized.formats;
}

/** Instruction block for LLM prompts (creative-native generator / verifier). */
export function buildCreativeAdFormatInstructions (formats: readonly AdFormatSelection[]): string {
  const hasArche = formats.some((f) => f.arche !== undefined);
  const lines = formats.map((f) => `      - ${f.id}: ${String(f.width)}×${String(f.height)} px`);
  const list = lines.join('\n');
  const first = formats[0];

  if (formats.length === 1 && first !== undefined && first.arche !== undefined) {
    const f = first;
    const a = first.arche;
    const innerW = f.width - 2 * a.gutterPx;
    const innerH = f.height - a.headerPx;
    const selectedIds = new Set(formats.map((fmt) => fmt.id));
    const selectedCompanions = a.companionPresetIds.filter((id) => selectedIds.has(id));
    const companionNote =
      selectedCompanions.length > 0
        ? (
          `      - **Compagnons demandés** avec cet habillage : **${selectedCompanions.join(', ')}** — les produire comme unités distinctes sous ou à côté de l'arche sur la même page de preview.\n`
        )
        : (
          '      - **Ne pas générer de compagnons** (pavés '
          + `${a.companionPresetIds.join(', ')}, etc.) : cette livraison ne contient **que** l\'habillage Arche **${f.id}**. `
          + 'Aucun bloc banner séparé (300×250, 300×600, …) sur la page.\n'
        );
    return (
      `      Format **ARCHE / habillage** (cadre livré exactement ${String(f.width)}×${String(f.height)} px) :\n` +
      `      - Enveloppe en « U » : bandeau **header** public **${String(a.headerPx)} px** de haut sur toute la largeur ${String(f.width)} px ; **gouttières** gauche et droite **${String(a.gutterPx)} px** de large chacune sur la hauteur sous le header (**${String(innerH)} px**).\n` +
      `      - **Zone centrale « contenu site »** (trou, non pub) : **${String(innerW)}×${String(innerH)} px** — fond neutre en démo ; aucun élément publicitaire dans ce rectangle.\n` +
      `      - **Hiérarchie créative** : concentrer logo, accroche, produit et CTA pour qu’ils se lisent en priorité sur une largeur **cible ~${String(a.mainFocusWidthPx)} px** centrée sur l’ensemble (tout en respectant les emprises header/gouttières en pixels ci-dessus).\n` +
      `      - **Poids** : viser **≤ ${String(a.maxTotalWeightKB)} Ko** pour l’ensemble des images raster utilisées dans l’habillage (optimisation forte, pas d’assets superflus).\n` +
      `      - **Formats raster** pour bitmaps d’habillage : ${a.allowedRasterMime.join(', ')} uniquement.\n` +
      `      - **Tracking** : ${a.trackingNote}\n` +
      companionNote +
      '      - styles.css + app.js : le bloc racine livré pour l’arche doit faire exactement ' +
      `${String(f.width)}×${String(f.height)} px ; positionner header et gouttières au pixel près ; le centre est le « trou ».\n` +
      `      - index.html : racine id="ad-${f.id.replace(/×/g, 'x')}" ; viewport meta width=device-width ; centrer la démo. **Une seule** unité publicitaire sur la page.\n`
    );
  }

  if (formats.length === 1 && first !== undefined && first.arche === undefined) {
    const domId = `ad-${first.id.replace(/×/g, 'x')}`;
    return (
      `      Required ad frame (exact pixel size of the visible creative):\n${list}\n` +
      `      - The visible ad root MUST use id="${domId}" on the outermost ${String(first.width)}×${String(first.height)} px container (required for capture and QA).\n` +
      `      - styles.css — #${domId} { width: ${String(first.width)}px; height: ${String(first.height)}px; } and center the ad on the page ` +
      `(e.g. body min-height 100vh, flex, align and justify center).\n` +
      `      Creative viewport: exactly ${String(first.width)}×${String(first.height)} px for #${domId}.\n` +
      `      - Safe zone: keep primary CTA and footer text at least 20px inside the bottom edge of #${domId} (padding-bottom or CTA margin).`
    );
  }

  if (hasArche) {
    const selectedIds = new Set(formats.map((f) => f.id));
    const archeBlocks = formats
      .filter((f): f is AdFormatSelection & { arche: NonNullable<AdFormatSelection['arche']> } => f.arche !== undefined)
      .map((f) => {
        const a = f.arche;
        const innerW = f.width - 2 * a.gutterPx;
        const innerH = f.height - a.headerPx;
        const selectedCompanions = a.companionPresetIds.filter((id) => selectedIds.has(id));
        const companionPart =
          selectedCompanions.length > 0
            ? `compagnons demandés : ${selectedCompanions.join(', ')}`
            : 'sans pavés compagnons dans cette livraison';
        return (
          `      * ${f.id} (${String(f.width)}×${String(f.height)} px) — ARCHE : header ${String(a.headerPx)} px, gouttières ${String(a.gutterPx)} px, ` +
          `trou central ${String(innerW)}×${String(innerH)} px, focus créatif ~${String(a.mainFocusWidthPx)} px, ` +
          `poids cible ≤${String(a.maxTotalWeightKB)} Ko, rasters ${a.allowedRasterMime.join('/')}, tracking : ${a.trackingNote} ; ${companionPart}.`
        );
      })
      .join('\n');
    return (
      `      Required ad frames (plusieurs tailles, dont au moins un **habillage Arche**) :\n${list}\n` +
      `${archeBlocks}\n` +
      '      - Chaque format non-Arche : un bloc séparé aux dimensions exactes (wrapper id unique).\n' +
      '      - L’unité Arche : structure U avec header + gouttières + trou central aux dimensions ci-dessus.\n' +
      '      - styles.css — une page avec toutes les unités (arche + pavés) visibles ; pas mélanger les pixels des zones.\n' +
      '      - Reuse logo et produits ; JPEG/PNG uniquement pour rasters d’habillage Arche.'
    );
  }

  return (
    `      Required ad frames (multiple standard sizes — include every size in one page):\n${list}\n` +
    '      - Each format must appear as its own clearly separated ad unit; outer dimensions must match the given width×height in pixels exactly.\n' +
    '      - Give each unit a unique wrapper id (e.g. id="ad-300x250" using the id above).\n' +
    '      - styles.css — lay out all units on one page (vertical stack or wrapping gallery). The page may use full viewport; each ad frame stays exactly WxH px.\n' +
    '      - Reuse logo and product assets across units where appropriate; adapt composition to each aspect ratio.'
  );
}


// ============================================================
// MODULE: style-guide
// ============================================================
// Auto-merged module: style-guide. Sources: style-guide-typography, style-guide-schema, style-guide-colors, style-guide-urls, reference-listing-urls, product-asset-rules, product-asset-sources, style-guide-context.






// ===== style-guide-typography.mts =====
/** Google Fonts CDN substitutes for proprietary / system brand typefaces. */

export type StyleGuideTypographyEntry = {
  fontFamily: string;
  fontWeight?: number;
  fontUses?: string;
};

export type StyleGuideTypography = {
  typography: StyleGuideTypographyEntry[];
};

export type GoogleFontSubstitute = {
  googleFamily: string;
  weights: string;
};

export const CSS_GENERIC_FONT_FALLBACKS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace'
]);

/** Google Fonts families that may appear as-is when listed in the style guide. */
const GOOGLE_FONTS_NATIVE = new Set([
  'inter',
  'roboto',
  'open sans',
  'lato',
  'montserrat',
  'poppins',
  'oswald',
  'raleway',
  'nunito',
  'work sans',
  'source sans 3',
  'barlow',
  'barlow condensed',
  'jost',
  'lora',
  'eb garamond',
  'playfair display',
  'merriweather',
  'pt serif',
  'bebas neue',
  'fredoka',
  'ibm plex mono',
  'roboto mono',
  'press start 2p',
  'bowlby one'
]);

const BRAND_FONT_RULES: ReadonlyArray<{ pattern: RegExp; substitute: GoogleFontSubstitute }> = [
  {
    pattern: /trade\s+gothic|franklin\s+gothic|news\s+gothic|alternate\s+gothic/i,
    substitute: { googleFamily: 'Barlow Condensed', weights: '600;700' }
  },
  {
    pattern: /futura|avant\s+garde|avenir|gotham|neue\s+haas/i,
    substitute: { googleFamily: 'Jost', weights: '600;700;800' }
  },
  {
    pattern: /helvetica|arial|univers|neue\s+helvetica|san\s+francisco|segoe/i,
    substitute: { googleFamily: 'Inter', weights: '400;500;600;700' }
  },
  {
    pattern: /palatino|georgia|times(\s+new\s+roman)?|garamond|baskerville/i,
    substitute: { googleFamily: 'Lora', weights: '400;500;600;700' }
  },
  {
    pattern: /playfair|didot|bodoni|libre\s+baskerville/i,
    substitute: { googleFamily: 'Playfair Display', weights: '400;500;600;700' }
  },
  {
    pattern: /roboto(?!\s+mono)/i,
    substitute: { googleFamily: 'Roboto', weights: '400;500;700' }
  },
  {
    pattern: /montserrat/i,
    substitute: { googleFamily: 'Montserrat', weights: '500;600;700' }
  },
  {
    pattern: /open\s+sans/i,
    substitute: { googleFamily: 'Open Sans', weights: '400;600;700' }
  }
];

export function normalizeFontFamilyName (name: string): string {
  return name.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/gu, ' ').toLowerCase();
}

function encodeGoogleFontFamilyParam (family: string, weights: string): string {
  const encoded = family.trim().replace(/\s+/gu, '+');
  if (weights.trim().length === 0) {
    return `family=${encoded}`;
  }
  return `family=${encoded}:wght@${weights}`;
}

/** Resolve a style-guide or CSS font name to a free Google Font substitute. */
export function resolveGoogleFontSubstitute (brandFontFamily: string): GoogleFontSubstitute {
  const normalized = normalizeFontFamilyName(brandFontFamily);
  if (GOOGLE_FONTS_NATIVE.has(normalized)) {
    const titleCase = brandFontFamily.trim().replace(/\s+/gu, ' ');
    return { googleFamily: titleCase, weights: '400;600;700' };
  }

  for (const rule of BRAND_FONT_RULES) {
    if (rule.pattern.test(brandFontFamily) || rule.pattern.test(normalized)) {
      return rule.substitute;
    }
  }

  if (/serif|palatino|times|georgia|garamond/i.test(normalized)) {
    return { googleFamily: 'Lora', weights: '400;600' };
  }

  return { googleFamily: 'Inter', weights: '400;500;600;700' };
}

export function buildGoogleFontsCss2Url (substitutes: readonly GoogleFontSubstitute[]): string {
  const seen = new Set<string>();
  const params: string[] = [];
  for (const sub of substitutes) {
    const key = `${sub.googleFamily}|${sub.weights}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    params.push(encodeGoogleFontFamilyParam(sub.googleFamily, sub.weights));
  }
  if (params.length === 0) {
    return 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap';
  }
  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}

export function collectTypographySubstitutes (
  styleGuide: StyleGuideTypography
): Array<{ brandFamily: string; substitute: GoogleFontSubstitute }> {
  const seenBrand = new Set<string>();
  const out: Array<{ brandFamily: string; substitute: GoogleFontSubstitute }> = [];
  for (const entry of styleGuide.typography) {
    const brand = entry.fontFamily.trim();
    if (brand.length === 0) {
      continue;
    }
    const key = normalizeFontFamilyName(brand);
    if (seenBrand.has(key)) {
      continue;
    }
    seenBrand.add(key);
    out.push({ brandFamily: brand, substitute: resolveGoogleFontSubstitute(brand) });
  }
  return out;
}

/** All font-family names allowed in generated CSS (brand + Google substitutes + variants). */
export function collectAllowedFontFamilies (styleGuide: StyleGuideTypography): Set<string> {
  const allowed = new Set<string>(CSS_GENERIC_FONT_FALLBACKS);
  for (const { brandFamily, substitute } of collectTypographySubstitutes(styleGuide)) {
    allowed.add(normalizeFontFamilyName(brandFamily));
    allowed.add(normalizeFontFamilyName(substitute.googleFamily));
  }
  return allowed;
}

export function fontIsAllowed (usedFont: string, allowed: Set<string>): boolean {
  const used = normalizeFontFamilyName(usedFont);
  if (allowed.has(used)) {
    return true;
  }
  for (const candidate of allowed) {
    if (candidate.length < 3) {
      continue;
    }
    if (used === candidate || used.startsWith(`${candidate} `) || candidate.startsWith(`${used} `)) {
      return true;
    }
  }
  return false;
}

export function extractFontFamiliesFromCss (content: string): Set<string> {
  const fontFamilyMatches = content.match(/font-family\s*:\s*([^;]+);/gi) ?? [];
  const familySet = new Set<string>();

  for (const declaration of fontFamilyMatches) {
    const declarationMatch = declaration.match(/font-family\s*:\s*([^;]+);/i);
    if (declarationMatch === null) {
      continue;
    }
    const list = declarationMatch[1] ?? '';
    for (const fontName of list.split(',')) {
      const cleaned = normalizeFontFamilyName(fontName);
      if (cleaned.length > 0) {
        familySet.add(cleaned);
      }
    }
  }

  return familySet;
}

/** Parse `family=Inter` / `family=Barlow+Condensed:wght@700` from Google Fonts URLs. */
export function extractFontFamiliesFromGoogleFontsUrls (content: string): Set<string> {
  const families = new Set<string>();
  const urlMatches = content.match(/fonts\.googleapis\.com\/css2\?[^"')\s]+/gi) ?? [];
  for (const url of urlMatches) {
    const familyChunks = url.match(/family=([^&]+)/gi) ?? [];
    for (const chunk of familyChunks) {
      const raw = chunk.replace(/^family=/iu, '');
      const namePart = raw.split(':')[0] ?? raw;
      const decoded = decodeURIComponent(namePart.replace(/\+/gu, ' ')).trim();
      if (decoded.length > 0) {
        families.add(normalizeFontFamilyName(decoded));
      }
    }
  }
  return families;
}

export function collectUsedFontFamilies (content: string): Set<string> {
  return new Set([
    ...extractFontFamiliesFromCss(content),
    ...extractFontFamiliesFromGoogleFontsUrls(content)
  ]);
}

export function filterDisallowedFonts (
  usedFonts: Iterable<string>,
  allowed: Set<string>
): string[] {
  return Array.from(usedFonts).filter((fontName) => !fontIsAllowed(fontName, allowed));
}

export function getFontComplianceIssue (
  content: string,
  styleGuide: StyleGuideTypography
): string | null {
  const allowed = collectAllowedFontFamilies(styleGuide);
  const disallowed = filterDisallowedFonts(collectUsedFontFamilies(content), allowed);
  if (disallowed.length === 0) {
    return null;
  }
  return `Contains font families outside style guide: ${disallowed.join(', ')}`;
}

export function buildStyleGuideFontConstraintText (styleGuide: StyleGuideTypography): string {
  const pairs = collectTypographySubstitutes(styleGuide);
  if (pairs.length === 0) {
    return (
      'Typography: load fonts from https://fonts.googleapis.com (css2). '
      + 'Use font-family names that match the Google Font families in the link — not proprietary system names.'
    );
  }

  const url = buildGoogleFontsCss2Url(pairs.map((p) => p.substitute));
  const lines = pairs.map(({ brandFamily, substitute }) => {
    const gf = substitute.googleFamily;
    return (
      `- Brand "${brandFamily}" → use Google Font "${gf}" only (not "${brandFamily}" or LT Std/Linotype variants in CSS).`
      + `\n  font-family: "${gf}", sans-serif;`
    );
  });

  return (
    'Typography — brand fonts are proprietary; use ONLY these Google Fonts CDN substitutes:\n'
    + `${lines.join('\n')}\n`
    + `Load once in index.html:\n`
    + `  <link rel="preconnect" href="https://fonts.googleapis.com">\n`
    + `  <link rel="stylesheet" href="${url}">\n`
    + 'Do NOT use commercial/system names (Trade Gothic LT Std, Century Gothic, Book Antiqua, Palatino Linotype, etc.) in font-family.'
  );
}

const FONT_COMPLIANCE_ISSUE = /font families outside style guide/iu;

export function buildFontComplianceRetryHint (styleGuide: StyleGuideTypography): string {
  const pairs = collectTypographySubstitutes(styleGuide);
  if (pairs.length === 0) {
    return '';
  }
  const url = buildGoogleFontsCss2Url(pairs.map((p) => p.substitute));
  const mapping = pairs
    .map(({ brandFamily, substitute }) => `"${brandFamily}" → "${substitute.googleFamily}"`)
    .join('; ');
  return (
    ` Allowed fonts via Google Fonts ONLY: ${mapping}. `
    + `Add <link href="${url}"> and use the Google family names in font-family. `
    + 'Remove Trade Gothic LT Std, Century Gothic, Book Antiqua, Palatino Linotype, and other unmapped system names.'
  );
}

export function appendFontComplianceRetryHint (
  issues: readonly string[],
  styleGuide: StyleGuideTypography
): string {
  if (!issues.some((issue) => FONT_COMPLIANCE_ISSUE.test(issue))) {
    return '';
  }
  return buildFontComplianceRetryHint(styleGuide);
}

// ===== style-guide-schema.mts =====
export const FONT_EFFECT_CANONICAL = [ 'bold', 'italic', 'underline', 'strikethrough' ] as const;
export type FontEffect = (typeof FONT_EFFECT_CANONICAL)[number];

const DROP = '__drop__' as const;
type FontEffectOrDrop = FontEffect | typeof DROP;

/** Maps model tokens to canonical effects; unknown / text-transform values are dropped. */
export function normalizeFontEffectToken (raw: unknown): FontEffectOrDrop {
  if (typeof raw !== 'string') {
    return DROP;
  }
  const k = raw.trim().toLowerCase();
  const aliases: Record<string, FontEffectOrDrop> = {
    bold: 'bold',
    b: 'bold',
    strong: 'bold',
    semibold: 'bold',
    italic: 'italic',
    italics: 'italic',
    oblique: 'italic',
    underline: 'underline',
    underlined: 'underline',
    strikethrough: 'strikethrough',
    'line-through': 'strikethrough',
    none: DROP,
    normal: DROP,
    regular: DROP,
    uppercase: DROP,
    lowercase: DROP,
    capitalize: DROP
  };
  return aliases[k] ?? DROP;
}

export function normalizeFontEffectArray (raw: unknown): FontEffect[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: FontEffect[] = [];
  for (const item of raw) {
    const token = normalizeFontEffectToken(item);
    if (token !== DROP) {
      out.push(token);
    }
  }
  return out;
}

/** JSON Schema–compatible (no `.transform()`); sanitizes via preprocess for zodOutputFormat. */
export const fontEffectSchema = z.preprocess(
  (raw) => normalizeFontEffectArray(raw),
  z.array(z.enum(FONT_EFFECT_CANONICAL))
).describe(
  'Font effects only: bold, italic, underline, strikethrough (lowercase). Empty array [] if none. '
  + 'Never put fontWeight, uppercase, capitalize, semibold, or normal here.'
);

export type TypographyRowLike = {
  fontFamily: string;
  fontWeight: number;
  fontEffect: unknown;
  fontUses: string;
};

export function sanitizeStyleGuideTypography<T extends { typography: TypographyRowLike[] }> (
  styleGuide: T
): T {
  return {
    ...styleGuide,
    typography: styleGuide.typography.map((row) => ({
      ...row,
      fontEffect: normalizeFontEffectArray(row.fontEffect)
    }))
  };
}

export function isStructuredOutputParseError (err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /Failed to parse structured output/iu.test(err.message);
}

// ===== style-guide-colors.mts =====
/** Normalize palette entries to `#RRGGBB` for style-guide.json and CSS consumers. */



export function toStyleGuideHex (value: string): string {
  const bare = value.trim().replace(/^#+/u, '').toUpperCase();
  if (/^[0-9A-F]{3}$/u.test(bare)) {
    return `#${bare.split('').map((c) => `${c}${c}`).join('')}`;
  }
  if (/^[0-9A-F]{6}$/u.test(bare)) {
    return `#${bare}`;
  }
  if (/^[0-9A-F]{8}$/u.test(bare)) {
    return `#${bare}`;
  }
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

/** Bare 6-digit uppercase hex (no `#`) for compliance comparison. */
export function normalizeHexColorBare (value: string): string {
  const bare = toStyleGuideHex(value).replace(/^#/u, '').toUpperCase();
  if (bare.length === 3) {
    return bare.split('').map((char) => `${char}${char}`).join('');
  }
  return bare.slice(0, 6);
}

export type StyleGuidePalettes = {
  primaryColorPalette: string[];
  secondaryColorPalette: string[];
};

/** Deduped `#RRGGBB` list from primary + secondary palettes. */
export function collectStyleGuideAllowedHex (styleGuide: StyleGuidePalettes): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hex of [ ...styleGuide.primaryColorPalette, ...styleGuide.secondaryColorPalette ]) {
    const normalized = `#${normalizeHexColorBare(hex)}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function styleGuideAllowedHexBareSet (styleGuide: StyleGuidePalettes): Set<string> {
  return new Set(collectStyleGuideAllowedHex(styleGuide).map((hex) => hex.replace(/^#/u, '')));
}

export function buildStyleGuideColorConstraintText (styleGuide: StyleGuidePalettes): string {
  const allowed = collectStyleGuideAllowedHex(styleGuide);
  return (
    'CSS hex colors — use ONLY these (no other #hex anywhere in styles.css/index.html/app.js):\n'
    + `${allowed.join(', ')}\n`
    + 'For darker/lighter variants: use opacity, rgba() from a palette hex, or mix two palette colors — never invent new hex codes.'
  );
}

const COLOR_COMPLIANCE_ISSUE = /colors outside style guide palettes/iu;

export type StyleGuideCodegenHints = StyleGuidePalettes & StyleGuideTypography;

/** Extra retry hint when compliance failed on off-palette hex colors or fonts. */
export function buildComplianceRetryHint (
  issues: readonly string[],
  styleGuide: StyleGuideCodegenHints
): string {
  let hint = '';
  if (issues.some((issue) => COLOR_COMPLIANCE_ISSUE.test(issue))) {
    const allowed = collectStyleGuideAllowedHex(styleGuide);
    hint += (
      ` Allowed hex colors ONLY: ${allowed.join(', ')}. `
      + 'Replace every non-allowed #hex in styles.css; use rgba() with a palette base for transparency — '
      + 'never invent new hex codes for gradients or shadows.'
    );
  }
  hint += appendFontComplianceRetryHint(issues, styleGuide);
  return hint;
}

// ===== style-guide-urls.mts =====
const URL_CHECK_TIMEOUT_MS = 12_000;

const HTTPS_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/giu;

/** Color/filter path segments models invent (e.g. /Bleu200) — not valid listing pages. */
const SUSPECT_PATH_SEGMENT_RE =
  /^[A-Z][a-z]{2,15}\d{0,3}$/u;

export function extractHttpsUrlsFromText (text: string): string[] {
  const matches = text.match(HTTPS_URL_RE) ?? [];
  const out: string[] = [];
  for (let raw of matches) {
    raw = raw.replace(/[.,;:!?)]+$/u, '');
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        out.push(u.href);
      }
    } catch {
      // skip
    }
  }
  return [ ...new Set(out) ];
}

export async function checkUrlReachable (url: string): Promise<{
  ok: boolean;
  status: number | null;
  timedOut: boolean;
}> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: officialPageFetchHeaders(),
      signal: AbortSignal.timeout(URL_CHECK_TIMEOUT_MS)
    });
    if (res.status === 405 || res.status === 501) {
      const getRes = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: officialPageFetchHeaders(),
        signal: AbortSignal.timeout(URL_CHECK_TIMEOUT_MS)
      });
      return { ok: getRes.ok, status: getRes.status, timedOut: false };
    }
    return { ok: res.ok, status: res.status, timedOut: false };
  } catch (err: unknown) {
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout/iu.test(err.message));
    return { ok: false, status: null, timedOut };
  }
}

function stripSuspectTrailingSegment (url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) {
      return null;
    }
    const last = parts[parts.length - 1];
    if (last === undefined || !SUSPECT_PATH_SEGMENT_RE.test(last)) {
      return null;
    }
    parts.pop();
    u.pathname = parts.length > 0 ? `/${parts.join('/')}/` : '/';
    return u.href;
  } catch {
    return null;
  }
}

function parentPathUrl (url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length <= 1) {
      return u.origin + '/';
    }
    parts.pop();
    u.pathname = `/${parts.join('/')}/`;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * User/API URL wins; else first HTTPS URL extracted from the prompt.
 */
export function resolveCampaignReferenceUrl (params: {
  explicit?: string | null;
  fromPromptUrls?: readonly string[];
}): string | null {
  const explicit = params.explicit?.trim() ?? '';
  if (explicit.length > 0) {
    try {
      return new URL(explicit).href;
    } catch {
      // fall through
    }
  }
  for (const raw of params.fromPromptUrls ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      return new URL(trimmed).href;
    } catch {
      continue;
    }
  }
  return null;
}

/** HEAD/GET preflight for the campaign reference URL before style-guide generation. */
export async function preflightCampaignReferenceUrl (url: string): Promise<{
  reachable: boolean;
  blocked: boolean;
  status: number | null;
  normalizedUrl: string;
  logLine: string;
  timedOut: boolean;
}> {
  const trimmed = url.trim();
  let normalizedUrl = trimmed;
  let anyTimedOut = false;
  const first = await checkUrlReachable(trimmed);
  anyTimedOut = anyTimedOut || first.timedOut;
  if (!first.ok) {
    const stripped = stripSuspectTrailingSegment(trimmed);
    if (stripped !== null) {
      const retry = await checkUrlReachable(stripped);
      anyTimedOut = anyTimedOut || retry.timedOut;
      if (retry.ok) {
        normalizedUrl = stripped;
        return {
          reachable: true,
          blocked: false,
          status: retry.status,
          normalizedUrl,
          logLine: `[style-guide] reference URL normalized: ${trimmed} → ${normalizedUrl}`,
          timedOut: false
        };
      }
    }
    const parent = parentPathUrl(trimmed);
    if (parent !== null && !anyTimedOut) {
      const retry = await checkUrlReachable(parent);
      anyTimedOut = anyTimedOut || retry.timedOut;
      if (retry.ok) {
        normalizedUrl = parent;
        return {
          reachable: true,
          blocked: false,
          status: retry.status,
          normalizedUrl,
          logLine: `[style-guide] reference URL normalized: ${trimmed} → ${normalizedUrl}`,
          timedOut: false
        };
      }
    }
    const status = first.status;
    const blocked = status === 401 || status === 403 || status === 406 || status === 451;
    return {
      reachable: false,
      blocked,
      status,
      normalizedUrl: trimmed,
      timedOut: anyTimedOut,
      logLine: anyTimedOut
        ? '[style-guide] reference URL check timed out — fallback to search/scrape'
        : blocked
          ? `[style-guide] reference URL blocked (HTTP ${String(status)}) — fallback to search/scrape`
          : `[style-guide] reference URL not reachable (HTTP ${String(status)}) — fallback to search/scrape`
    };
  }
  return {
    reachable: true,
    blocked: false,
    status: first.status,
    normalizedUrl,
    timedOut: false,
    logLine: `[style-guide] reference URL reachable: ${normalizedUrl}`
  };
}

async function firstReachableUrl (candidates: readonly string[]): Promise<string | null> {
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const { ok } = await checkUrlReachable(trimmed);
    if (ok) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Ensure brandURL (and optionally companyURL) respond with HTTP success.
 * Prefers user-provided campaign URLs from the prompt when model URL fails.
 */
/** Strip JSON/LLM junk after URLs (e.g. trailing `','` from malformed model output). */
export function sanitizeModelUrl (url: string): string {
  let s = url.trim();
  s = s.replace(/^['"]+|['"]+$/gu, '');
  s = s.replace(/[,;'"]+$/u, '');
  return s.trim();
}

export async function normalizeBrandAndCompanyUrls (params: {
  brandURL: string;
  companyURL: string;
  campaignReferenceUrl?: string | null;
  campaignUrlsFromPrompt?: readonly string[];
}): Promise<{
  brandURL: string;
  companyURL: string;
  changed: boolean;
  logLine: string | null;
}> {
  let brandURL = sanitizeModelUrl(params.brandURL);
  let companyURL = sanitizeModelUrl(params.companyURL);
  const originalBrand = brandURL;
  const promptUrls = (params.campaignUrlsFromPrompt ?? []).map((u) => sanitizeModelUrl(u));
  const referenceUrl = sanitizeModelUrl(params.campaignReferenceUrl?.trim() ?? '');

  const tryNormalizeBrand = async (start: string): Promise<string> => {
    const candidates: string[] = [];
    if (referenceUrl.length > 0) {
      candidates.push(referenceUrl);
      const refStripped = stripSuspectTrailingSegment(referenceUrl);
      if (refStripped !== null) {
        candidates.push(refStripped);
      }
      const refParent = parentPathUrl(referenceUrl);
      if (refParent !== null) {
        candidates.push(refParent);
      }
    }
    candidates.push(start);
    const stripped = stripSuspectTrailingSegment(start);
    if (stripped !== null) {
      candidates.push(stripped);
    }
    const parent = parentPathUrl(start);
    if (parent !== null) {
      candidates.push(parent);
    }
    for (const u of promptUrls) {
      candidates.push(u);
      const p = parentPathUrl(u);
      if (p !== null) {
        candidates.push(p);
      }
    }
    if (companyURL.length > 0) {
      candidates.push(companyURL);
    }

    const unique = [ ...new Set(candidates) ];
    const hit = await firstReachableUrl(unique);
    return hit ?? start;
  };

  if (referenceUrl.length > 0) {
    const { ok: refOk } = await checkUrlReachable(referenceUrl);
    if (refOk) {
      brandURL = referenceUrl;
    } else {
      brandURL = await tryNormalizeBrand(brandURL);
    }
  } else {
    const { ok: brandOk } = await checkUrlReachable(brandURL);
    if (!brandOk) {
      brandURL = await tryNormalizeBrand(brandURL);
    }
  }

  const { ok: companyOk } = await checkUrlReachable(companyURL);
  if (!companyOk && companyURL.length > 0) {
    const fallback = await firstReachableUrl([
      brandURL,
      ...promptUrls,
      parentPathUrl(brandURL) ?? ''
    ].filter((u) => u.length > 0));
    if (fallback !== null) {
      try {
        companyURL = new URL(fallback).origin + '/';
      } catch {
        // keep
      }
    }
  }

  const changed = brandURL !== originalBrand;
  const logLine = changed
    ? `[style-guide] brandURL normalized: ${originalBrand} → ${brandURL}`
    : null;

  return { brandURL, companyURL, changed, logLine };
}

// ===== reference-listing-urls.mts =====
/** Reference / listing page URL matching (shared by scrape boost and asset provenance). */

export type ReferenceListingFields = {
  campaignReferenceUrl?: string | null;
  campaignUrls?: readonly string[];
};

export function pageUrlsMatchForBoost (referenceRaw: string, fetchedPageUrl: string): boolean {
  try {
    const ref = new URL(referenceRaw.trim());
    const page = new URL(fetchedPageUrl);
    if (ref.origin !== page.origin) {
      return false;
    }
    const refPath = ref.pathname.replace(/\/+$/u, '') || '/';
    const pagePath = page.pathname.replace(/\/+$/u, '') || '/';
    return refPath === pagePath;
  } catch {
    return false;
  }
}

export function resolveReferenceListingUrls (fields: ReferenceListingFields): string[] {
  const urls: string[] = [];
  const ref = fields.campaignReferenceUrl?.trim() ?? '';
  if (ref.length > 0) {
    urls.push(ref);
  }
  for (const raw of fields.campaignUrls ?? []) {
    const u = raw.trim();
    if (u.length > 0) {
      urls.push(u);
    }
  }
  return [ ...new Set(urls) ];
}

// ===== product-asset-rules.mts =====
/**
 * Download-only heuristics: filter category nav tile URLs before scrape/download.
 * Not used for final asset validation — that relies on describe + descriptions audit.
 */

/** True when URL or filename looks like a text-only category/menu tile (e.g. Shopify MENU_vp_*). */
export function isTextOnlyCategoryNavProductAsset (urlOrFileName: string): boolean {
  const lower = urlOrFileName.toLowerCase();
  if (/menu[_-]?vp/iu.test(lower)) {
    return true;
  }
  if (/menu[_-]?coffret/iu.test(lower)) {
    return true;
  }
  if (/menu[_-]?gamme/iu.test(lower)) {
    return true;
  }
  if (/menu[_-]?access/iu.test(lower)) {
    return true;
  }
  if (/\/menu[_-]/iu.test(lower) && /banner|tile|nav|category/iu.test(lower)) {
    return true;
  }
  return false;
}

// ===== product-asset-sources.mts =====
export type ProductAssetSourceEntry = {
  fileName: string;
  sourceUrl: string;
  sourcePageUrl?: string;
  fromReferencePage?: boolean;
  /** Brave/search result title — used for entertainment poster relevance when URL is opaque. */
  sourceTitle?: string;
};

export type ProductAssetSourceProvenance = {
  sourcePageUrl?: string;
  fromReferencePage?: boolean;
  sourceTitle?: string;
};

export type ProductAssetSourcesFile = {
  updated_at: string;
  entries: ProductAssetSourceEntry[];
};

export function productAssetSourcesPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'product-asset-sources.json');
}

function legacyProductAssetSourcesPath (directoryPath: string): string {
  return join(directoryPath, 'products', LEGACY_PRODUCT_SOURCES_FILE_NAME);
}

function readSourcesFile (path: string): Map<string, ProductAssetSourceEntry> {
  const map = new Map<string, ProductAssetSourceEntry>();
  if (!existsSync(path)) {
    return map;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ProductAssetSourcesFile;
    for (const e of raw.entries ?? []) {
      if (typeof e.fileName === 'string' && typeof e.sourceUrl === 'string') {
        map.set(e.fileName, {
          fileName: e.fileName,
          sourceUrl: e.sourceUrl,
          ...(typeof e.sourcePageUrl === 'string' && e.sourcePageUrl.length > 0
            ? { sourcePageUrl: e.sourcePageUrl }
            : {}),
          ...(e.fromReferencePage === true ? { fromReferencePage: true } : {}),
          ...(typeof e.sourceTitle === 'string' && e.sourceTitle.length > 0
            ? { sourceTitle: e.sourceTitle }
            : {})
        });
      }
    }
  } catch {
    /* ignore corrupt file */
  }
  return map;
}

export function loadProductAssetSources (directoryPath: string): Map<string, ProductAssetSourceEntry> {
  const primaryPath = productAssetSourcesPath(directoryPath);
  if (existsSync(primaryPath)) {
    return readSourcesFile(primaryPath);
  }
  const legacyPath = legacyProductAssetSourcesPath(directoryPath);
  if (existsSync(legacyPath)) {
    return readSourcesFile(legacyPath);
  }
  return new Map();
}

function writeSourcesMap (directoryPath: string, map: Map<string, ProductAssetSourceEntry>): void {
  const reviewDir = join(directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const file: ProductAssetSourcesFile = {
    updated_at: new Date().toISOString(),
    entries: [ ...map.values() ]
  };
  writeFileSync(productAssetSourcesPath(directoryPath), `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8'
  });
  const legacy = legacyProductAssetSourcesPath(directoryPath);
  if (existsSync(legacy)) {
    unlinkSync(legacy);
  }
}

export function recordProductAssetSource (
  directoryPath: string,
  fileName: string,
  sourceUrl: string,
  provenance?: ProductAssetSourceProvenance
): void {
  const map = loadProductAssetSources(directoryPath);
  const prev = map.get(fileName);
  map.set(fileName, {
    fileName,
    sourceUrl,
    ...(provenance?.sourcePageUrl !== undefined && provenance.sourcePageUrl.length > 0
      ? { sourcePageUrl: provenance.sourcePageUrl }
      : prev?.sourcePageUrl !== undefined
        ? { sourcePageUrl: prev.sourcePageUrl }
        : {}),
    ...(provenance?.fromReferencePage === true
      ? { fromReferencePage: true }
      : prev?.fromReferencePage === true
        ? { fromReferencePage: true }
        : {}),
    ...(provenance?.sourceTitle !== undefined && provenance.sourceTitle.length > 0
      ? { sourceTitle: provenance.sourceTitle }
      : prev?.sourceTitle !== undefined
        ? { sourceTitle: prev.sourceTitle }
        : {})
  });
  writeSourcesMap(directoryPath, map);
}

export function clearProductAssetSources (directoryPath: string): void {
  writeSourcesMap(directoryPath, new Map());
}

export function removeProductAssetSource (directoryPath: string, fileName: string): void {
  const map = loadProductAssetSources(directoryPath);
  if (!map.delete(fileName)) {
    return;
  }
  writeSourcesMap(directoryPath, map);
}

// ===== style-guide-context.mts =====
/**
 * Parse STYLE_GUIDE_CONTEXT / studio contextPrompt and derive product image match terms.
 */




const CONTEXT_IS_RE =
  /\bthe context is\s+(.+?)(?:\.\s*|$)/ius;
const CONTEXT_ONLY_RE =
  /\bNo commercial brand[^.]*\.\s*The context is\s+(.+?)(?:\.\s*|$)/ius;

const PRODUCT_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'new',
  'they',
  'are',
  'was',
  'were',
  'will',
  'has',
  'have',
  'its',
  'their',
  'our',
  'your',
  'not',
  'but',
  'into',
  'about',
  'launching',
  'launch',
  'officiel',
  'official',
  'photo',
  'image',
  'visuel',
  'marketing',
  'packshot',
  'produit',
  'product',
  'brand',
  'marque',
  'context',
  'specified',
  'beyond',
  'infer',
  'electric',
  'electrique',
  'hybrid',
  'hybride',
  'vehicle',
  'voiture',
  'car',
  'auto',
  'ev',
  'neu',
  'neue',
  'nouveau',
  'nouvelle'
]);

export type ParsedStyleGuideContext = {
  raw: string;
  /** Text after "the context is …" when present. */
  campaignContext: string | null;
  /** HTTPS URLs found in the full prompt (user-provided collection pages, etc.). */
  campaignUrls: string[];
};

const CATALOG_CAMPAIGN_RE =
  /\b(collection|campagne|campaign|lookbook|catalogue|catalog|saison|season|été|ete|summer|spring|winter|holiday|plage|beach|promotion|promotions|offres?|coupons?|soldes|imbattable|deals|prospectus|arrivages?|hebdomadaire|weekly)\b/iu;

/** French film promo phrasing — not a retail listing campaign. */
const FILM_PROMOTION_RE = /\bpromotion\s+(?:du\s+)?(?:film|movie|cin[éè]ma)\b/iu;

/** French single-product promo (e.g. "promotion de la voiture SEAL U") — not a multi-SKU listing. */
const SINGLE_PRODUCT_PROMOTION_RE =
  /\bpromotion\s+(?:de\s+la\s+|du\s+|de\s+l['']|d['']|des\s+)/iu;

/** Film/series/theatrical — avoid generic tokens (saison, spectacle) that match theme parks. */
const ENTERTAINMENT_CAMPAIGN_RE =
  /\b(film|movie|cin[éè]ma|cinema|s[ée]ries?\s+(?:tv|t[eé]l[eé]|netflix|prime|disney\+?)|series\s+(?:tv|netflix)|trailer|poster|affiche\s+(?:du\s+)?film|sortie\s+(?:du\s+)?film|theatrical|rebooquel|key\s*art|blockbuster|acteurs?|actrices?)\b/iu;

const EXPERIENCE_CAMPAIGN_RE =
  /\b(parc\s+d['']?\s*attractions?|theme\s+park|amusement\s+park|parc\s+de\s+loisirs|zoo|aquarium|mus[eé]e|futuroscope|domaine\s+skiable|station\s+de\s+ski|walibi|ast[eé]rix|eurodisney|disneyland|attractions?\s+(?:aquatiques?|th[eé]matiques?)|billetterie|billet\s+d['']?\s*entr[eé]e|pass\s+saison|carte\s+cadeau\s+(?:parc|Walibi)|visite\s+(?:famille|parc)|man[eè]ge|roller\s+coaster)\b/iu;

export type CampaignAssetProfile = 'retail' | 'entertainment' | 'experience';

/** Trusted cinema / film-database hosts for poster and still images. */
export const ENTERTAINMENT_VISUAL_HOST_SUFFIXES = [
  'imdb.com',
  'media-amazon.com',
  'allocine.fr',
  'acsta.net',
  'impawards.com',
  'themoviedb.org',
  'tmdb.org'
] as const;

export const ENTERTAINMENT_DENIED_HOST_RE =
  /(?:^|\.)redbubble\.|kindpng|pngaaa|pinterest\.|blogspot\.|discussingfilm\.|horreurnews\./iu;

export type ProductMatchFields = {
  campaignContext?: string | null;
  productName?: string;
  brandName?: string;
  companyName?: string;
  brandContext?: string;
  brandURL?: string;
  campaignReferenceUrl?: string | null;
  campaignUrls?: readonly string[];
  /** Explicit profile from style guide; overrides heuristic detection when set. */
  campaignAssetProfile?: CampaignAssetProfile;
};

/** Build ProductMatchFields without passing explicit `undefined` (exactOptionalPropertyTypes). */
export function buildProductMatchFields (input: {
  campaignContext?: string | null | undefined;
  productName?: string | undefined;
  brandName?: string | undefined;
  companyName?: string | undefined;
  brandContext?: string | undefined;
  brandURL?: string | undefined;
  campaignReferenceUrl?: string | null | undefined;
  campaignUrls?: readonly string[] | undefined;
  campaignAssetProfile?: CampaignAssetProfile | undefined;
}): ProductMatchFields {
  const out: ProductMatchFields = {};
  if (input.campaignContext !== undefined) {
    out.campaignContext = input.campaignContext;
  }
  if (input.productName !== undefined) {
    out.productName = input.productName;
  }
  if (input.brandName !== undefined) {
    out.brandName = input.brandName;
  }
  if (input.companyName !== undefined) {
    out.companyName = input.companyName;
  }
  if (input.brandContext !== undefined) {
    out.brandContext = input.brandContext;
  }
  if (input.brandURL !== undefined) {
    out.brandURL = input.brandURL;
  }
  if (input.campaignReferenceUrl !== undefined) {
    out.campaignReferenceUrl = input.campaignReferenceUrl;
  }
  if (input.campaignUrls !== undefined) {
    out.campaignUrls = input.campaignUrls;
  }
  if (input.campaignAssetProfile !== undefined) {
    out.campaignAssetProfile = input.campaignAssetProfile;
  }
  return out;
}

/** Extract campaign clause from a composed context prompt. */
export function extractCampaignContextFromPrompt (prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const m1 = CONTEXT_IS_RE.exec(trimmed);
  if (m1?.[1] !== undefined) {
    return m1[1].trim();
  }
  const m2 = CONTEXT_ONLY_RE.exec(trimmed);
  if (m2?.[1] !== undefined) {
    return m2[1].trim();
  }
  return null;
}

function campaignHaystack (fields: ProductMatchFields): string {
  return [
    fields.productName ?? '',
    fields.campaignContext ?? '',
    fields.brandContext ?? '',
    fields.brandName ?? ''
  ]
    .join(' ')
    .trim();
}

/** Film, series, or theatrical promo — not a retail product catalog. */
export function isEntertainmentCampaign (fields: ProductMatchFields): boolean {
  const hay = campaignHaystack(fields);
  if (hay.length > 0 && FILM_PROMOTION_RE.test(hay)) {
    return true;
  }
  if (hay.length > 0 && ENTERTAINMENT_CAMPAIGN_RE.test(hay)) {
    return true;
  }
  const brandUrl = fields.brandURL?.trim() ?? '';
  if (brandUrl.length > 0) {
    try {
      const host = new URL(brandUrl).hostname.toLowerCase();
      if (host.endsWith('.film')) {
        return true;
      }
    } catch {
      // skip invalid URL
    }
  }
  return false;
}

/** Theme parks, leisure venues, destinations, ticketing — not retail SKU catalogs. */
export function isExperienceCampaign (fields: ProductMatchFields): boolean {
  if (isEntertainmentCampaign(fields)) {
    return false;
  }
  const hay = campaignHaystack(fields);
  if (hay.length > 0 && EXPERIENCE_CAMPAIGN_RE.test(hay)) {
    return true;
  }
  return false;
}

/** Resolve asset audit/describe profile: explicit field → entertainment → experience → retail. */
export function resolveCampaignAssetProfile (fields: ProductMatchFields): CampaignAssetProfile {
  const explicit = fields.campaignAssetProfile;
  if (explicit === 'retail' || explicit === 'entertainment' || explicit === 'experience') {
    return explicit;
  }
  if (isEntertainmentCampaign(fields)) {
    return 'entertainment';
  }
  if (isExperienceCampaign(fields)) {
    return 'experience';
  }
  return 'retail';
}

export function isEntertainmentVisualHost (url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ENTERTAINMENT_VISUAL_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`)
    );
  } catch {
    return false;
  }
}

export function isEntertainmentDeniedHost (url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ENTERTAINMENT_DENIED_HOST_RE.test(host) || ENTERTAINMENT_DENIED_HOST_RE.test(url);
  } catch {
    return false;
  }
}

function isRetailCatalogContext (hay: string): boolean {
  if (FILM_PROMOTION_RE.test(hay)) {
    return false;
  }
  if (SINGLE_PRODUCT_PROMOTION_RE.test(hay)) {
    return false;
  }
  return CATALOG_CAMPAIGN_RE.test(hay);
}

/** True when context promotes one named product/model, not a multi-SKU catalog. */
export function isSingleProductCampaignContext (fields: ProductMatchFields): boolean {
  const product = fields.productName?.trim() ?? '';
  if (product.length < 2) {
    return false;
  }
  const hay = [ fields.campaignContext ?? '', fields.productName ?? '', fields.brandContext ?? '' ]
    .join(' ')
    .trim();
  if (hay.length === 0) {
    return false;
  }
  if (SINGLE_PRODUCT_PROMOTION_RE.test(hay)) {
    return true;
  }
  const ref = fields.campaignReferenceUrl?.trim() ?? '';
  return ref.length > 0 && looksLikeProductDetailReferenceUrl(ref);
}

/** Product/model detail page — not a category or collection listing. */
export function looksLikeProductDetailReferenceUrl (url: string): boolean {
  try {
    const path = new URL(url.trim()).pathname.toLowerCase();
    if (
      /\/(?:product|produit|products|vehicule|vehicle|vehicules|model|models|sku|item|items|p|dp)\b/iu.test(
        path
      )
    ) {
      return true;
    }
    const segments = path.split('/').filter((s) => s.length > 0);
    const last = segments.at(-1) ?? '';
    return segments.length >= 3 && last.length >= 4 && /[a-z]/iu.test(last) && /[-_]/u.test(last);
  } catch {
    return false;
  }
}

function looksLikeListingReferenceUrl (url: string): boolean {
  try {
    const path = new URL(url.trim()).pathname.toLowerCase();
    return /\/(?:collections?|catalogue|catalog|category|categories|categorie|range|gamme|offres|promotions|shop\/all|listing)\b/iu.test(
      path
    );
  } catch {
    return false;
  }
}

/** Listing / multi-product campaign: collection URL and/or catalog-style context text. */
export function isListingPageCampaign (fields: ProductMatchFields): boolean {
  if (isEntertainmentCampaign(fields) || isExperienceCampaign(fields)) {
    return false;
  }
  if (isSingleProductCampaignContext(fields)) {
    return false;
  }
  const ref = fields.campaignReferenceUrl?.trim() ?? '';
  if (ref.length > 0 && looksLikeProductDetailReferenceUrl(ref)) {
    return false;
  }
  if (ref.length > 0 && looksLikeListingReferenceUrl(ref)) {
    return true;
  }
  const hay = [
    fields.productName ?? '',
    fields.campaignContext ?? '',
    fields.brandContext ?? ''
  ]
    .join(' ')
    .trim();
  if (hay.length === 0) {
    return false;
  }
  return isRetailCatalogContext(hay);
}

/**
 * Single hero product/model (e.g. BYD SEAL U DM-i, one tea SKU).
 * Multiple images of the same product (angles, lifestyle, packshot) are expected — not distinct SKUs.
 */
export function isHeroProductCampaign (fields: ProductMatchFields): boolean {
  if (isEntertainmentCampaign(fields) || isExperienceCampaign(fields)) {
    return false;
  }
  if (isListingPageCampaign(fields)) {
    return false;
  }
  if (isSingleProductCampaignContext(fields)) {
    return true;
  }
  const product = fields.productName?.trim() ?? '';
  return product.length >= 2;
}

/** @deprecated Use isListingPageCampaign — kept for existing imports. */
export function isCatalogCampaign (fields: ProductMatchFields): boolean {
  return isListingPageCampaign(fields);
}

export function isProductAssetFromReferenceListing (
  entry: ProductAssetSourceEntry,
  referenceUrls: readonly string[]
): boolean {
  if (referenceUrls.length === 0) {
    return false;
  }
  if (entry.fromReferencePage === true) {
    return true;
  }
  const page = entry.sourcePageUrl?.trim() ?? '';
  if (page.length > 0) {
    return referenceUrls.some((ref) => pageUrlsMatchForBoost(ref, page));
  }
  return false;
}

/** Drop retailer/company tokens when campaign has more specific terms (e.g. LEGO vs Pokémon). */
export function filterRetailCampaignRelevanceTerms (
  terms: readonly string[],
  fields: Pick<ProductMatchFields, 'brandName' | 'companyName'>
): string[] {
  const parentBrandTokens = new Set<string>();
  for (const raw of [ fields.companyName ?? '' ]) {
    for (const t of normalizeForTermMatch(raw.replace(/[®™]/gu, '')).split(/\s+/u)) {
      if (t.length >= 4) {
        parentBrandTokens.add(t);
      }
    }
  }
  const specific = terms.filter((term) => {
    const t = normalizeForTermMatch(term);
    if (t.length < 3) {
      return false;
    }
    if (/\d{3,}/u.test(t)) {
      return true;
    }
    if (parentBrandTokens.has(t)) {
      return false;
    }
    return true;
  });
  return specific.length > 0 ? [ ...specific ] : [ ...terms ];
}

export function buildRetailCampaignRelevanceTerms (fields: ProductMatchFields): string[] {
  return filterRetailCampaignRelevanceTerms(buildProductMatchTerms(fields), fields);
}

/** Same rules as listing-mode product review in creative-native-assets-deterministic. */
export function wouldPassListingProductAsset (params: {
  entry: ProductAssetSourceEntry | undefined;
  sourceUrl: string;
  referenceListingUrls: readonly string[];
  officialHosts: readonly string[];
  terms: readonly string[];
  minScore?: number;
  relevanceFields?: Pick<ProductMatchFields, 'brandName' | 'companyName'>;
}): boolean {
  const sourceUrl = params.sourceUrl.trim();
  if (sourceUrl.length === 0) {
    return false;
  }
  const minScore = params.minScore ?? productMinRelevanceScore();
  const referenceProvenance =
    params.entry !== undefined &&
    isProductAssetFromReferenceListing(params.entry, params.referenceListingUrls);
  const termsForContext =
    params.relevanceFields !== undefined
      ? filterRetailCampaignRelevanceTerms(params.terms, params.relevanceFields)
      : params.terms;
  const fileName = params.entry?.fileName ?? '';
  const contextOk =
    scoreProductContextRelevance(`${sourceUrl} ${fileName}`, params.entry?.sourceTitle ?? '', termsForContext) >=
    minScore;
  return referenceProvenance || contextOk;
}

/** Hero poster / still validation for film and series campaigns. */
export function wouldPassEntertainmentProductAsset (params: {
  entry: ProductAssetSourceEntry | undefined;
  sourceUrl: string;
  referenceListingUrls: readonly string[];
  officialHosts: readonly string[];
  terms: readonly string[];
  minScore?: number;
  sourceTitle?: string;
}): boolean {
  const sourceUrl = params.sourceUrl.trim();
  if (sourceUrl.length === 0 || isEntertainmentDeniedHost(sourceUrl)) {
    return false;
  }
  const minScore = params.minScore ?? productMinRelevanceScore();
  const title = params.sourceTitle?.trim() ?? params.entry?.sourceTitle?.trim() ?? '';
  const relevance = scoreProductContextRelevance(sourceUrl, title, params.terms);

  if (
    params.entry !== undefined &&
    isProductAssetFromReferenceListing(params.entry, params.referenceListingUrls)
  ) {
    return true;
  }
  if (params.officialHosts.length > 0) {
    if (isOfficialHostCampaignOrProductImageUrl(sourceUrl, params.officialHosts)) {
      return true;
    }
    if (
      hostOnOfficialList(sourceUrl, params.officialHosts) &&
      relevance >= minScore
    ) {
      return true;
    }
  }
  if (isEntertainmentVisualHost(sourceUrl) && relevance >= minScore) {
    return true;
  }
  if (isEntertainmentVisualHost(sourceUrl) && title.length > 0 && relevance >= minScore - 8) {
    return true;
  }
  return relevance >= minScore + 15;
}

/** Attraction / park promo visuals — official site lifestyle and campaign photos. */
export function wouldPassExperienceProductAsset (params: {
  entry: ProductAssetSourceEntry | undefined;
  sourceUrl: string;
  referenceListingUrls: readonly string[];
  officialHosts: readonly string[];
  terms: readonly string[];
  minScore?: number;
  sourceTitle?: string;
}): boolean {
  const sourceUrl = params.sourceUrl.trim();
  if (sourceUrl.length === 0) {
    return false;
  }
  const minScore = params.minScore ?? productMinRelevanceScore();
  const title = params.sourceTitle?.trim() ?? params.entry?.sourceTitle?.trim() ?? '';
  const relevance = scoreProductContextRelevance(sourceUrl, title, params.terms);

  if (
    params.entry !== undefined &&
    isProductAssetFromReferenceListing(params.entry, params.referenceListingUrls)
  ) {
    return true;
  }
  if (params.officialHosts.length > 0) {
    if (isOfficialHostCampaignOrProductImageUrl(sourceUrl, params.officialHosts)) {
      return true;
    }
    if (hostOnOfficialList(sourceUrl, params.officialHosts) && relevance >= minScore - 4) {
      return true;
    }
  }
  return relevance >= minScore;
}

export function parseStyleGuideContextPrompt (
  prompt: string,
  extractUrls: (text: string) => string[] = () => []
): ParsedStyleGuideContext {
  const raw = prompt.trim();
  const fromRaw = extractUrls(raw);
  const campaign = extractCampaignContextFromPrompt(prompt);
  const fromCampaign = campaign !== null ? extractUrls(campaign) : [];
  return {
    raw,
    campaignContext: campaign,
    campaignUrls: [ ...new Set([ ...fromRaw, ...fromCampaign ]) ]
  };
}

function slugVariants (slug: string): string[] {
  const lower = slug.toLowerCase();
  const out = new Set<string>([ lower, lower.replace(/-/g, ' '), lower.replace(/-/g, '_') ]);
  for (const part of lower.split(/[-_]+/u)) {
    if (part.length >= 3 && !/^\d+$/u.test(part)) {
      out.add(part);
      for (const alias of scandinavianSlugAliases(part)) {
        out.add(alias);
      }
    }
  }
  return [ ...out ];
}

/** ö/ø in names vs oe in URL slugs (e.g. SÖDERHAMN → soderhamn vs soederhamn). */
function scandinavianSlugAliases (slugPart: string): string[] {
  const base = normalizeForTermMatch(slugPart);
  const out = new Set<string>();
  if (/^soder/iu.test(base)) {
    out.add(base.replace(/^soder/iu, 'soeder'));
  }
  if (/^soeder/iu.test(base)) {
    out.add(base.replace(/^soeder/iu, 'soder'));
  }
  return [ ...out ];
}

/** Path folder names that rarely identify a product/campaign (locale, taxonomy, shop roots). */
const BRAND_URL_PATH_SKIP = new Set([
  'www',
  'shop',
  'store',
  'boutique',
  'magasin',
  'eshop',
  'e-shop',
  'products',
  'product',
  'produits',
  'produit',
  'collections',
  'collection',
  'categories',
  'category',
  'catalog',
  'catalogue',
  'catalogs',
  'browse',
  'search',
  'modeles',
  'models',
  'model',
  'pages',
  'page',
  'home',
  'index',
  'html',
  'p',
  'c',
  'en',
  'fr',
  'de',
  'es',
  'it',
  'nl',
  'be',
  'ch',
  'uk',
  'us',
  'ca',
  'au',
  'jp',
  'cn'
]);

function isSignificantBrandUrlSegment (segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length < 3) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (BRAND_URL_PATH_SKIP.has(lower)) {
    return false;
  }
  if (/^[a-z]{2}(-[a-z]{2})?$/iu.test(lower)) {
    return false;
  }
  if (/^\d+$/u.test(lower)) {
    return false;
  }
  return /[\p{L}]/u.test(trimmed);
}

/** Derive match terms from the last meaningful pathname segments of brandURL. */
function termsFromBrandUrlPath (brandURL: string | undefined): string[] {
  if (brandURL === undefined || brandURL.trim().length === 0) {
    return [];
  }
  try {
    const segments = new URL(brandURL.trim()).pathname.split('/').filter((s) => s.length > 0);
    const terms: string[] = [];
    for (const seg of segments) {
      if (!isSignificantBrandUrlSegment(seg)) {
        continue;
      }
      for (const v of slugVariants(seg)) {
        terms.push(v);
      }
    }
    return terms;
  } catch {
    return [];
  }
}

function tokensFromText (text: string, brandName: string): string[] {
  const brandLower = brandName.trim().toLowerCase();
  const stop = new Set(PRODUCT_STOPWORDS);
  if (brandLower.length > 0) {
    for (const part of brandLower.split(/\s+/u)) {
      stop.add(part);
    }
  }

  const phrases: string[] = [];
  const normalized = text.replace(/[_/]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    return [];
  }

  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const significant = words.filter((w) => w.length >= 2 && !stop.has(w.toLowerCase()));

  for (let len = Math.min(4, significant.length); len >= 2; len -= 1) {
    for (let i = 0; i <= significant.length - len; i += 1) {
      const slice = significant.slice(i, i + len);
      if (slice.some((w) => w.length >= 3 || /\d/u.test(w))) {
        phrases.push(slice.join(' '));
      }
    }
  }

  for (const w of significant) {
    if (w.length >= 3 || /\d/u.test(w)) {
      phrases.push(w);
    }
  }

  return phrases;
}

/** Terms used to rank/filter product images (longest phrases first). */
export function buildProductMatchTerms (fields: ProductMatchFields): string[] {
  const brand = fields.brandName?.trim() ?? '';
  const terms = new Set<string>();

  const productName = fields.productName?.trim() ?? '';
  if (productName.length > 0) {
    terms.add(productName);
    for (const t of tokensFromText(productName, brand)) {
      terms.add(t);
      for (const alias of scandinavianSlugAliases(t)) {
        terms.add(alias);
      }
    }
    for (const alias of scandinavianSlugAliases(productName)) {
      terms.add(alias);
    }
  }

  const campaign = fields.campaignContext?.trim() ?? '';
  if (campaign.length > 0) {
    for (const t of tokensFromText(campaign, brand)) {
      terms.add(t);
    }
  }

  const brandCtx = fields.brandContext?.trim() ?? '';
  if (brandCtx.length > 0 && productName.length > 0) {
    const productLower = productName.toLowerCase();
    const sentences = brandCtx.split(/[.!?]+/u);
    for (const sentence of sentences) {
      if (sentence.toLowerCase().includes(productLower)) {
        for (const t of tokensFromText(sentence, brand)) {
          terms.add(t);
        }
      }
    }
  }

  for (const t of termsFromBrandUrlPath(fields.brandURL)) {
    terms.add(t);
  }

  if (brandCtx.length > 0) {
    for (const sku of brandCtx.matchAll(/\b\d{5}\b/gu)) {
      terms.add(sku[0]);
    }
  }

  return [ ...terms ]
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function escapeRegExp (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Fold accents so URL paths like PLEIN_ETE match campaign terms with « été ». */
export function normalizeForTermMatch (text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[_]+/gu, '-');
}

function termMatchesHaystack (term: string, haystack: string): boolean {
  const t = normalizeForTermMatch(term.trim());
  if (t.length === 0) {
    return false;
  }
  const hay = normalizeForTermMatch(haystack);
  const flexible = escapeRegExp(t).replace(/\s+/gu, '[-_\\s]+');
  return new RegExp(flexible, 'iu').test(hay);
}

function hostOnOfficialList (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0) {
    return false;
  }
  const host = new URL(url).hostname.toLowerCase();
  return officialHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`)
  );
}

/** Paths that are clearly not product/promo visuals on brand CDNs (payments, app UI, guides). */
const OFFICIAL_NON_CAMPAIGN_ASSET_RE =
  /(?:^|\/)(?:logo|footer|payment|visa|mastercard|paypal|apple-store|google-store|dpd-|arrow-|fonctionnalites_|newsletter|whatsapp|blog|guide_|recettes|categorie_visuel|online_shop_icons)(?:[./_-]|$)/iu;

/** Official brand CDN packshots (e.g. Demandware /dw/image/) — trusted without marketing-term match. */
export function isOfficialBrandProductImageUrl (
  url: string,
  officialHosts: readonly string[]
): boolean {
  if (officialHosts.length === 0) {
    return false;
  }
  try {
    if (!hostOnOfficialList(url, officialHosts)) {
      return false;
    }
    const lower = url.toLowerCase();
    const host = new URL(url).hostname.toLowerCase();
    if (host.startsWith('media.') && hostOnOfficialList(url, officialHosts)) {
      if (/\/is\/image\//iu.test(lower)) {
        return true;
      }
      if (/\.(?:jpe?g|png|webp)(?:\?|$)/iu.test(lower)) {
        return true;
      }
    }
    if (
      /\/content\/dam\//iu.test(lower) &&
      /\.(?:jpe?g|png|webp)(?:\?|$)/iu.test(lower) &&
      !/(?:^|\/)(?:logo|master\/home\/[^/]*logo)/iu.test(lower)
    ) {
      return true;
    }
    return (
      /\/dw\/image\//iu.test(lower) ||
      /\/on\/demandware\.static\//iu.test(lower) ||
      /packshot|product[_-]?image|_prd\/|\/products?\//iu.test(lower)
    );
  } catch {
    return false;
  }
}

/**
 * Official host campaign / promo visuals (e.g. Lidl /static/assets/WON-*.jpg) — trusted like packshots.
 */
export function isOfficialHostCampaignOrProductImageUrl (
  url: string,
  officialHosts: readonly string[]
): boolean {
  if (isOfficialBrandProductImageUrl(url, officialHosts)) {
    return true;
  }
  if (officialHosts.length === 0) {
    return false;
  }
  try {
    if (!hostOnOfficialList(url, officialHosts)) {
      return false;
    }
    const lower = url.toLowerCase();
    if (OFFICIAL_NON_CAMPAIGN_ASSET_RE.test(lower) || /\.svg(?:\?|$)/iu.test(lower)) {
      return false;
    }
    if (
      /\/static\/assets\//iu.test(lower) ||
      /\/cdn\/assets\//iu.test(lower) ||
      /\/assets\/gcp[\da-f]/iu.test(lower)
    ) {
      return /\.(?:jpe?g|png|webp)(?:\?|$)/iu.test(lower);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Filter non-official URLs by context terms; keep all official /dw/image/ packshots.
 */
export function filterPrioritizeProductUrls (
  urls: readonly string[],
  terms: readonly string[],
  minScore: number,
  officialHosts: readonly string[]
): string[] {
  const official: string[] = [];
  const other: string[] = [];
  for (const url of urls) {
    if (isOfficialHostCampaignOrProductImageUrl(url, officialHosts)) {
      official.push(url);
    } else {
      other.push(url);
    }
  }
  const filteredOther =
    terms.length === 0 ? [ ...other ] : filterUrlsByProductRelevance(other, terms, minScore);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [ ...official, ...filteredOther ]) {
    if (!seen.has(url)) {
      seen.add(url);
      merged.push(url);
    }
  }
  return merged;
}

/**
 * Relevance score for a product image URL/title against context-derived terms.
 * Negative when URL clearly names another model than the primary product phrase.
 */
export function scoreProductContextRelevance (
  url: string,
  title: string,
  terms: readonly string[]
): number {
  if (terms.length === 0) {
    return 0;
  }

  const hay = normalizeForTermMatch(`${url} ${title}`);
  let score = 0;
  let matched = false;

  for (const term of terms) {
    if (termMatchesHaystack(term, hay)) {
      matched = true;
      score += Math.min(60, 12 + term.length * 2);
    }
  }

  if (!matched) {
    return -20;
  }

  score -= scoreSiblingProductPenalty(primaryTermForSiblingPenalty(terms, hay), hay);

  return score;
}

/** Prefer the longest term that actually appears in the URL/title — not the longest campaign word (e.g. "promotion"). */
function primaryTermForSiblingPenalty (terms: readonly string[], hay: string): string {
  const matched = terms.filter((t) => termMatchesHaystack(t, hay));
  if (matched.length === 0) {
    return terms[0] ?? '';
  }
  return [ ...matched ].sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * When the primary term and the URL both look like product slugs but disagree on a
 * distinguishing token (e.g. seal-u vs sealion-7), apply a penalty without hard-coded brands.
 */
function scoreSiblingProductPenalty (primaryTerm: string, hay: string): number {
  const primary = normalizeForTermMatch(primaryTerm);
  if (primary.length < 3) {
    return 0;
  }

  const primaryTokens = primary.split(/[-_\s]+/u).filter((t) => t.length >= 2);
  if (primaryTokens.length === 0) {
    return 0;
  }

  const hayTokens = new Set(
    hay.split(/[-_\s./]+/u).filter((t) => t.length >= 2)
  );

  const primaryInHay = primaryTokens.every((t) => hayTokens.has(t) || hay.includes(t));
  if (primaryInHay) {
    return 0;
  }

  const overlap = primaryTokens.filter((t) => hayTokens.has(t) || [ ...hayTokens ].some((h) => h.includes(t) || t.includes(h)));
  if (overlap.length === 0) {
    return 0;
  }

  const distinctivePrimary = primaryTokens.filter((t) => /\d/u.test(t) || t.length >= 4);
  const distinctiveHay = [ ...hayTokens ].filter((t) => /\d/u.test(t) || t.length >= 4);

  if (distinctivePrimary.length === 0 || distinctiveHay.length === 0) {
    return 0;
  }

  const primaryDistinctMatch = distinctivePrimary.some(
    (t) => hayTokens.has(t) || hay.includes(t)
  );
  const hayDistinctMismatch = distinctiveHay.some(
    (t) => !primaryTokens.includes(t) && !primary.includes(t) && (/\d/u.test(t) || t.length >= 5)
  );

  if (primaryDistinctMatch === false && hayDistinctMismatch) {
    return 90;
  }

  return 0;
}

export function filterUrlsByProductRelevance (
  urls: readonly string[],
  terms: readonly string[],
  minScore: number
): string[] {
  if (terms.length === 0) {
    return [ ...urls ];
  }
  return urls
    .map((url) => ({ url, score: scoreProductContextRelevance(url, '', terms) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.url);
}

export function productMinRelevanceScore (): number {
  const raw = process.env['CREATIVE_PRODUCT_MIN_RELEVANCE_SCORE']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 12;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 12;
}


// ============================================================
// MODULE: assets
// ============================================================
// Auto-merged module: assets. Sources: logo-asset-rules, logo-lock, logo-rasterize, logo-search-names, logo-asset-sources, logo-transparency-check, logo-vision-audit, official-site-logo-extract, brave-image-assets, logo-pipeline, reference-url-preflight.
















// ===== logo-asset-rules.mts =====
/**
 * Canonical logo file rules for logos/ (one file; Haiku vision audit validates identity).
 */





/** Exactly one logo file lives in logos/ until Haiku vision audit approves it. */
export const CANONICAL_LOGO_COUNT = 1;

function scoreCanonicalLogoFile (filePath: string): number {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.svg') {
    return 300;
  }
  if (ext === '.png') {
    return 200;
  }
  if (ext === '.webp') {
    return 150;
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return 100;
  }
  if (ext === '.gif') {
    return 50;
  }
  return 0;
}

/** Keep the best logo file by format; remove any extras in logos/. */
export async function enforceSingleCanonicalLogo (
  directoryPath: string
): Promise<{ kept: string | null; removed: string[] }> {
  const logosDir = join(directoryPath, 'logos');
  if (!existsSync(logosDir)) {
    return { kept: null, removed: [] };
  }

  const files = listAssetImageFiles(directoryPath, 'logos');
  if (files.length <= CANONICAL_LOGO_COUNT) {
    return { kept: files[0] ?? null, removed: [] };
  }

  const scored = files.map((fileName) => ({
    fileName,
    score: scoreCanonicalLogoFile(join(logosDir, fileName))
  }));
  scored.sort((a, b) => b.score - a.score);

  const kept = scored[0]?.fileName ?? null;
  const removed: string[] = [];
  for (let i = 1; i < scored.length; i += 1) {
    const entry = scored[i];
    if (entry === undefined) {
      continue;
    }
    unlinkSync(join(logosDir, entry.fileName));
    removed.push(entry.fileName);
  }
  return { kept, removed };
}

// ===== logo-lock.mts =====
export type LogoLockFile = {
  approved_at: string;
  source: string;
};

export function logoLockPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'logo-lock.json');
}

export function legacyLogoLockPath (directoryPath: string): string {
  return join(directoryPath, 'logos', LEGACY_LOGO_LOCK_FILE_NAME);
}

export function logoLockExists (directoryPath: string): boolean {
  return existsSync(logoLockPath(directoryPath)) || existsSync(legacyLogoLockPath(directoryPath));
}

export function writeLogoLock (
  directoryPath: string,
  payload: LogoLockFile
): void {
  const reviewDir = join(directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(logoLockPath(directoryPath), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8'
  });
  const legacy = legacyLogoLockPath(directoryPath);
  if (existsSync(legacy)) {
    unlinkSync(legacy);
  }
}

export function clearLogoLock (directoryPath: string): void {
  const path = logoLockPath(directoryPath);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  const legacy = legacyLogoLockPath(directoryPath);
  if (existsSync(legacy)) {
    unlinkSync(legacy);
  }
}

// ===== logo-rasterize.mts =====
const SVG_RASTER_WIDTH = 800;
const SVG_RASTER_VIEWPORT = { width: 800, height: 400 };

function isPlaywrightMissingError (err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|npx playwright install/iu.test(msg);
}

function rasterizeSvgWithResvg (svgMarkup: string): Buffer {
  const resvg = new Resvg(svgMarkup, {
    background: '#ffffff',
    fitTo: { mode: 'width', value: SVG_RASTER_WIDTH }
  });
  return Buffer.from(resvg.render().asPng());
}

async function rasterizeSvgWithPlaywright (svgMarkup: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: SVG_RASTER_VIEWPORT
    });
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head>` +
        `<body style="margin:0;padding:16px;background:#ffffff;display:flex;align-items:center;justify-content:center;">` +
        `${svgMarkup}</body></html>`,
      { waitUntil: 'load' }
    );
    const locator = page.locator('svg').first();
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    const png = await locator.screenshot({ type: 'png' });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}

/** Rasterize an SVG logo to PNG so Haiku vision can inspect it. */
export async function rasterizeSvgLogoToPngBuffer (absolutePath: string): Promise<Buffer> {
  const svgMarkup = readFileSync(absolutePath, 'utf8');
  let resvgError: string | undefined;
  try {
    const png = rasterizeSvgWithResvg(svgMarkup);
    console.log(`[logo-rasterize] rasterized via resvg: ${absolutePath}`);
    return png;
  } catch (err: unknown) {
    resvgError = err instanceof Error ? err.message : String(err);
    console.warn(`[logo-rasterize] resvg failed for ${absolutePath}: ${resvgError}`);
  }

  try {
    const png = await rasterizeSvgWithPlaywright(svgMarkup);
    console.log(`[logo-rasterize] rasterized via playwright: ${absolutePath}`);
    return png;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = isPlaywrightMissingError(err)
      ? ' Install Chromium with: npx playwright install chromium'
      : '';
    throw new Error(
      `SVG rasterization failed (resvg: ${resvgError ?? 'unknown'}; playwright: ${msg}).${hint}`
    );
  }
}

/** Read a logo file as an Anthropic vision image block (raster or SVG rasterized to PNG). */
export async function readLogoFileAsAnthropicImageBlock (
  absolutePath: string
): Promise<Anthropic.ImageBlockParam | null> {
  const buf = readFileSync(absolutePath);
  const fileName = absolutePath.split(/[/\\]/u).pop() ?? '';
  if (isSvgAssetFile(fileName, buf) || extname(absolutePath).toLowerCase() === '.svg') {
    try {
      const png = await rasterizeSvgLogoToPngBuffer(absolutePath);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: png.toString('base64')
        }
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[logo-rasterize] Failed to rasterize ${absolutePath}: ${msg}`);
      return null;
    }
  }

  const mimeType = sniffImageMimeFromBuffer(buf);
  if (mimeType !== null) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: buf.toString('base64')
      }
    };
  }

  return readFileAsAnthropicImageBlock(absolutePath);
}

// ===== logo-search-names.mts =====
export type LogoSearchNameContext = {
  brandName: string;
  companyName: string;
  productName: string;
  brandContext?: string;
  campaignContext?: string;
  campaignReferenceUrl?: string;
  campaignUrls?: readonly string[];
};

const LEGAL_ENTITY_SUFFIX_RE =
  /(?:,\s*|\s+)(Inc\.?|LLC|Ltd\.?|L\.?L\.?C\.?|GmbH|AG|S\.?A\.?|Corp\.?|Corporation|S\.?A\.?S\.?|B\.?V\.?)\s*$/iu;

const COLLABORATION_CONTEXT_RE =
  /\b(collaboration|partnership|co-?brand(?:ed|ing)?|joint\s+venture|between\s+.+\s+and\s+)\b/iu;

const COMPANY_NOISE_TOKENS = new Set([
  'the',
  'group',
  'international',
  'company',
  'inc',
  'corp',
  'entertainment',
  'studios'
]);

/** Strip legal suffixes (Inc., GmbH, etc.) from a company name. */
export function normalizeLegalEntityName (name: string): string {
  let out = name.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEGAL_ENTITY_SUFFIX_RE, '').trim();
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

export type BrandLogoRelationship = 'same' | 'division_line' | 'independent_sub_brand';

function extractCompanyBrandStem (companyName: string): string {
  const tokens = normalizeLegalEntityName(companyName.trim())
    .split(/\s+/u)
    .filter((t) => t.length > 0 && !COMPANY_NOISE_TOKENS.has(t.toLowerCase()));
  return tokens[0]?.toLowerCase() ?? '';
}

/**
 * Single source of truth for brand vs company logo expectations.
 * Division/regional arms (BYD France, Nike Football) share the parent wordmark.
 */
export function resolveBrandLogoRelationship (
  brandName: string,
  companyName: string
): BrandLogoRelationship {
  const brand = brandName.trim();
  const company = normalizeLegalEntityName(companyName.trim());

  if (brand.length === 0 || company.length === 0) {
    return 'same';
  }
  if (brand.toLowerCase() === company.toLowerCase()) {
    return 'same';
  }

  const brandLower = brand.toLowerCase();
  const companyLower = company.toLowerCase();
  const companyToken = companyLower.split(/\s+/u)[0] ?? '';
  if (companyToken.length >= 3 && brandLower.startsWith(companyToken)) {
    return 'division_line';
  }

  const stem = extractCompanyBrandStem(companyName);
  if (stem.length >= 3 && brandLower.startsWith(stem)) {
    return 'division_line';
  }

  return 'independent_sub_brand';
}

/** Product line, regional arm, or same brand (BYD France, Nike Football) — not an independent sub-brand. */
export function isDivisionLineBrand (brandName: string, companyName: string): boolean {
  const brand = brandName.trim();
  const company = companyName.trim();
  if (brand.length === 0 || company.length === 0) {
    return false;
  }
  return resolveBrandLogoRelationship(brandName, companyName) === 'division_line';
}

/** Distinct sub-brand with its own wordmark (Parkside/Lidl, Peugeot/Stellantis). */
export function isIndependentSubBrand (brandName: string, companyName: string): boolean {
  const brand = brandName.trim();
  const company = companyName.trim();
  if (brand.length === 0 || company.length === 0) {
    return false;
  }
  return resolveBrandLogoRelationship(brandName, companyName) === 'independent_sub_brand';
}

/**
 * Brand name(s) allowed in logo search queries.
 * Delegates to resolveBrandLogoRelationship — division lines → parent only; independent sub-brands → both.
 */
export function resolveLogoSearchNames (context: LogoSearchNameContext): string[] {
  const brand = context.brandName.trim();
  const company = normalizeLegalEntityName(context.companyName.trim());

  if (brand.length === 0 && company.length === 0) {
    return [];
  }
  if (brand.length === 0) {
    return company.length > 0 ? [ company ] : [];
  }
  if (company.length === 0) {
    return [ brand ];
  }

  switch (resolveBrandLogoRelationship(brand, company)) {
    case 'same':
      return [ brand ];
    case 'division_line':
      return [ company ];
    case 'independent_sub_brand':
      return [ brand, company ];
  }
}

function parseExplicitCollaborationParties (brandName: string): string[] {
  const cleaned = brandName.replace(/[®™]/gu, '').trim();
  const parts = cleaned
    .split(/\s*(?:×|x|&|\/)\s*/iu)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length >= 2 ? parts : [];
}

function parseTrademarkBrandParties (brandName: string): string[] {
  const segments: string[] = [];
  const re = /([\p{L}\p{N}][\p{L}\p{N}'’.\-]*)\s*[®™]/gu;
  let match: RegExpExecArray | null = re.exec(brandName);
  while (match !== null) {
    segments.push(match[1]!.trim());
    match = re.exec(brandName);
  }
  return segments;
}

function parsePartiesFromCollaborationContext (brandContext: string): string[] {
  const betweenMatch = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:[,.]|$)/iu.exec(brandContext.trim());
  if (betweenMatch === null) {
    return [];
  }
  const shortenParty = (raw: string): string => {
    const tokens = raw
      .replace(/[®™]/gu, '')
      .split(/\s+/u)
      .filter((t) => t.length > 0 && !COMPANY_NOISE_TOKENS.has(t.toLowerCase()));
    return tokens[0]?.trim() ?? raw.trim();
  };
  const a = shortenParty(betweenMatch[1] ?? '');
  const b = shortenParty(betweenMatch[2] ?? '');
  return a.length > 0 && b.length > 0 ? [ a, b ] : [];
}

/**
 * True when the campaign is a collaboration between distinct brands (e.g. LEGO × Pokémon),
 * not a retailer sub-brand (Parkside) or product line (Nike Football).
 */
export function isCollaborationCampaign (context: {
  brandName: string;
  companyName: string;
  brandContext?: string;
}): boolean {
  const ctx = (context.brandContext ?? '').trim();
  if (COLLABORATION_CONTEXT_RE.test(ctx)) {
    return true;
  }
  if (parseExplicitCollaborationParties(context.brandName).length >= 2) {
    return true;
  }
  if (parseTrademarkBrandParties(context.brandName).length >= 2) {
    return true;
  }
  if (isDivisionLineBrand(context.brandName, context.companyName)) {
    return false;
  }
  return false;
}

/** Participating brand names that should each have a separate wordmark file in logos/. */
export function resolveCollaborationLogoParties (context: {
  brandName: string;
  brandContext?: string;
}): string[] {
  const explicit = parseExplicitCollaborationParties(context.brandName);
  if (explicit.length >= 2) {
    return explicit;
  }
  const trademark = parseTrademarkBrandParties(context.brandName);
  if (trademark.length >= 2) {
    return trademark;
  }
  const fromContext = parsePartiesFromCollaborationContext(context.brandContext ?? '');
  if (fromContext.length >= 2) {
    return fromContext;
  }
  return explicit.length > 0 ? explicit : trademark;
}

/** System-prompt lines for collaboration logo audits (vision + assets review). */
export function buildCollaborationLogoAuditRules (context: {
  brandName: string;
  companyName: string;
  brandContext?: string;
}): string[] {
  const parties = resolveCollaborationLogoParties(context);
  const partyList = parties.length > 0 ? parties.join(', ') : context.brandName.trim();
  return [
    `- COLLABORATION CAMPAIGN (${partyList}): brandName "${context.brandName}" names the partnership, NOT a single composite logo file.`,
    '  * logos/ must use SEPARATE official wordmark files — one per participating brand when available.',
    '  * NEVER require, source, or BLOCKER because a file lacks a co-branded composite lockup (e.g. "LEGO Pokémon" in one image). Such assets usually do not exist.',
    '  * ACCEPT a file showing only one participating brand wordmark (e.g. LEGO only is valid).',
    `  * WARN (not blocker) when no logos/ file visually matches a listed party (${partyList}) — suggest one brave_retry_queries.logos entry per missing party using that party name only.`,
    '  * BLOCKER if the only logo file is a single composite image bundling multiple brand wordmarks together.',
    '  * BLOCKER for wrong brand, product packshot, or third-party scraper assets (same as standard rules).',
    '  * brave_retry_queries.logos: one query per missing party name only — never "co-branded lockup" or combined campaign brandName strings.'
  ];
}

/** System-prompt lines for product-line / regional campaigns sharing the parent wordmark. */
export function buildDivisionLineLogoAuditRules (context: {
  brandName: string;
  companyName: string;
}): string[] {
  return [
    `- DIVISION/REGIONAL CAMPAIGN: brandName "${context.brandName}" is a product line or regional distribution arm of companyName "${context.companyName}".`,
    `  * ACCEPT the official "${context.companyName}" wordmark — the same lockup used on brandURL/companyURL headers.`,
    `  * Do NOT require "${context.brandName}" country/region text or suffix in the logo file.`,
    `  * Do NOT BLOCKER because the logo shows only "${context.companyName}" without the regional suffix.`,
    '  * brave_retry_queries.logos: use parent company name only — never country/region suffixes from brandName.'
  ];
}

/** System-prompt lines for independent sub-brands with a distinct wordmark. */
export function buildIndependentSubBrandLogoAuditRules (context: {
  brandName: string;
  companyName: string;
}): string[] {
  return [
    `- SUB-BRAND CAMPAIGN: brandName is "${context.brandName}" but companyName is "${context.companyName}".`,
    `  * BLOCKER if the logo shows only the parent company lockup (e.g. "${context.companyName}" wordmark) without "${context.brandName}".`,
    `  * Accept only logos that display "${context.brandName}" or its official sub-brand wordmark/icon from brandURL.`
  ];
}

function tokenizeForLogoFilter (text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4 && !/^\d+$/u.test(t));
}

function extractForbiddenLogoQueryTokens (context: LogoSearchNameContext): Set<string> {
  const allowed = new Set(
    resolveLogoSearchNames(context).flatMap((n) => tokenizeForLogoFilter(n))
  );
  const forbidden = new Set<string>();

  for (const raw of [
    context.productName,
    context.campaignContext ?? '',
    context.brandContext ?? ''
  ]) {
    for (const t of tokenizeForLogoFilter(raw)) {
      if (!allowed.has(t)) {
        forbidden.add(t);
      }
    }
  }

  for (const rawUrl of [
    context.campaignReferenceUrl,
    ...(context.campaignUrls ?? [])
  ]) {
    if (rawUrl === undefined || rawUrl.trim().length === 0) {
      continue;
    }
    try {
      const segments = new URL(rawUrl.trim()).pathname.split('/').filter((s) => s.length >= 4);
      for (const seg of segments) {
        for (const t of seg.replace(/-/gu, ' ').split(/\s+/u)) {
          const lower = t.toLowerCase();
          if (lower.length >= 4 && !/^\d+$/u.test(lower) && !allowed.has(lower)) {
            forbidden.add(lower);
          }
        }
      }
    } catch {
      // skip invalid URL
    }
  }

  return forbidden;
}

/** Drop logo queries that contain campaign/product/context tokens not in allowed brand names. */
export function filterLogoSearchQueries (
  queries: readonly string[],
  context: LogoSearchNameContext
): string[] {
  const forbidden = extractForbiddenLogoQueryTokens(context);
  if (forbidden.size === 0) {
    return [ ...queries ];
  }
  return queries.filter((q) => {
    const hay = normalizeForTermMatch(q);
    for (const token of forbidden) {
      if (hay.includes(token)) {
        return false;
      }
    }
    return true;
  });
}

// ===== logo-asset-sources.mts =====
export type LogoSourcePhase = 'official' | 'wikipedia' | 'brave' | 'unknown';

export type LogoAssetSourceEntry = {
  fileName: string;
  sourceUrl: string;
  sourcePhase: LogoSourcePhase;
};

export type LogoAssetSourcesFile = {
  updated_at: string;
  entries: LogoAssetSourceEntry[];
};

export function logoAssetSourcesPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'logo-asset-sources.json');
}

function readLogoSourcesFile (path: string): Map<string, LogoAssetSourceEntry> {
  const map = new Map<string, LogoAssetSourceEntry>();
  if (!existsSync(path)) {
    return map;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as LogoAssetSourcesFile;
    for (const e of raw.entries ?? []) {
      if (typeof e.fileName === 'string' && typeof e.sourceUrl === 'string') {
        const phase: LogoSourcePhase =
          e.sourcePhase === 'official' ||
          e.sourcePhase === 'wikipedia' ||
          e.sourcePhase === 'brave'
            ? e.sourcePhase
            : 'unknown';
        map.set(e.fileName, {
          fileName: e.fileName,
          sourceUrl: e.sourceUrl,
          sourcePhase: phase
        });
      }
    }
  } catch {
    /* ignore corrupt file */
  }
  return map;
}

export function loadLogoAssetSources (directoryPath: string): Map<string, LogoAssetSourceEntry> {
  return readLogoSourcesFile(logoAssetSourcesPath(directoryPath));
}

function writeLogoSourcesMap (directoryPath: string, map: Map<string, LogoAssetSourceEntry>): void {
  const reviewDir = join(directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const file: LogoAssetSourcesFile = {
    updated_at: new Date().toISOString(),
    entries: [ ...map.values() ]
  };
  writeFileSync(logoAssetSourcesPath(directoryPath), `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8'
  });
}

export function recordLogoAssetSource (
  directoryPath: string,
  fileName: string,
  sourceUrl: string,
  sourcePhase: LogoSourcePhase
): void {
  const map = loadLogoAssetSources(directoryPath);
  map.set(fileName, { fileName, sourceUrl, sourcePhase });
  writeLogoSourcesMap(directoryPath, map);
}

export function removeLogoAssetSource (directoryPath: string, fileName: string): void {
  const map = loadLogoAssetSources(directoryPath);
  if (!map.delete(fileName)) {
    return;
  }
  writeLogoSourcesMap(directoryPath, map);
}

export function clearLogoAssetSources (directoryPath: string): void {
  const path = logoAssetSourcesPath(directoryPath);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function normalizeHost (hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, '');
}

export function urlHostMatchesOfficial (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0) {
    return false;
  }
  try {
    const h = normalizeHost(new URL(url).hostname);
    return officialHosts.some((oh) => {
      const o = normalizeHost(oh);
      return h === o || h.endsWith(`.${o}`);
    });
  } catch {
    return false;
  }
}

/** Reject known low-quality third-party logo URLs (not JPEG — opaque official JPEG is OK). */
export function isUntrustedLogoUrl (url: string): boolean {
  const lower = url.toLowerCase();
  if (/kindpng|pngaaa|pngtree|freepng|clipart|stickpng|cleanpng/iu.test(lower)) {
    return true;
  }
  if (/favicon|sprite|emoji|avatar/iu.test(lower)) {
    return true;
  }
  return false;
}

// ===== logo-vision-audit.mts =====
const DEFAULT_LOGO_VISION_MODEL = 'claude-haiku-4-5-20251001';

export function useLogoVisionAudit (): boolean {
  return process.env['CREATIVE_LOGO_VISION_AUDIT']?.trim() !== '0';
}

/** True when any blocker targets logos/ or a file under logos/. */
export function hasLogoBlockers (
  findings: readonly { severity: string; asset_id: string }[]
): boolean {
  return findings.some(
    (f) =>
      f.severity === 'blocker' &&
      (f.asset_id === 'logos' || f.asset_id.startsWith('logos/'))
  );
}

export type RunLogoVisionAuditOptions = {
  anthropicClient: Anthropic;
  directoryPath: string;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  reviewRound: number;
  model?: string;
  phase?: 'style_guide' | 'creative';
};

export async function runLogoVisionAudit (
  options: RunLogoVisionAuditOptions
): Promise<{ audit: AssetsReviewOutput; usage: AssetsReviewUsageTotals | null }> {
  if (!useLogoVisionAudit()) {
    console.log('[logo-vision-audit] Skipped (CREATIVE_LOGO_VISION_AUDIT=0).');
    return {
      audit: {
        satisfied: true,
        summary: 'Logo vision audit skipped.',
        findings: [],
        brave_retry_queries: { logos: [], products: [] }
      },
      usage: null
    };
  }

  const logoFiles = listAssetImageFiles(options.directoryPath, 'logos');
  if (logoFiles.length === 0) {
    return {
      audit: {
        satisfied: false,
        summary: 'No logo file in logos/ for vision audit.',
        findings: [
          {
            asset_id: 'logos',
            severity: 'blocker',
            issue: 'logos/ folder is empty — cannot validate brand wordmark.',
            fix_hint: 'Download the official header logo from companyURL/brandURL (SVG or PNG).'
          }
        ],
        brave_retry_queries: { logos: [], products: [] }
      },
      usage: null
    };
  }

  const model =
    options.model ??
    process.env['CREATIVE_LOGO_VISION_MODEL']?.trim() ??
    process.env['CREATIVE_ASSETS_REVIEW_MODEL']?.trim() ??
    DEFAULT_LOGO_VISION_MODEL;

  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        `Logo vision audit round ${String(options.reviewRound)}. ` +
        'Inspect each logo image and confirm it is the official brand wordmark lockup for the style guide below. ' +
        'SVG files are rasterized to PNG for this review.'
    }
  ];

  for (const fileName of logoFiles) {
    const filePath = join(options.directoryPath, 'logos', fileName);
    userContent.push({
      type: 'text',
      text: `Asset: logos/${fileName}`
    });
    if (!existsSync(filePath)) {
      userContent.push({ type: 'text', text: `(missing file: ${filePath})` });
      continue;
    }
    const block = await readLogoFileAsAnthropicImageBlock(filePath);
    if (block !== null) {
      userContent.push(block);
    } else {
      userContent.push({
        type: 'text',
        text: `(unreadable logo file: ${filePath})`
      });
    }
  }

  const brandName = options.prunedStyleGuide.brandName?.trim() ?? '';
  const companyName = options.prunedStyleGuide.companyName?.trim() ?? '';
  const brandContext = options.prunedStyleGuide.brandContext?.trim() ?? '';
  const collaborationCampaign = isCollaborationCampaign({
    brandName,
    companyName,
    ...(brandContext.length > 0 ? { brandContext } : {})
  });
  const brandLogoRelationship = resolveBrandLogoRelationship(brandName, companyName);
  const divisionLineBrand =
    !collaborationCampaign && brandLogoRelationship === 'division_line';
  const independentSubBrand =
    !collaborationCampaign && brandLogoRelationship === 'independent_sub_brand';
  const logoSearchNames = resolveLogoSearchNames({
    brandName,
    companyName,
    productName: options.prunedStyleGuide.productName?.trim() ?? '',
    ...(options.prunedStyleGuide.brandContext !== undefined
      ? { brandContext: options.prunedStyleGuide.brandContext }
      : {}),
    ...(options.prunedStyleGuide.campaignContext !== undefined
      ? { campaignContext: options.prunedStyleGuide.campaignContext }
      : {}),
    ...(options.prunedStyleGuide.campaignReferenceUrl !== undefined
      ? { campaignReferenceUrl: options.prunedStyleGuide.campaignReferenceUrl }
      : {})
  });

  const systemPrompt = [
    'You are a strict brand logo auditor before HTML5 ad code generation.',
    'You receive PNG screenshots of logo files plus a JSON style guide.',
    collaborationCampaign
      ? 'Evaluate whether each logos/ file is an official wordmark for a participating brand in this collaboration campaign.'
      : 'Evaluate whether each logos/ file is the SAME brand lockup as the official header on brandURL (campaign brand), not merely the parent retailer.',
    'Rules:',
    ...(collaborationCampaign
      ? buildCollaborationLogoAuditRules({
          brandName,
          companyName,
          ...(brandContext.length > 0 ? { brandContext } : {})
        })
      : []),
    ...(divisionLineBrand ? buildDivisionLineLogoAuditRules({ brandName, companyName }) : []),
    ...(independentSubBrand
      ? buildIndependentSubBrandLogoAuditRules({ brandName, companyName })
      : []),
    '- BLOCKER if the logo is a different brand, homonym, or unrelated acronym (e.g. "NET" TV network vs "Matériel.net" retailer).',
    ...(collaborationCampaign || divisionLineBrand
      ? []
      : [ '- BLOCKER if the logo does not display brandName or its recognizable official icon+wordmark.' ]),
    '- BLOCKER if colors/shape clearly contradict the style guide palette and known brand identity.',
    '- BLOCKER if the file is a product packshot, generic homonym wordmark, or third-party scraper asset.',
    '- BLOCKER if filename suggests wrong brand (e.g. NET_Logo_1970.svg for Matériel.net).',
    '- Accept official wordmarks on opaque dark/light backgrounds (Tier B PNG) when brand text/icon is clearly correct.',
    '- WARN only for minor padding/contrast issues when the brand identity is clearly correct.',
    'Set satisfied to true only when there are zero blocker findings.',
    `Logo search queries (brave_retry_queries.logos): use ONLY these allowed brand name(s): ${logoSearchNames.join(', ') || brandName}.`,
    '  * Combine with site:official_host from brandURL/companyURL and generic logo words (logo, wordmark, svg, transparent).',
    collaborationCampaign
      ? '  * For missing collaboration parties, use each party name separately — never combined co-branded lockup strings.'
      : '  * NEVER include productName, campaignContext, partner names (e.g. FFF), country/collection names, or campaign URL slugs in logo queries.',
    'products array must be empty.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(options.prunedStyleGuide)
  ].join('\n');

  console.log(
    `[logo-vision-audit] Round ${String(options.reviewRound)} — model ${model} (${String(logoFiles.length)} logo file(s))`
  );

  const roundStart = Date.now();
  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    `logo-vision-audit round ${String(options.reviewRound)}`,
    async () =>
      await withAnthropicRetry(`logo-vision-audit round ${String(options.reviewRound)}`, async () => {
        return await options.anthropicClient.messages.parse({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [ { role: 'user', content: userContent } ],
          output_config: {
            format: zodOutputFormat(assetsReviewOutputSchema)
          }
        });
      })
  );
  const stepDurationMs = Date.now() - roundStart;

  const parsed = msg.parsed_output;
  if (parsed === null) {
    throw new Error('Logo vision audit returned no structured output.');
  }

  const blockers = parsed.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0) {
    parsed.satisfied = false;
  }

  const billedInput =
    msg.usage.input_tokens +
    (msg.usage.cache_creation_input_tokens ?? 0) +
    (msg.usage.cache_read_input_tokens ?? 0);
  const price_usd: PriceUsd = priceUsdFromTokens(billedInput, msg.usage.output_tokens, model);

  const usage: AssetsReviewUsageTotals = {
    api_calls: 1,
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    model,
    billed_input_tokens: billedInput,
    price_usd,
    duration_ms: stepDurationMs
  };

  console.log(
    `[logo-vision-audit] satisfied=${String(parsed.satisfied)} blockers=${String(blockers.length)}`
  );
  logAssetsReviewAuditToConsole(parsed, options.reviewRound);

  const pipelineEntry = entryFromSingleUsage({
    action: 'logo_vision_audit',
    agent: 'lib/logo-vision-audit.mts',
    model,
    usage: msg.usage,
    review_round: options.reviewRound,
    duration_ms: stepDurationMs,
    phase: options.phase ?? 'style_guide',
    api_call_timings: [
      {
        call_index: 1,
        duration_ms: apiDurationMs,
        stop_reason: msg.stop_reason,
        label: `logo-vision-audit round ${String(options.reviewRound)}`
      }
    ]
  });
  logPipelineUsageToConsole(appendPipelineUsage(options.directoryPath, pipelineEntry).entries.at(-1)!);

  return { audit: parsed, usage };
}

export function mergeLogoVisionIntoAudit (
  base: AssetsReviewOutput,
  logoVision: AssetsReviewOutput
): AssetsReviewOutput {
  const seen = new Set<string>();
  const merged: AssetsReviewOutput['findings'] = [];

  for (const f of [ ...base.findings, ...logoVision.findings ]) {
    const key = `${f.asset_id}::${f.issue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(f);
  }

  const blockers = merged.filter((f) => f.severity === 'blocker');
  const satisfied = blockers.length === 0;
  const summaries = [ base.summary, logoVision.summary ].filter((s) => s.trim().length > 0);
  const summary = satisfied
    ? summaries.join(' ')
    : `Logo or asset audit failed: ${String(blockers.length)} blocker(s). ${summaries.join(' ')}`;

  const logos = [ ...logoVision.brave_retry_queries.logos, ...base.brave_retry_queries.logos ];
  const products = [ ...base.brave_retry_queries.products, ...logoVision.brave_retry_queries.products ];

  return {
    satisfied,
    summary,
    findings: merged,
    brave_retry_queries: {
      logos: [ ...new Set(logos) ],
      products: [ ...new Set(products) ]
    }
  };
}

// ===== official-site-logo-extract.mts =====
const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 2_500_000;

/** HTTP statuses that usually mean the site blocks automated fetch (not a transient 5xx). */
const CRAWL_BLOCKED_HTTP_STATUSES = new Set([ 401, 403, 406, 451 ]);

const FALLBACK_IMAGE_HOSTS = [ 'upload.wikimedia.org', 'wikimedia.org' ] as const;

type ScoredLogoUrl = { url: string; score: number; reason: string };

type PageFetchResult = {
  html: string | null;
  status: number | null;
  blocked: boolean;
};

const LOGO_CLASS_HINTS = [
  'menu-header__logo',
  'primary-logo',
  'logo-container',
  'logo-simple',
  'site-logo',
  'header-logo',
  'brand-logo',
  'main-logo',
  'nav-logo',
  'logo__image',
  'logo-image'
] as const;

const CAMPAIGN_LOGO_CLASS_MARKERS = [
  'tile-content__',
  'event-feed-card__',
  'distinctive-space',
  'tile-content__distinctive-space-logo'
] as const;

function classTokenIsBrandLogo (classToken: string): boolean {
  const token = classToken.toLowerCase();
  if (token === 'logo' || token === 'wordmark') {
    return true;
  }
  if (/^[\w-]+__logo(?:--|$)/u.test(token)) {
    return true;
  }
  for (const hint of LOGO_CLASS_HINTS) {
    if (token === hint || token.endsWith(`__${hint}`) || token.endsWith(`-${hint}`)) {
      return true;
    }
  }
  return false;
}

function classListHasBrandLogoClass (classList: string): boolean {
  return classList
    .toLowerCase()
    .split(/\s+/u)
    .some((token) => classTokenIsBrandLogo(token));
}

function classListHasCampaignLogoClass (classList: string): boolean {
  const lower = classList.toLowerCase();
  return CAMPAIGN_LOGO_CLASS_MARKERS.some((marker) => lower.includes(marker));
}

function classAttributeContainsHint (classAttr: string, hint: string): boolean {
  return classAttr
    .toLowerCase()
    .split(/\s+/u)
    .some((token) => token === hint || token.endsWith(`__${hint}`) || token.endsWith(`-${hint}`));
}

function isCanonicalBrandWordmarkUrl (url: string): boolean {
  const lower = url.toLowerCase();
  return (
    /redbullcom-logo|wordmark|double[-_]with[-_]text/u.test(lower) ||
    /\/v3\/resources\/images\/client\//u.test(lower) ||
    (/\/assets\/logos\//u.test(lower) && /\.svg($|[?#])/u.test(lower))
  );
}

function isCampaignEventLogoAssetUrl (url: string): boolean {
  const lower = url.toLowerCase();
  return /tile-content|event-feed|distinctive-space|king-of-the-mousse|bc-one-cypher|campaign[-_]|promo[-_]/u.test(
    lower
  );
}

function parseEnvEnabled (): boolean {
  return process.env['CREATIVE_OFFICIAL_LOGO_FETCH']?.trim() !== '0';
}

function parseFallbackEnabled (): boolean {
  return process.env['CREATIVE_OFFICIAL_FETCH_FALLBACK']?.trim() !== '0';
}

export function isCrawlBlockedHttpStatus (status: number): boolean {
  return CRAWL_BLOCKED_HTTP_STATUSES.has(status);
}

export function shouldSkipPageForBlockedHost (
  hostname: string,
  blockedHosts: ReadonlySet<string>
): boolean {
  const h = normalizeHost(hostname);
  return blockedHosts.has(h);
}

/** Registrable label before TLD (e.g. mercedes-benz.fr → mercedes-benz). */
export function brandDomainTokenFromHost (hostname: string): string | null {
  const h = normalizeHost(hostname);
  const parts = h.split('.').filter((p) => p.length > 0);
  if (parts.length < 2) {
    return parts[0] ?? null;
  }
  return parts[parts.length - 2] ?? null;
}

/** True when company site is the same host (or subdomain) as a primary reference/brand page. */
function companyUrlMatchesPrimaryHosts (
  companyUrl: string,
  primaryRefs: readonly string[]
): boolean {
  try {
    const companyHost = normalizeHost(new URL(companyUrl).hostname);
    for (const ref of primaryRefs) {
      const refHost = normalizeHost(new URL(ref).hostname);
      if (companyHost === refHost) {
        return true;
      }
      if (companyHost.endsWith(`.${refHost}`) || refHost.endsWith(`.${companyHost}`)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function officialLogoFallbackMax (): number {
  const raw = process.env['OFFICIAL_LOGO_FALLBACK_MAX']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 15;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** Stable key for deduping product URLs that differ only by resize query params. */
export function dedupeProductUrlKey (url: string): string {
  try {
    const u = new URL(url);
    const staticMatch =
      /\/images\/static\/v1\/[^/]+\/[^/]+\/[^/]+\/([^/?#]+)\.(jpe?g|png|webp)/iu.exec(u.pathname);
    if (staticMatch !== null && staticMatch[1] !== undefined) {
      return staticMatch[1].toLowerCase();
    }
    const base = u.pathname.split('/').filter((p) => p.length > 0).pop();
    if (base !== undefined && base.length > 0) {
      return base.toLowerCase();
    }
    return u.pathname;
  } catch {
    return url;
  }
}

export function isLowValueOfficialProductUrl (url: string): boolean {
  const lower = url.toLowerCase();
  if (isTextOnlyCategoryNavProductAsset(url)) {
    return true;
  }
  if (/\/iris\.png(\?|$)/iu.test(lower) || /resize,width=48/iu.test(lower)) {
    return true;
  }
  if (isOfficialSiteLogoAssetUrl(url)) {
    return true;
  }
  return false;
}

/** True when URL path looks like a brand header/wordmark asset, not a product hero. */
export function isOfficialSiteLogoAssetUrl (url: string): boolean {
  const lower = url.toLowerCase();
  return (
    /[-_]logo[-_.]|logo[-_]alt|logo_alt/iu.test(lower) ||
    /\/master\/home\/[^/]*logo|\/home\/[^/]*logo[-_]/iu.test(lower) ||
    /logo-petit|\/logo[./_-]|logo\.svg|wordmark|brand-logo|site-logo/iu.test(lower)
  );
}

/**
 * Wikimedia thumbnail → source file (e.g. …/thumb/…/File.svg/120px-File.svg.png → …/File.svg).
 */
export function upgradeWikimediaThumbToSourceUrl (url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/upload\.wikimedia\.org$/iu.test(parsed.hostname)) {
      return null;
    }
    const match =
      /^\/wikipedia\/([^/]+)\/thumb\/((?:[^/]+\/){2}[^/]+)\/(?:[\w-]+-)?\d+px-[^/]+$/iu.exec(
        parsed.pathname
      );
    if (match === null) {
      return null;
    }
    const lang = match[1];
    const filePath = match[2];
    if (lang === undefined || filePath === undefined) {
      return null;
    }
    return `https://upload.wikimedia.org/wikipedia/${lang}/${filePath}`;
  } catch {
    return null;
  }
}

/** Wikipedia article slug from brand or company name (spaces → underscores). */
export function wikipediaSlugFromBrandName (name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.replace(/\s+/gu, '_');
}

export function buildFallbackPageUrls (context: ImageSearchContext): string[] {
  const names = resolveLogoSearchNames(context);
  if (names.length === 0) {
    return [];
  }
  const urls: string[] = [];
  for (const label of names) {
    const slug = wikipediaSlugFromBrandName(label);
    if (slug.length === 0) {
      continue;
    }
    urls.push(
      `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`,
      `https://fr.wikipedia.org/wiki/${encodeURIComponent(slug)}`
    );
  }
  return [ ...new Set(urls) ];
}

function urlHostAllowedForFallbackImage (url: string): boolean {
  try {
    const h = normalizeHost(new URL(url).hostname);
    return FALLBACK_IMAGE_HOSTS.some(
      (fh) => h === fh || h.endsWith(`.${fh}`) || fh.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
}

function hostsFromContext (ctx: ImageSearchContext): string[] {
  const hosts: string[] = [];
  for (const raw of [
    ctx.campaignReferenceUrl,
    ctx.brandURL,
    ctx.companyURL
  ]) {
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    try {
      const h = normalizeHost(new URL(raw.trim()).hostname);
      if (!hosts.includes(h)) {
        hosts.push(h);
      }
    } catch {
      // skip
    }
  }
  return hosts;
}

/** Host allowlist for scrape / preflight (includes reference URL host). */
export function hostsFromImageContext (ctx: ImageSearchContext): string[] {
  return hostsFromContext(ctx);
}

function resolveAbsoluteUrl (basePageUrl: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('data:')) {
    return null;
  }
  try {
    if (trimmed.startsWith('//')) {
      return new URL(`https:${trimmed}`).href;
    }
    return new URL(trimmed, basePageUrl).href;
  } catch {
    return null;
  }
}

function urlHostAllowed (
  url: string,
  officialHosts: readonly string[],
  pageUrl?: string
): boolean {
  if (officialHosts.length === 0) {
    return true;
  }
  try {
    const h = normalizeHost(new URL(url).hostname);
    if (officialHosts.some((oh) => h === oh || h.endsWith(`.${oh}`) || oh.endsWith(`.${h}`))) {
      return true;
    }
    if (pageUrl !== undefined) {
      const token = brandDomainTokenFromHost(new URL(pageUrl).hostname);
      if (token !== null && token.length >= 4 && h.includes(token)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function scoreLogoUrl (
  url: string,
  hints: {
    classHint?: string;
    inHeader?: boolean;
    brandName?: string;
    isNavHeaderLogo?: boolean;
    isCampaignTileLogo?: boolean;
  }
): number {
  const lower = url.toLowerCase();
  let score = 0;

  if (hints.classHint !== undefined) {
    const idx = LOGO_CLASS_HINTS.indexOf(hints.classHint as (typeof LOGO_CLASS_HINTS)[number]);
    score += idx >= 0 ? 90 - idx * 3 : 40;
  }

  if (hints.inHeader === true) {
    score += 25;
  }

  if (hints.isNavHeaderLogo === true) {
    score += 95;
  }

  if (hints.isCampaignTileLogo === true) {
    score -= 110;
  }

  if (isCanonicalBrandWordmarkUrl(url)) {
    score += 130;
  }

  if (isCampaignEventLogoAssetUrl(url)) {
    score -= 95;
  }

  if (/\.svg($|[?#])/iu.test(lower)) {
    score += 35;
  } else if (/\.png($|[?#])/iu.test(lower)) {
    score += 20;
  }

  if (/\/logo|logo-|wordmark|brand-logo|site-logo/iu.test(lower)) {
    score += 18;
  }

  if (/\/assets\/logos\/(?:brand\/)?/iu.test(lower) || /\/global\/assets\/logos\//iu.test(lower)) {
    score += 75;
  }

  if (/logo-site|\/matnet\/logo\//iu.test(lower)) {
    score += 60;
  }

  const brand = hints.brandName?.trim() ?? '';
  if (brand.length > 0) {
    const brandToken = brand
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/\s+/gu, '');
    if (brandToken.length >= 4 && lower.includes(brandToken)) {
      score += 45;
    }
    const brandParts = brand
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^a-z0-9]+/u)
      .filter((t) => t.length >= 4);
    if (brandParts.some((t) => lower.includes(t))) {
      score += 25;
    }
  }

  if (/kungscissus|\/images\/kung|plant[-_]|decorative|campaign[-_]asset|startpage|thumbnail/iu.test(lower)) {
    score -= 90;
  }

  if (/favicon|apple-touch|sprite|icon-16|icon-32|emoji|avatar|1x1/iu.test(lower)) {
    score -= 120;
  }

  if (isUntrustedLogoUrl(url)) {
    score -= 500;
  }

  return score;
}

function extractLogoAssetPathsFromHeaderHtml (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[],
  bucket: Map<string, ScoredLogoUrl>,
  brandName = ''
): void {
  const headerSlice = html.slice(0, Math.min(html.length, 160_000));
  const attrRe = /(?:href|src|content)\s*=\s*["']([^"']+)["']/giu;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(headerSlice)) !== null) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const lower = raw.toLowerCase();
    const isBrandLogoAsset =
      (/\.(svg|png|jpe?g|webp)($|[?#])/iu.test(lower) &&
        (/\/assets\/logos\//iu.test(lower) ||
          /\/logo|wordmark|brand-logo|logo-site|\/matnet\/logo\//iu.test(lower))) ||
      /(?:^|[/_.-])logo(?:[._-]|\.)/iu.test(lower) ||
      /\/v3\/resources\/images\/client\//iu.test(lower);
    if (!isBrandLogoAsset) {
      continue;
    }
    pushCandidate(bucket, pageUrl, raw, officialHosts, {
      inHeader: true,
      classHint: 'brand-logo-path',
      brandName
    });
  }
}

function extractSrcFromImgTag (tag: string): string | null {
  const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/iu);
  if (srcMatch !== null && srcMatch[1] !== undefined) {
    return srcMatch[1];
  }
  const srcsetMatch = tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/iu);
  if (srcsetMatch !== null && srcsetMatch[1] !== undefined) {
    const first = srcsetMatch[1].split(',')[0]?.trim().split(/\s+/u)[0];
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  for (const attr of [ 'data-src', 'data-lazy-src', 'data-original' ] as const) {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'iu'));
    if (m !== null && m[1] !== undefined) {
      return m[1];
    }
  }
  return null;
}

function classListFromTag (tag: string): string {
  const m = tag.match(/\bclass\s*=\s*["']([^"']+)["']/iu);
  return m?.[1]?.toLowerCase() ?? '';
}

function pushCandidate (
  bucket: Map<string, ScoredLogoUrl>,
  pageUrl: string,
  rawSrc: string,
  officialHosts: readonly string[],
  hints: {
    classHint?: string;
    inHeader?: boolean;
    brandName?: string;
    isNavHeaderLogo?: boolean;
    isCampaignTileLogo?: boolean;
  }
): void {
  const absolute = resolveAbsoluteUrl(pageUrl, rawSrc);
  if (absolute === null || !/^https?:\/\//iu.test(absolute)) {
    return;
  }
  if (!urlHostAllowed(absolute, officialHosts, pageUrl)) {
    return;
  }
  const score = scoreLogoUrl(absolute, hints);
  if (score < 10) {
    return;
  }
  const existing = bucket.get(absolute);
  if (existing === undefined || score > existing.score) {
    bucket.set(absolute, {
      url: absolute,
      score,
      reason: hints.classHint ?? (hints.inHeader === true ? 'header' : 'img.logo')
    });
  }
}

function isFilmMicrositePage (pageUrl: string): boolean {
  try {
    return new URL(pageUrl).hostname.toLowerCase().endsWith('.film');
  } catch {
    return false;
  }
}

function extractOgImageCandidates (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[],
  bucket: Map<string, ScoredLogoUrl>,
  options: { brandName?: string; scoreBoost?: number; classHint?: string }
): void {
  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src === undefined) {
      continue;
    }
    pushCandidate(bucket, pageUrl, src, officialHosts, {
      classHint: options.classHint ?? 'og:image',
      ...(options.brandName !== undefined ? { brandName: options.brandName } : {}),
      inHeader: true
    });
    const absolute = resolveAbsoluteUrl(pageUrl, src);
    if (absolute !== null) {
      const existing = bucket.get(absolute);
      if (existing !== undefined && options.scoreBoost !== undefined) {
        bucket.set(absolute, {
          ...existing,
          score: existing.score + options.scoreBoost
        });
      }
    }
  }
}

/** Parse homepage HTML for header lockup patterns (primary-logo, logo-container, img.logo-simple, etc.). */
export function extractLogoCandidatesFromHtml (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[],
  options?: { brandName?: string }
): ScoredLogoUrl[] {
  const bucket = new Map<string, ScoredLogoUrl>();
  const brandName = options?.brandName?.trim() ?? '';

  if (isFilmMicrositePage(pageUrl)) {
    extractOgImageCandidates(html, pageUrl, officialHosts, bucket, {
      brandName,
      scoreBoost: 80,
      classHint: 'film-og:title-treatment'
    });
  }

  extractLogoAssetPathsFromHeaderHtml(html, pageUrl, officialHosts, bucket, brandName);

  const navLockupRe =
    /<a\b[^>]*\bclass=["'][^"']*logo-container[^"']*["'][^>]*>[\s\S]{0,1200}?<img\b[^>]+>/giu;
  let navLockupMatch: RegExpExecArray | null;
  while ((navLockupMatch = navLockupRe.exec(html)) !== null) {
    const block = navLockupMatch[0];
    const imgMatch = block.match(/<img\b[^>]+>/iu);
    if (imgMatch !== null) {
      const src = extractSrcFromImgTag(imgMatch[0]);
      if (src !== null) {
        pushCandidate(bucket, pageUrl, src, officialHosts, {
          classHint: 'logo-container',
          inHeader: true,
          isNavHeaderLogo: true,
          brandName
        });
      }
    }
  }

  for (const hint of LOGO_CLASS_HINTS) {
    const containerRe = new RegExp(
      `<(?:div|a|span|figure)\\b[^>]*\\bclass=["']([^"']+)["'][^>]*>[\\s\\S]{0,4000}?<img\\b[^>]+>`,
      'giu'
    );
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = containerRe.exec(html)) !== null) {
      const classAttr = blockMatch[1] ?? '';
      if (!classAttributeContainsHint(classAttr, hint)) {
        continue;
      }
      const block = blockMatch[0];
      const imgMatch = block.match(/<img\b[^>]+>/iu);
      if (imgMatch !== null) {
        const src = extractSrcFromImgTag(imgMatch[0]);
        if (src !== null) {
          pushCandidate(bucket, pageUrl, src, officialHosts, {
            classHint: hint,
            inHeader: true,
            isNavHeaderLogo: hint === 'menu-header__logo' || hint === 'logo-container',
            brandName
          });
        }
      }
    }
  }

  const imgTagRe = /<img\b[^>]*>/giu;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgTagRe.exec(html)) !== null) {
    const tag = imgMatch[0];
    const classes = classListFromTag(tag);
    if (!classListHasBrandLogoClass(classes) && !/\bwordmark\b/iu.test(classes)) {
      continue;
    }
    const src = extractSrcFromImgTag(tag);
    if (src === null) {
      continue;
    }
    const isNavHeaderLogo = classAttributeContainsHint(classes, 'menu-header__logo');
    const isCampaignTileLogo = classListHasCampaignLogoClass(classes);
    let classHint: string | undefined;
    for (const hint of LOGO_CLASS_HINTS) {
      if (classAttributeContainsHint(classes, hint)) {
        classHint = hint;
        break;
      }
    }
    const pos = imgMatch.index ?? 0;
    const headerSlice = html.slice(Math.max(0, pos - 8000), pos + 200);
    const inHeader =
      isNavHeaderLogo ||
      /<header\b/iu.test(headerSlice) ||
      classAttributeContainsHint(headerSlice, 'primary-logo') ||
      classAttributeContainsHint(headerSlice, 'menu-header__logo');
    pushCandidate(
      bucket,
      pageUrl,
      src,
      officialHosts,
      {
        ...(classHint !== undefined ? { classHint } : {}),
        ...(inHeader ? { inHeader: true } : {}),
        ...(isNavHeaderLogo ? { isNavHeaderLogo: true } : {}),
        ...(isCampaignTileLogo ? { isCampaignTileLogo: true } : {}),
        brandName
      }
    );
  }

  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

export async function fetchOfficialPageHtml (
  url: string,
  logTag: string
): Promise<PageFetchResult> {
  return fetchPageHtmlDetailed(url, logTag);
}

async function fetchPageHtmlDetailed (url: string, logTag: string): Promise<PageFetchResult> {
  try {
    const res = await fetch(url, {
      headers: officialPageFetchHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
      const blocked = isCrawlBlockedHttpStatus(res.status);
      const suffix = blocked ? ' — crawler blocked, fallback sources may be used' : '';
      console.warn(`[${logTag}] HTTP ${String(res.status)} for ${url}${suffix}`);
      return { html: null, status: res.status, blocked };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const html =
      buf.length > MAX_HTML_BYTES
        ? buf.subarray(0, MAX_HTML_BYTES).toString('utf8')
        : buf.toString('utf8');
    return { html, status: res.status, blocked: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${logTag}] Fetch failed ${url}: ${msg}`);
    return { html: null, status: null, blocked: false };
  }
}

function pushOfficialScrapeUrls (pageUrls: string[], raw: string): void {
  const u = new URL(raw.trim());
  const href = u.href;
  const originRoot = `${u.origin}/`;
  const path = u.pathname.replace(/\/+$/u, '') || '/';
  const isDeepPage = path !== '/' && path.length > 1;
  if (isDeepPage) {
    pageUrls.push(href);
    if (!pageUrls.includes(originRoot)) {
      pageUrls.push(originRoot);
    }
  } else {
    pageUrls.push(originRoot);
    pageUrls.push(href);
  }
}

export function officialPageUrlsFromContext (context: ImageSearchContext): string[] {
  const pageUrls: string[] = [];
  const primaryRefs = [
    context.campaignReferenceUrl,
    context.brandURL,
    ...(context.campaignUrls ?? [])
  ].filter((u): u is string => u !== undefined && u.trim().length > 0);

  const rawUrls: (string | undefined)[] = [
    context.brandURL,
    context.campaignReferenceUrl,
    ...(context.campaignUrls ?? [])
  ];
  const companyUrl = context.companyURL?.trim() ?? '';
  const brandUrl = context.brandURL?.trim() ?? '';
  if (companyUrl.length > 0) {
    const skipCompany =
      primaryRefs.length > 0 && !companyUrlMatchesPrimaryHosts(companyUrl, primaryRefs);
    const sameAsBrand =
      brandUrl.length > 0 &&
      companyUrl.replace(/\/+$/u, '').toLowerCase() === brandUrl.replace(/\/+$/u, '').toLowerCase();
    if (!skipCompany && !sameAsBrand) {
      rawUrls.push(context.companyURL);
    } else if (!skipCompany && sameAsBrand && !rawUrls.includes(context.companyURL)) {
      rawUrls.push(context.companyURL);
    }
  }
  for (const raw of rawUrls) {
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    try {
      pushOfficialScrapeUrls(pageUrls, raw);
    } catch {
      // skip
    }
  }
  return [ ...new Set(pageUrls) ];
}

export function officialProductMaxCandidates (minimum = 0): number {
  const raw = process.env['OFFICIAL_PRODUCT_MAX_CANDIDATES']?.trim();
  const fallback = minimum > 0 ? minimum : 8;
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.max(n, minimum);
}

export type OfficialProductCandidate = {
  url: string;
  sourcePageUrl: string;
  fromReferencePage: boolean;
};

type ScoredProductCandidate = ScoredLogoUrl & {
  sourcePageUrl: string;
  fromReferencePage: boolean;
};

function mergeCandidates (allCandidates: ScoredLogoUrl[]): string[] {
  const byUrl = new Map<string, ScoredLogoUrl>();
  for (const c of allCandidates) {
    const prev = byUrl.get(c.url);
    if (prev === undefined || c.score > prev.score) {
      byUrl.set(c.url, c);
    }
  }
  return [ ...byUrl.values() ]
    .sort((a, b) => b.score - a.score)
    .map((c) => c.url);
}

function mergeOfficialProductCandidates (
  allCandidates: ScoredProductCandidate[]
): OfficialProductCandidate[] {
  const byKey = new Map<string, ScoredProductCandidate>();
  for (const c of allCandidates) {
    const key = dedupeProductUrlKey(c.url);
    const prev = byKey.get(key);
    if (
      prev === undefined ||
      c.score > prev.score ||
      (c.fromReferencePage && !prev.fromReferencePage)
    ) {
      byKey.set(key, c);
    }
  }
  const byUrl = byKey;
  return [ ...byUrl.values() ]
    .sort((a, b) => {
      if (a.fromReferencePage !== b.fromReferencePage) {
        return a.fromReferencePage ? -1 : 1;
      }
      return b.score - a.score;
    })
    .map((c) => ({
      url: c.url,
      sourcePageUrl: c.sourcePageUrl,
      fromReferencePage: c.fromReferencePage
    }));
}

async function scrapePagesForCandidates (params: {
  pageUrls: readonly string[];
  logTag: string;
  allowedHosts: readonly string[];
  extract: (html: string, pageUrl: string, hosts: readonly string[]) => ScoredLogoUrl[];
  /** Extra score for images found on these pages (campaign reference / collection URL). */
  boostPageUrls?: readonly string[];
}): Promise<{ candidates: ScoredLogoUrl[]; allOfficialBlocked: boolean }>;
async function scrapePagesForCandidates (params: {
  pageUrls: readonly string[];
  logTag: string;
  allowedHosts: readonly string[];
  extract: (html: string, pageUrl: string, hosts: readonly string[]) => ScoredLogoUrl[];
  boostPageUrls?: readonly string[];
  withProvenance?: true;
}): Promise<{
  candidates: ScoredProductCandidate[];
  allOfficialBlocked: boolean;
}>;
async function scrapePagesForCandidates (params: {
  pageUrls: readonly string[];
  logTag: string;
  allowedHosts: readonly string[];
  extract: (html: string, pageUrl: string, hosts: readonly string[]) => ScoredLogoUrl[];
  boostPageUrls?: readonly string[];
  withProvenance?: boolean;
}): Promise<{
  candidates: ScoredLogoUrl[] | ScoredProductCandidate[];
  allOfficialBlocked: boolean;
}> {
  const seenPages = new Set<string>();
  const blockedHosts = new Set<string>();
  const skippedBlockedHosts = new Set<string>();
  const allCandidates: ScoredProductCandidate[] = [];
  let hadFetch = false;
  let allBlocked = true;
  let gotHtml = false;
  const quietLog = /wikipedia/iu.test(params.logTag);
  const logScoreMin = quietLog ? 70 : 0;
  let loggedOnPage = 0;

  for (const pageUrl of params.pageUrls) {
    if (seenPages.has(pageUrl)) {
      continue;
    }
    seenPages.add(pageUrl);
    let pageHost: string;
    try {
      pageHost = normalizeHost(new URL(pageUrl).hostname);
    } catch {
      continue;
    }
    if (shouldSkipPageForBlockedHost(pageHost, blockedHosts)) {
      if (!skippedBlockedHosts.has(pageHost)) {
        skippedBlockedHosts.add(pageHost);
        console.log(`[${params.logTag}] Skipping ${pageHost} (crawler blocked earlier)`);
      }
      continue;
    }
    hadFetch = true;
    loggedOnPage = 0;
    console.log(`[${params.logTag}] Fetching: ${pageUrl}`);
    const { html, blocked } = await fetchPageHtmlDetailed(pageUrl, params.logTag);
    if (blocked) {
      blockedHosts.add(pageHost);
    }
    if (!blocked) {
      allBlocked = false;
    }
    if (html === null || html.length < 200) {
      continue;
    }
    gotHtml = true;
    const found = params.extract(html, pageUrl, params.allowedHosts);
    const boosted =
      params.boostPageUrls?.some((ref) => pageUrlsMatchForBoost(ref, pageUrl)) === true;
    for (const c of found) {
      const score = boosted ? c.score + 50 : c.score;
      const reason = boosted ? `${c.reason}+reference-page` : c.reason;
      if (score >= logScoreMin || loggedOnPage < 5) {
        console.log(`[${params.logTag}]   score=${String(score)} ${reason} → ${c.url}`);
        loggedOnPage += 1;
      }
      allCandidates.push({
        url: c.url,
        score,
        reason,
        sourcePageUrl: pageUrl,
        fromReferencePage: boosted
      });
    }
  }

  const allOfficialBlocked = hadFetch && allBlocked && !gotHtml;
  if (params.withProvenance === true) {
    return { candidates: allCandidates, allOfficialBlocked };
  }
  return {
    candidates: allCandidates.map(({ url, score, reason }) => ({ url, score, reason })),
    allOfficialBlocked
  };
}

/** Score boost when a Wikimedia logo URL suggests a recent rebrand (current year ± few years). */
function wikipediaRecentLogoYearBoost (urlLower: string): number {
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 5; y--) {
    if (urlLower.includes(String(y))) {
      return 40;
    }
  }
  if (/new[-_]?lion|shield/iu.test(urlLower)) {
    return 40;
  }
  return 0;
}

/** Wikipedia / Wikimedia: infobox image, og:image, logo filenames on upload.wikimedia.org. */
export function extractFallbackLogoCandidatesFromHtml (
  html: string,
  pageUrl: string
): ScoredLogoUrl[] {
  const bucket = new Map<string, ScoredLogoUrl>();

  const push = (rawSrc: string, score: number, reason: string): void => {
    const absolute = resolveAbsoluteUrl(pageUrl, rawSrc);
    if (absolute === null || !urlHostAllowedForFallbackImage(absolute)) {
      return;
    }
    const lower = absolute.toLowerCase();
    let s = score;
    if (/\.svg($|[?#])/iu.test(lower)) {
      s += 30;
    } else if (/\.png($|[?#])/iu.test(lower)) {
      s += 15;
    }
    if (/\/logo|wordmark|brand[_-]?logo/iu.test(lower)) {
      s += 25;
    }
    if (/[_-]logo(?:[._-]|$)/iu.test(lower)) {
      s += 25;
    }
    s += wikipediaRecentLogoYearBoost(lower);
    if (/depuis_2010|first_logo|logo_1810|logo_depuis/iu.test(lower)) {
      s -= 100;
    }
    if (/\/thumb\//iu.test(lower) || /\d+px-/iu.test(lower)) {
      s -= 30;
    }
    if (isUntrustedLogoUrl(absolute)) {
      s -= 400;
    }
    if (s < 10) {
      return;
    }
    const prev = bucket.get(absolute);
    if (prev === undefined || s > prev.score) {
      bucket.set(absolute, { url: absolute, score: s, reason });
    }
  };

  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src !== undefined) {
      push(src, 40, 'wikipedia-og:image');
    }
  }

  const infoboxImgRe =
    /<table[^>]*class="[^"]*\binfobox\b[^"]*"[^>]*>[\s\S]*?<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let infoboxMatch: RegExpExecArray | null;
  while ((infoboxMatch = infoboxImgRe.exec(html)) !== null) {
    const src = infoboxMatch[1];
    if (src !== undefined) {
      push(src, 55, 'wikipedia-infobox');
    }
  }

  const imgTagRe = /<img\b[^>]*>/giu;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgTagRe.exec(html)) !== null) {
    const tag = imgMatch[0];
    const src = extractSrcFromImgTag(tag);
    if (src === null) {
      continue;
    }
    if (!/upload\.wikimedia\.org|wikimedia\.org/iu.test(src)) {
      continue;
    }
    push(src, 35, 'wikipedia-img');
  }

  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

function extractProductCandidatesFromHtmlAllowingFallback (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[]
): ScoredLogoUrl[] {
  const fromOfficial = extractProductCandidatesFromHtml(html, pageUrl, officialHosts);
  if (fromOfficial.length > 0) {
    return fromOfficial;
  }
  const bucket = new Map<string, ScoredLogoUrl>();
  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src === undefined) {
      continue;
    }
    const absolute = resolveAbsoluteUrl(pageUrl, src);
    if (absolute === null || !urlHostAllowedForFallbackImage(absolute)) {
      continue;
    }
    const score = scoreProductImageUrl(absolute) + 10;
    if (score >= 10) {
      bucket.set(absolute, { url: absolute, score, reason: 'fallback-og:image' });
    }
  }
  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

/** Header logo URLs from brandURL / companyURL only (no Wikipedia). */
export async function extractOfficialSiteLogoUrls (context: ImageSearchContext): Promise<string[]> {
  if (!parseEnvEnabled()) {
    return [];
  }

  const officialHosts = hostsFromContext(context);
  const brandName = context.brandName?.trim() ?? '';
  const { candidates } = await scrapePagesForCandidates({
    pageUrls: officialPageUrlsFromContext(context),
    logTag: 'official-logo',
    allowedHosts: officialHosts,
    extract: (html, pageUrl, hosts) =>
      extractLogoCandidatesFromHtml(html, pageUrl, hosts, { brandName })
  });

  return mergeCandidates(candidates);
}

function mergeCandidatesCapped (allCandidates: ScoredLogoUrl[], max: number): string[] {
  return mergeCandidates(allCandidates).slice(0, max);
}

/** Logo URLs from Wikipedia / Wikimedia (used when official site has no valid transparent asset). */
export async function extractWikipediaLogoUrls (context: ImageSearchContext): Promise<string[]> {
  if (!parseEnvEnabled() || !parseFallbackEnabled()) {
    return [];
  }

  const officialHosts = hostsFromContext(context);
  console.log('[official-logo] Wikipedia / Wikimedia fallback…');
  const { candidates } = await scrapePagesForCandidates({
    pageUrls: buildFallbackPageUrls(context),
    logTag: 'official-logo-wikipedia',
    allowedHosts: officialHosts,
    extract: (html, pageUrl) => extractFallbackLogoCandidatesFromHtml(html, pageUrl)
  });

  return mergeCandidatesCapped(candidates, officialLogoFallbackMax());
}

function scoreProductImageUrl (url: string): number {
  const lower = url.toLowerCase();
  let score = 20;
  if (isLowValueOfficialProductUrl(url)) {
    score -= 50;
  }
  if (/\.(jpe?g|png|webp)(\?|$)/iu.test(lower)) {
    score += 30;
  }
  if (/\/dw\/image\//iu.test(lower)) {
    score += 40;
  }
  if (/product|packshot|hero|catalogue|media|cdn/iu.test(lower)) {
    score += 15;
  }
  if (isOfficialSiteLogoAssetUrl(url)) {
    score -= 120;
  }
  if (isUntrustedLogoUrl(url)) {
    score -= 400;
  }
  return score;
}

export function extractProductCandidatesFromHtml (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[]
): ScoredLogoUrl[] {
  const bucket = new Map<string, ScoredLogoUrl>();

  const ogBoost = isFilmMicrositePage(pageUrl) ? 60 : 0;
  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src === undefined) {
      continue;
    }
    const absolute = resolveAbsoluteUrl(pageUrl, src);
    if (absolute === null || !urlHostAllowed(absolute, officialHosts, pageUrl)) {
      continue;
    }
    const score = scoreProductImageUrl(absolute) + ogBoost;
    if (score >= 10) {
      bucket.set(absolute, {
        url: absolute,
        score,
        reason: isFilmMicrositePage(pageUrl) ? 'film-og:image' : 'og:image'
      });
    }
  }

  const imgAttrRe =
    /<img[^>]+(?:src|data-src|data-lazy)\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgAttrRe.exec(html)) !== null) {
    const src = imgMatch[1];
    if (src === undefined) {
      continue;
    }
    const absolute = resolveAbsoluteUrl(pageUrl, src);
    if (absolute === null || !urlHostAllowed(absolute, officialHosts, pageUrl)) {
      continue;
    }
    let score = scoreProductImageUrl(absolute);
    if (/\/dw\/image\//iu.test(absolute)) {
      score += 35;
    }
    if (score >= 15) {
      const prev = bucket.get(absolute);
      if (prev === undefined || score > prev.score) {
        bucket.set(absolute, { url: absolute, score, reason: 'grid-img' });
      }
    }
  }

  const jsonLdRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = jsonLdRe.exec(html)) !== null) {
    const raw = ldMatch[1]?.trim();
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    try {
      const data: unknown = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [ data ];
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) {
          continue;
        }
        const rec = node as Record<string, unknown>;
        const type = String(rec['@type'] ?? '');
        if (!/product/iu.test(type)) {
          continue;
        }
        const image = rec['image'];
        const urls: string[] = [];
        if (typeof image === 'string') {
          urls.push(image);
        } else if (Array.isArray(image)) {
          for (const item of image) {
            if (typeof item === 'string') {
              urls.push(item);
            } else if (typeof item === 'object' && item !== null && typeof (item as { url?: unknown }).url === 'string') {
              urls.push((item as { url: string }).url);
            }
          }
        } else if (typeof image === 'object' && image !== null && typeof (image as { url?: unknown }).url === 'string') {
          urls.push((image as { url: string }).url);
        }
        for (const src of urls) {
          const absolute = resolveAbsoluteUrl(pageUrl, src);
          if (absolute === null || !urlHostAllowed(absolute, officialHosts, pageUrl)) {
            continue;
          }
          const score = scoreProductImageUrl(absolute) + 25;
          bucket.set(absolute, { url: absolute, score, reason: 'json-ld-product' });
        }
      }
    } catch {
      // skip invalid JSON-LD
    }
  }

  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

/**
 * Fetch brandURL / companyURL and extract product hero candidates (og:image, JSON-LD Product).
 * On official HTTP 403, falls back to Wikipedia lead image (og:image on Wikimedia).
 */
export async function extractOfficialProductImageUrls (
  context: ImageSearchContext,
  options?: { minimumCandidates?: number }
): Promise<OfficialProductCandidate[]> {
  if (!parseEnvEnabled()) {
    return [];
  }

  if (context.campaignReferenceUrl !== undefined && context.campaignReferenceUrl.trim().length > 0) {
    console.log(`[official-product] Trying reference URL first: ${context.campaignReferenceUrl}`);
  }

  const officialHosts = hostsFromContext(context);
  const boostPageUrls = [
    context.campaignReferenceUrl,
    ...(context.campaignUrls ?? []),
    context.brandURL
  ].filter((u): u is string => u !== undefined && u.trim().length > 0);

  const { candidates, allOfficialBlocked } = await scrapePagesForCandidates({
    pageUrls: officialPageUrlsFromContext(context),
    logTag: 'official-product',
    allowedHosts: officialHosts,
    extract: extractProductCandidatesFromHtml,
    boostPageUrls,
    withProvenance: true
  });

  let allCandidates = candidates;
  const listingWithReference =
    resolveReferenceListingUrls({
      ...(context.campaignReferenceUrl !== undefined && context.campaignReferenceUrl.trim().length > 0
        ? { campaignReferenceUrl: context.campaignReferenceUrl }
        : {}),
      ...(context.campaignUrls !== undefined && context.campaignUrls.length > 0
        ? { campaignUrls: context.campaignUrls }
        : {})
    }).length > 0;

  if (listingWithReference && (allOfficialBlocked || allCandidates.length === 0)) {
    console.log(
      '[official-product] Listing reference URL set — skipping Wikipedia product fallback.'
    );
  }

  const needFallback = shouldUseWikipediaProductFallback(context, {
    allOfficialBlocked,
    candidateCount: allCandidates.length
  });

  if (needFallback) {
    console.log(
      '[official-product] Official site blocked or empty — trying Wikipedia fallback (og:image)…'
    );
    const fallback = await scrapePagesForCandidates({
      pageUrls: buildFallbackPageUrls(context),
      logTag: 'official-product-fallback',
      allowedHosts: officialHosts,
      extract: extractProductCandidatesFromHtmlAllowingFallback,
      withProvenance: true
    });
    allCandidates = [ ...allCandidates, ...fallback.candidates ];
  }

  const minCandidates = options?.minimumCandidates ?? 0;
  return mergeOfficialProductCandidates(allCandidates).slice(
    0,
    officialProductMaxCandidates(minCandidates)
  );
}

/** Whether Wikipedia og:image fallback may run for product heroes. */
export function shouldUseWikipediaProductFallback (
  context: ImageSearchContext,
  state: { allOfficialBlocked: boolean; candidateCount: number }
): boolean {
  const listingWithReference =
    resolveReferenceListingUrls({
      ...(context.campaignReferenceUrl !== undefined && context.campaignReferenceUrl.trim().length > 0
        ? { campaignReferenceUrl: context.campaignReferenceUrl }
        : {}),
      ...(context.campaignUrls !== undefined && context.campaignUrls.length > 0
        ? { campaignUrls: context.campaignUrls }
        : {})
    }).length > 0;
  return (
    parseFallbackEnabled() &&
    !listingWithReference &&
    (state.allOfficialBlocked || state.candidateCount === 0)
  );
}

// ===== brave-image-assets.mts =====
export interface BraveImageResult {
  type: 'image_result';
  title: string;
  url: string;
  source: string;
  page_fetched: string;
  thumbnail: { src: string; width?: number; height?: number };
  properties: {
    url: string;
    placeholder: string;
    width?: number;
    height?: number;
  };
  meta_url: {
    scheme: string;
    netloc: string;
    hostname: string;
    favicon: string;
    path: string;
  };
}

interface BraveImageSearchResponse {
  type: 'images';
  query: {
    original: string;
    altered?: string;
    spellcheck_off?: boolean;
    show_strict_warning?: boolean;
  };
  results: BraveImageResult[];
}

export const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml'
]);

export const mimeTypeToExtension: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg'
};

export interface ImageSearchContext {
  brandName: string;
  companyName: string;
  productName: string;
  brandContext?: string;
  brandURL?: string;
  companyURL?: string;
  logoImageSearchQueries?: string[];
  productImageSearchQueries?: string[];
  campaignContext?: string;
  /** HTTPS URLs extracted from the user prompt (collection pages, etc.). */
  campaignUrls?: readonly string[];
  /** User-provided campaign/collection page — scraped before brandURL. */
  campaignReferenceUrl?: string;
  productMatchTerms?: readonly string[];
}

export function imageContextFromStyleGuide (styleGuide: {
  brandName: string;
  companyName: string;
  productName: string;
  brandURL: string;
  companyURL: string;
  brandContext?: string | undefined;
  campaignContext?: string | undefined;
  campaignUrls?: readonly string[] | undefined;
  campaignReferenceUrl?: string | undefined;
  logoImageSearchQueries?: string[] | undefined;
  productImageSearchQueries?: string[] | undefined;
}): ImageSearchContext {
  const campaignContext = styleGuide.campaignContext?.trim() ?? '';
  const productMatchTerms = buildProductMatchTerms({
    campaignContext: campaignContext.length > 0 ? campaignContext : null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    ...(styleGuide.brandContext !== undefined ? { brandContext: styleGuide.brandContext } : {}),
    brandURL: styleGuide.brandURL
  });
  const campaignUrls = styleGuide.campaignUrls?.filter((u) => u.length > 0) ?? [];
  const brandContext = styleGuide.brandContext?.trim() ?? '';
  return {
    brandName: styleGuide.brandName,
    companyName: styleGuide.companyName,
    productName: styleGuide.productName,
    brandURL: styleGuide.brandURL,
    companyURL: styleGuide.companyURL,
    ...(brandContext.length > 0 ? { brandContext } : {}),
    logoImageSearchQueries: styleGuide.logoImageSearchQueries ?? [],
    productImageSearchQueries: styleGuide.productImageSearchQueries ?? [],
    ...(campaignContext.length > 0 ? { campaignContext } : {}),
    ...(campaignUrls.length > 0 ? { campaignUrls } : {}),
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {}),
    ...(productMatchTerms.length > 0 ? { productMatchTerms } : {})
  };
}

function parseEnvInt (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function braveProductCandidatePool (): number {
  return parseEnvInt('BRAVE_PRODUCT_CANDIDATE_POOL', 20);
}

export function braveProductTargetCount (): number {
  return parseEnvInt('BRAVE_PRODUCT_TARGET_COUNT', 5);
}

export function braveProductMinContentLength (): number {
  return parseEnvInt('BRAVE_PRODUCT_MIN_CONTENT_LENGTH', 30_000);
}

export function braveLogoCandidatePool (): number {
  return parseEnvInt('BRAVE_LOGO_CANDIDATE_POOL', 30);
}

export function braveProductMinReportedWidth (): number {
  return parseEnvInt('BRAVE_PRODUCT_MIN_REPORTED_W', 400);
}

export function braveProductMinReportedHeight (): number {
  return parseEnvInt('BRAVE_PRODUCT_MIN_REPORTED_H', 300);
}

function assetMinDimensions (fileType: 'logos' | 'products'): { minW: number; minH: number } {
  if (fileType === 'logos') {
    return {
      minW: parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_W', 1),
      minH: parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_H', 1)
    };
  }
  return {
    minW: parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_W', 1),
    minH: parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_H', 1)
  };
}

const LOW_RES_URL_PATTERNS: RegExp[] = [
  /thumb(?:v\d+)?/i,
  /thumbnail/i,
  /\bicon\b/i,
  /favicon/i,
  /sprite/i,
  /avatar/i,
  /\/small\//i,
  /\b50x\d+/i,
  /\b100x\d+/i,
  /wallpaper-\d+-thumb/i,
  /screenshot\/[^/]*thumb/i,
  /\.jpg_v_/i,
  /gaming-cdn\.com\/images\/products\/\d+\/screenshot\/.*thumb/i
];

export function isLikelyLowResolutionImageUrl (url: string): boolean {
  const lower = url.toLowerCase();
  return LOW_RES_URL_PATTERNS.some((pattern) => pattern.test(lower));
}

export function sanitizeAssetFilename (name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Basename from URL pathname (ignores query string — Demandware `*.jpg?sw=800`). */
export function fileNameFromImageUrl (fileUrl: string): string {
  try {
    const pathBase = basename(new URL(fileUrl).pathname);
    if (pathBase.length > 0 && pathBase !== '/') {
      return sanitizeAssetFilename(pathBase);
    }
  } catch {
    // fall through
  }
  const raw = basename(fileUrl.split('?')[0] ?? fileUrl);
  return sanitizeAssetFilename(raw);
}

export async function downloadFileToFileSystem (url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: officialImageFetchHeaders()
  });

  if (!response.ok) {
    throw new Error(`Downloading of file at URL: ${url} failed with status: ${response.status}`);
  }

  const body = response.body;

  if (body === null) {
    throw new Error(`Downloading of file at URL: ${url} returned empty body`);
  }

  const fileFetchStream = Readable.fromWeb(body);
  const fileWriteStream = createWriteStream(destinationPath);
  await pipeline(fileFetchStream, fileWriteStream);
}

function parseImageMetadataFromResponse (
  url: string,
  response: Response,
  options?: { minContentLength?: number }
): { mimeType: string; extension: string; contentLength: number | null } {
  const contentTypeHeader = response.headers.get('content-type') ?? '';
  const mimeType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!allowedImageMimeTypes.has(mimeType)) {
    throw new Error(`URL ${url} has unsupported content-type "${contentTypeHeader}"`);
  }

  const extension = mimeTypeToExtension[mimeType];
  if (extension === undefined) {
    throw new Error(`Unsupported MIME type "${mimeType}" for URL ${url}`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength =
    contentLengthHeader !== null && contentLengthHeader.length > 0
      ? Number.parseInt(contentLengthHeader, 10)
      : null;
  const minLen = options?.minContentLength;
  if (
    minLen !== undefined &&
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength < minLen
  ) {
    throw new Error(
      `URL ${url} content-length ${String(contentLength)} below minimum ${String(minLen)}`
    );
  }

  return { mimeType, extension, contentLength };
}

export async function resolveRemoteImageMetadata (
  url: string,
  options?: { minContentLength?: number }
): Promise<{ mimeType: string; extension: string; contentLength: number | null }> {
  const headers = officialImageFetchHeaders();
  const headResponse = await fetch(url, {
    method: 'HEAD',
    headers
  });

  if (headResponse.ok) {
    return parseImageMetadataFromResponse(url, headResponse, options);
  }

  if (shouldRetryImageMetadataWithGet(headResponse.status)) {
    const getResponse = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-8191' },
      redirect: 'follow'
    });
    if (getResponse.ok) {
      return parseImageMetadataFromResponse(url, getResponse, options);
    }
    throw new Error(
      `Unable to validate image URL ${url}. GET request failed with status ${String(getResponse.status)}`
    );
  }

  throw new Error(
    `Unable to validate image URL ${url}. HEAD request failed with status ${String(headResponse.status)}`
  );
}

export function filterOfficialProductPrioritizeUrls (urls: readonly string[]): string[] {
  const withoutLow = urls.filter((u) => !isLowValueOfficialProductUrl(u));
  return withoutLow.length > 0 ? withoutLow : [ ...urls ];
}

export function isListingBraveProductCandidateAllowed (
  url: string,
  officialHosts: readonly string[]
): boolean {
  return isOfficialHostCampaignOrProductImageUrl(url, officialHosts);
}

/** When true, Brave product search runs without listing-mode host restrictions. */
export function shouldRelaxProductListingBraveFilter (params: {
  fileType: 'logos' | 'products';
  listingMode: boolean;
  downloadedCount: number;
}): boolean {
  return (
    params.fileType === 'products' &&
    params.listingMode &&
    params.downloadedCount === 0
  );
}

export async function braveImageSearch ({
  query,
  num = 10
}: {
  query: string;
  num?: number;
}): Promise<BraveImageResult[]> {
  const apiKey = process.env['BRAVE_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Missing BRAVE_API_KEY for Brave image search.');
  }

  const params = new URLSearchParams();

  params.set('q', query);
  params.set('count', Math.min(Math.max(num, 1), 200).toString());
  params.set('search_lang', 'fr');
  params.set('country', 'fr');
  params.set('safesearch', 'strict');
  params.set('spellcheck', '0');

  const url = `https://api.search.brave.com/res/v1/images/search?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Brave image search failed: ${response.status} and error: ${await response.text()}`);
  }

  return ((await response.json()) as BraveImageSearchResponse).results;
}

export function officialHostsFromContext (ctx: ImageSearchContext): string[] {
  const hosts: string[] = [];
  for (const raw of [ ctx.brandURL, ctx.companyURL ]) {
    const h = hostFromBrandUrl(raw);
    if (h !== null) {
      const n = normalizeHost(h);
      if (!hosts.includes(n)) {
        hosts.push(n);
      }
    }
  }
  return hosts;
}

function mergeSearchQueries (modelQueries: readonly string[] | undefined, builtIn: string[]): string[] {
  const fromModel = (modelQueries ?? []).map((q) => q.trim()).filter((q) => q.length >= 5);
  return [ ...new Set([ ...fromModel, ...builtIn ]) ];
}

/** Exported for unit tests (game expansion vs corporate publisher lockups). */
export function scoreCampaignLogoAdjustment (
  url: string,
  title: string,
  logoScoring: {
    productName: string;
    companyName: string;
    brandName: string;
  }
): number {
  const product = logoScoring.productName.trim();
  const brand = logoScoring.brandName.trim();
  const company = logoScoring.companyName.trim();
  if (product.length === 0 || brand.length === 0) {
    return 0;
  }
  if (product.toLowerCase() === brand.toLowerCase()) {
    return 0;
  }

  const hay = normalizeForTermMatch(`${url} ${title}`);
  let adjust = 0;

  const productTokens = product
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4);
  const hasProductHint = productTokens.some((t) => hay.includes(t));
  const companyNorm = normalizeForTermMatch(company);
  const looksCorporate =
    company.length > 0 &&
    (hay.includes(companyNorm.replace(/\s+/gu, '')) ||
      /blizzard[\s-]?entertainment/iu.test(hay));

  if (looksCorporate && !hasProductHint && !/lord[-_\s]?of[-_\s]?hatred/iu.test(hay)) {
    adjust -= 150;
  }
  if (/lord[-_\s]?of[-_\s]?hatred/iu.test(hay)) {
    adjust += 80;
  }
  if (hasProductHint) {
    adjust += 35;
  }
  return adjust;
}

/** Penalize parent-company logos for independent sub-brands; skip for division/regional arms. */
export function scoreSubBrandLogoAdjustment (
  url: string,
  title: string,
  logoScoring: {
    companyName: string;
    brandName: string;
  }
): number {
  const brand = logoScoring.brandName.trim();
  const company = logoScoring.companyName.trim();
  if (brand.length === 0 || company.length === 0) {
    return 0;
  }

  const hay = normalizeForTermMatch(`${url} ${title}`);
  let adjust = 0;

  if (/\bnet[_\s-]?logo\b/iu.test(hay) && !/materiel|matnet/iu.test(hay)) {
    adjust -= 200;
  }

  const relationship = resolveBrandLogoRelationship(brand, company);
  if (relationship !== 'independent_sub_brand') {
    if (relationship === 'same') {
      const brandNorm = normalizeForTermMatch(brand).replace(/\s+/gu, '');
      if (brandNorm.length >= 4 && hay.includes(brandNorm)) {
        adjust += 50;
      }
    }
    return adjust;
  }

  const brandNorm = normalizeForTermMatch(brand).replace(/\s+/gu, '');
  const companyNorm = normalizeForTermMatch(company).replace(/\s+/gu, '');
  const brandTokens = brand
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4);

  if (brandNorm.length >= 4 && hay.includes(brandNorm)) {
    adjust += 80;
  } else if (brandTokens.some((t) => hay.includes(t))) {
    adjust += 50;
  }

  if (companyNorm.length >= 4 && hay.includes(companyNorm) && !hay.includes(brandNorm)) {
    adjust -= 150;
  }

  return adjust;
}

/** Penalize franchise logos from the wrong installment (e.g. Scary Movie 4 vs 2026 / part 6). */
export function scoreEntertainmentLogoOpusPenalty (
  url: string,
  title: string,
  productName: string
): number {
  const hay = normalizeForTermMatch(`${url} ${title}`);
  const productHay = normalizeForTermMatch(productName);
  if (productHay.length === 0) {
    return 0;
  }

  let adjust = 0;

  const productYear = productHay.match(/\b(20\d{2})\b/)?.[1];
  const productSequel = productHay.match(/\b(?:movie|film|part|scary\s*movie)\s*(\d+)\b/)?.[1]
    ?? productHay.match(/\bscary\s*movie\s*(\d+)\b/)?.[1];

  const urlOpus = hay.match(/(?:scarymovie|scary-movie|movie[-_]?)(\d+)/)?.[1]
    ?? hay.match(/\bfilm[-_]?(\d+)\b/)?.[1];

  if (urlOpus !== undefined) {
    if (productSequel !== undefined && urlOpus !== productSequel) {
      adjust -= 150;
    } else if (productYear !== undefined && urlOpus !== productYear.slice(-1) && !productHay.includes(urlOpus)) {
      adjust -= 120;
    }
  }

  if (/scarymovie4|scary-movie-4|\bmovie[-_]?4\b/.test(hay) && /(?:\b6\b|2026)/.test(productHay)) {
    adjust -= 150;
  }

  return adjust;
}

function scoreImageSearchRow (
  url: string,
  row: ImageSearchRow,
  options: {
    assetKind: 'logo' | 'product';
    officialHosts: readonly string[];
    minProductW: number;
    minProductH: number;
    productMatchTerms?: readonly string[];
    logoScoring?: {
      productName: string;
      companyName: string;
      brandName: string;
    };
  }
): number {
  let score = 0;
  if (urlHostMatchesOfficial(url, options.officialHosts)) {
    score += 120;
  }
  const source = (row.source ?? '').toLowerCase();
  if (options.officialHosts.some((oh) => source.includes(oh))) {
    score += 45;
  }

  const title = (row.title ?? '').toLowerCase();
  const w = row.properties?.width ?? row.thumbnail?.width;
  const h = row.properties?.height ?? row.thumbnail?.height;

  if (options.assetKind === 'logo') {
    if (/wikimedia\.org|wikipedia\.org/iu.test(url)) {
      score += 90;
    }
    if (/wikimedia|wikipedia/iu.test(source)) {
      score += 40;
    }
    if (/logo|wordmark|marque|identit|brand|sigle/iu.test(title)) {
      score += 18;
    }
    if (/\.svg($|[?#])/iu.test(url)) {
      score += 28;
    }
    if (/\.png($|[?#])/iu.test(url) && /transparent/iu.test(title + url)) {
      score += 12;
    }
    if (/favicon|icon-16|sprite|emoji/iu.test(url)) {
      score -= 80;
    }
    if (isUntrustedLogoUrl(url)) {
      score -= 300;
    }
    if (w !== undefined && h !== undefined && w >= 120 && h >= 40) {
      score += 12;
    }
    if (options.logoScoring !== undefined) {
      score += scoreCampaignLogoAdjustment(url, title, options.logoScoring);
      score += scoreSubBrandLogoAdjustment(url, title, options.logoScoring);
    }
    if (/wikimedia\.org|wikipedia\.org/iu.test(url) && options.logoScoring !== undefined) {
      const brandNorm = normalizeForTermMatch(options.logoScoring.brandName).replace(/\s+/gu, '');
      if (brandNorm.length >= 4 && !normalizeForTermMatch(`${url} ${title}`).includes(brandNorm)) {
        score -= 120;
      }
    }
    if (options.logoScoring !== undefined) {
      score += scoreEntertainmentLogoOpusPenalty(url, title, options.logoScoring.productName);
    }
    const currentYear = String(logoSearchCurrentYear());
    if (url.includes(currentYear) || title.includes(currentYear)) {
      score += 30;
    }
  } else {
    if (isEntertainmentVisualHost(url)) {
      score += 55;
    }
    if (isEntertainmentDeniedHost(url)) {
      score -= 200;
    }
    if (/poster|affiche|key\s*art|still|cast|cinema|theatrical/iu.test(title)) {
      score += 22;
    }
    if (/packshot|produit|product|official|officiel|catalogue/iu.test(title)) {
      score += 14;
    }
    if (options.productMatchTerms !== undefined && options.productMatchTerms.length > 0) {
      score += scoreProductContextRelevance(url, title, options.productMatchTerms);
    }
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (
        /leparisien|lefigaro|pinterest|blogspot|wordpress|medium\.com|kindpng|pngaaa/iu.test(host)
      ) {
        score -= 180;
      }
    } catch {
      // ignore
    }
    if (/wallpaper|screenshot|thumb|avatar|icon/iu.test(url) || isLikelyLowResolutionImageUrl(url)) {
      score -= 90;
    }
    if (w !== undefined && h !== undefined) {
      if (w >= options.minProductW && h >= options.minProductH) {
        score += 30;
      } else if (w < 200 || h < 200) {
        score -= 70;
      }
    }
  }

  return score;
}

function pickDirectImageUrl (r: ImageSearchRow): string | null {
  const fromProps = r.properties?.url?.trim();
  if (fromProps !== undefined && fromProps.length > 0 && /^https?:\/\//iu.test(fromProps)) {
    return fromProps;
  }
  const direct = r.url?.trim();
  if (direct.length > 0 && /^https?:\/\//iu.test(direct)) {
    return direct;
  }
  return null;
}

export type GatherImageUrlsOptions = {
  maxResults: number;
  perQuery: number;
  excludeUrls?: Set<string>;
  skipLowResUrls?: boolean;
  minContentLength?: number;
  assetKind?: 'logo' | 'product';
  officialHosts?: readonly string[];
  productMatchTerms?: readonly string[];
  referenceListingUrls?: readonly string[];
  entertainmentMode?: boolean;
  experienceMode?: boolean;
  logoScoring?: {
    productName: string;
    companyName: string;
    brandName: string;
  };
};

export async function gatherValidatedImageUrls (
  queries: readonly string[],
  options: GatherImageUrlsOptions
): Promise<{ urls: string[]; titlesByUrl: Map<string, string> }> {
  const seen = new Set<string>();
  const titlesByUrl = new Map<string, string>();
  const skipLowRes = options.skipLowResUrls !== false;
  const assetKind = options.assetKind ?? 'product';
  const officialHosts = options.officialHosts ?? [];
  const ranked: { url: string; score: number; title: string }[] = [];
  const provider = resolveImageSearchProvider();
  const logPrefix = imageSearchLogPrefix(provider);
  const listingFilter =
    options.entertainmentMode !== true &&
    options.experienceMode !== true &&
    options.referenceListingUrls !== undefined &&
    options.referenceListingUrls.length > 0;

  for (const query of queries) {
    let results: ImageSearchRow[];
    try {
      results = await imageSearch({
        query,
        num: options.perQuery,
        assetKind,
        officialHosts,
        provider
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${logPrefix} query failed "${query}": ${msg}`);
      continue;
    }
    for (const row of results) {
      const candidate = pickDirectImageUrl(row);
      if (candidate === null || seen.has(candidate)) {
        continue;
      }
      if (options.excludeUrls?.has(candidate) === true) {
        continue;
      }
      if (skipLowRes && isLikelyLowResolutionImageUrl(candidate)) {
        continue;
      }
      if (assetKind === 'logo' && isUntrustedLogoUrl(candidate)) {
        continue;
      }

      const score = scoreImageSearchRow(candidate, row, {
        assetKind,
        officialHosts,
        minProductW: braveProductMinReportedWidth(),
        minProductH: braveProductMinReportedHeight(),
        ...(options.productMatchTerms !== undefined && options.productMatchTerms.length > 0
          ? { productMatchTerms: options.productMatchTerms }
          : {}),
        ...(assetKind === 'logo' && options.logoScoring !== undefined
          ? { logoScoring: options.logoScoring }
          : {})
      });
      if (score < -50) {
        continue;
      }
      if (
        assetKind === 'product' &&
        listingFilter &&
        !isListingBraveProductCandidateAllowed(candidate, officialHosts)
      ) {
        continue;
      }
      if (
        assetKind === 'product' &&
        options.productMatchTerms !== undefined &&
        options.productMatchTerms.length > 0 &&
        (options.entertainmentMode === true ||
          options.experienceMode === true ||
          options.referenceListingUrls === undefined ||
          options.referenceListingUrls.length === 0 ||
          !isOfficialHostCampaignOrProductImageUrl(candidate, officialHosts)) &&
        scoreProductContextRelevance(candidate, row.title ?? '', options.productMatchTerms) <
          productMinRelevanceScore()
      ) {
        continue;
      }

      if (assetKind === 'logo' && /\.svg($|[?#])/iu.test(candidate)) {
        seen.add(candidate);
        ranked.push({ url: candidate, score, title: row.title ?? '' });
        continue;
      }

      try {
        await resolveRemoteImageMetadata(candidate, {
          ...(options.minContentLength !== undefined
            ? { minContentLength: options.minContentLength }
            : {})
        });
        seen.add(candidate);
        ranked.push({ url: candidate, score, title: row.title ?? '' });
      } catch {
        /* URL not a usable image */
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  const urls = ranked.slice(0, options.maxResults).map((r) => r.url);
  for (const row of ranked.slice(0, options.maxResults)) {
    if (row.title.length > 0) {
      titlesByUrl.set(row.url, row.title);
    }
  }
  if (urls.length > 0 && ranked[0] !== undefined) {
    console.log(
      `${logPrefix} Top ${assetKind} candidate score=${String(ranked[0].score)} host=${(() => {
        try {
          return new URL(ranked[0].url).hostname;
        } catch {
          return '?';
        }
      })()}`
    );
  } else if (assetKind === 'product') {
    const filterHints: string[] = [];
    if (listingFilter) {
      filterHints.push('listing-mode official-host filter');
    }
    if (options.minContentLength !== undefined) {
      filterHints.push(`min content-length ${String(options.minContentLength)}`);
    }
    if (options.productMatchTerms !== undefined && options.productMatchTerms.length > 0) {
      filterHints.push('product context match terms');
    }
    if (skipLowRes) {
      filterHints.push('low-res URL skip');
    }
    console.warn(
      `${logPrefix} No product candidates after filtering (${filterHints.join('; ') || 'queries returned no usable images'}).`
    );
  }
  return { urls, titlesByUrl };
}

/** Calendar year used in logo search queries to bias toward the latest brand lockup. */
export function logoSearchCurrentYear (): number {
  return new Date().getFullYear();
}

function buildLogoSearchQueriesBuiltin (base: ImageSearchContext): string[] {
  const names = resolveLogoSearchNames(base);
  if (names.length === 0) {
    return [];
  }

  const year = logoSearchCurrentYear();
  const queries: string[] = [];
  const brandHost = hostFromBrandUrl(base.brandURL);
  const companyHost = hostFromBrandUrl(base.companyURL);
  const primary = names[0] ?? '';
  const secondary = names[1];

  for (const name of names) {
    queries.push(
      `${name} logo ${year}`,
      `${name} logo transparent`,
      `${name} wordmark svg`,
      `${name} official logo`,
      `${name} identité visuelle logo`,
      `${name} charte graphique logo`,
      `${name} nouveau logo ${year}`
    );
  }

  if (brandHost !== null) {
    const h = brandHost;
    queries.push(
      `site:${h} logo`,
      `site:${h} logo filetype:svg`,
      `site:${h} logo filetype:png`,
      `site:${h} inurl:logo`,
      `site:${h} wordmark`,
      `${primary} logo officiel site:${h}`,
      `site:${h} logo ${year}`,
      `${primary} logo ${year} site:${h}`
    );
    if (secondary !== undefined) {
      queries.push(`site:${h} ${secondary} logo`);
    }
  }
  if (companyHost !== null && companyHost !== brandHost) {
    queries.push(`site:${companyHost} ${primary} logo`, `site:${companyHost} logo`);
    if (secondary !== undefined) {
      queries.push(`site:${companyHost} ${secondary} logo`);
    }
  }

  return queries;
}

export function buildLogoSearchQueries (base: ImageSearchContext): string[] {
  const builtIn = buildLogoSearchQueriesBuiltin(base);
  const fromModel = filterLogoSearchQueries(
    (base.logoImageSearchQueries ?? []).map((q) => q.trim()).filter((q) => q.length >= 5),
    base
  );
  return [ ...new Set([ ...fromModel, ...builtIn ]) ];
}

function hostFromBrandUrl (brandURL: string | undefined): string | null {
  if (brandURL === undefined || brandURL.trim().length === 0) {
    return null;
  }
  try {
    return new URL(brandURL.trim()).hostname || null;
  } catch {
    return null;
  }
}

function buildProductSearchQueriesBuiltin (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const product = base.productName.trim();
  const campaign = base.campaignContext?.trim() ?? '';
  const queries: string[] = [];
  const host = hostFromBrandUrl(base.brandURL);
  const companyHost = hostFromBrandUrl(base.companyURL);
  const entertainment = isEntertainmentCampaign(buildProductMatchFields({
    campaignContext: campaign.length > 0 ? campaign : null,
    productName: product,
    brandName: brand,
    brandContext: base.brandContext,
    brandURL: base.brandURL
  }));
  const experience = isExperienceCampaign(buildProductMatchFields({
    campaignContext: campaign.length > 0 ? campaign : null,
    productName: product,
    brandName: brand,
    brandContext: base.brandContext,
    brandURL: base.brandURL
  }));

  if (entertainment) {
    const title = product.length > 0 ? product : brand;
    queries.push(
      `site:imdb.com ${title} poster`,
      `site:allocine.fr ${title} affiche`,
      `site:impawards.com ${title}`,
      `${title} official poster key art`,
      `${title} theatrical poster Paramount`
    );
    if (host !== null) {
      queries.push(`site:${host} poster`, `site:${host} key art`);
    }
  }

  if (experience && host !== null) {
    queries.push(
      `site:${host} attraction photo`,
      `site:${host} ${product} été`,
      `site:${host} famille parc`,
      `${brand} ${product} attraction officielle`,
      `${brand} roller coaster photo officielle`
    );
  }

  if (campaign.length > 0) {
    if (host !== null) {
      queries.push(
        `site:${host} ${campaign} packshot`,
        `site:${host} ${campaign} photo officielle`,
        `site:${host} ${brand} ${campaign}`
      );
    }
    queries.push(`${brand} ${campaign} packshot officiel`, `${campaign} visuel marketing`);
  }

  const terms = base.productMatchTerms ?? [];
  for (const term of terms.slice(0, 6)) {
    if (host !== null) {
      queries.push(`site:${host} ${term} packshot`, `site:${host} ${term} image`);
    }
    queries.push(`${brand} ${term} packshot officiel`);
  }

  if (host !== null) {
    if (product.length > 0) {
      queries.push(
        `site:${host} ${product} packshot`,
        `site:${host} ${product} photo produit`,
        `site:${host} ${product} image officielle`,
        `site:${host} ${brand} ${product}`
      );
    } else if (campaign.length === 0) {
      queries.push(`site:${host} ${brand} produit photo`, `site:${host} catalogue produit`);
    }
  }
  if (companyHost !== null && companyHost !== host && product.length > 0) {
    queries.push(`site:${companyHost} ${product} photo`);
  }

  if (product.length > 0) {
    queries.push(
      `${brand} ${product} packshot officiel`,
      `${product} photo produit haute résolution`,
      `${brand} ${product} visuel marketing officiel`
    );
  } else {
    queries.push(`${brand} produit photo officiel`, `${brand} gamme produit`);
  }

  return queries;
}

export function buildProductSearchQueries (base: ImageSearchContext): string[] {
  return mergeSearchQueries(base.productImageSearchQueries, buildProductSearchQueriesBuiltin(base));
}

export function buildLogoSearchQueriesFromFindings (
  base: ImageSearchContext,
  findings?: readonly { issue?: string; asset_id?: string }[],
  auditLogoQueries?: readonly string[]
): string[] {
  const queries = [ ...buildLogoSearchQueries(base) ];
  const names = resolveLogoSearchNames(base);
  const primary = names[0] ?? base.brandName.trim();
  const secondary = names[1];

  if (auditLogoQueries !== undefined) {
    for (const q of filterLogoSearchQueries(auditLogoQueries, base)) {
      if (q.trim().length > 0) {
        queries.push(q.trim());
      }
    }
  }

  const hasLogoIssue =
    findings?.some((f) => f.asset_id?.startsWith('logos/') === true) ?? false;

  if (hasLogoIssue) {
    const year = logoSearchCurrentYear();
    const brandHost = hostFromBrandUrl(base.brandURL);
    const companyHost = hostFromBrandUrl(base.companyURL);
    if (brandHost !== null) {
      queries.unshift(
        `site:${brandHost} logo filetype:svg`,
        `site:${brandHost} inurl:logo`,
        `site:${brandHost} logo officiel`,
        `site:${brandHost} logo ${year}`,
        `${primary} logo ${year}`
      );
    }
    if (companyHost !== null && companyHost !== brandHost) {
      queries.unshift(`site:${companyHost} ${primary} logo`);
      if (secondary !== undefined) {
        queries.unshift(`site:${companyHost} ${secondary} logo`);
      }
    }
  }

  return [ ...new Set(queries) ];
}

export function buildProductSearchQueriesFromFindings (
  base: ImageSearchContext,
  findings?: readonly { issue?: string; asset_id?: string }[],
  auditProductQueries?: readonly string[]
): string[] {
  const queries = [ ...buildProductSearchQueries(base) ];
  const brand = base.brandName.trim();
  const product = base.productName.trim();

  if (auditProductQueries !== undefined) {
    for (const q of auditProductQueries) {
      if (q.trim().length > 0) {
        queries.push(q.trim());
      }
    }
  }

  const hasDimensionIssue =
    findings?.some(
      (f) =>
        (f.issue?.includes('below minimum') ?? false) ||
        (f.issue?.includes('Dimensions') ?? false) ||
        (f.asset_id?.includes('thumb') ?? false)
    ) ?? false;

  const hasHostIssue =
    findings?.some(
      (f) =>
        (f.issue?.includes('official brand visual host') ?? false) ||
        (f.issue?.includes('official film/studio host') ?? false) ||
        (f.issue?.includes('cinema database') ?? false)
    ) ?? false;

  const entertainment = isEntertainmentCampaign(buildProductMatchFields({
    campaignContext: base.campaignContext ?? null,
    productName: base.productName,
    brandName: base.brandName,
    brandContext: base.brandContext,
    brandURL: base.brandURL
  }));

  if (hasHostIssue && entertainment) {
    const title = base.productName.trim() || base.brandName.trim();
    queries.unshift(
      `site:allocine.fr ${title} affiche`,
      `site:imdb.com ${title} poster`,
      `site:impawards.com ${title}`
    );
  }

  if (hasDimensionIssue) {
    const host = hostFromBrandUrl(base.brandURL);
    if (host !== null && product.length > 0) {
      queries.unshift(
        `site:${host} ${product} packshot`,
        `site:${host} ${product} photo haute résolution`
      );
    }
    if (product.length > 0) {
      queries.push(`${product} packshot officiel haute résolution`, `${brand} ${product} visuel HD`);
    }
  }

  return [ ...new Set(queries) ];
}

export function loadBraveExcludedUrls (reviewDirectoryPath: string): Set<string> {
  const filePath = join(reviewDirectoryPath, 'brave-excluded-urls.json');
  if (!existsSync(filePath)) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { urls?: string[] };
    return new Set(parsed.urls ?? []);
  } catch {
    return new Set();
  }
}

export function appendBraveExcludedUrls (
  reviewDirectoryPath: string,
  excluded: Set<string>,
  newUrls: readonly string[]
): Set<string> {
  for (const url of newUrls) {
    excluded.add(url);
  }
  mkdirSync(reviewDirectoryPath, { recursive: true });
  writeFileSync(
    join(reviewDirectoryPath, 'brave-excluded-urls.json'),
    `${JSON.stringify({ urls: [ ...excluded ] }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  return excluded;
}

export function clearAssetSubdirectory (subdirectoryPath: string): void {
  if (!existsSync(subdirectoryPath)) {
    mkdirSync(subdirectoryPath, { recursive: true });
    return;
  }
  for (const fileName of readdirSync(subdirectoryPath)) {
    if (fileName.startsWith('.')) {
      continue;
    }
    unlinkSync(join(subdirectoryPath, fileName));
  }
}

async function validateDownloadedDimensions (
  fileType: 'logos' | 'products',
  filePath: string
): Promise<{ ok: boolean; width?: number; height?: number }> {
  if (fileType === 'logos' && extname(filePath).toLowerCase() === '.svg') {
    return { ok: true };
  }
  const { minW, minH } = assetMinDimensions(fileType);
  try {
    const { width, height } = await imageSizeFromFile(filePath);
    if (width === undefined || height === undefined) {
      return { ok: false };
    }
    if (width < minW || height < minH) {
      console.warn(
        `[download] Rejected ${fileType} ${basename(filePath)}: ${String(width)}×${String(height)} below ${String(minW)}×${String(minH)}`
      );
      return { ok: false, width, height };
    }
    return { ok: true, width, height };
  } catch {
    return { ok: false };
  }
}

export async function downloadUrlsToAssetFolder (
  fileType: 'logos' | 'products',
  directoryPath: string,
  fileUrls: readonly string[],
  options?: {
    validateDimensions?: boolean;
    rejectedUrls?: string[];
    productProvenanceByUrl?: ReadonlyMap<string, ProductAssetSourceProvenance>;
    productTitleByUrl?: ReadonlyMap<string, string>;
    logoSourcePhase?: LogoSourcePhase;
    officialHosts?: readonly string[];
  }
): Promise<{ downloadedUrls: string[]; count: number }> {
  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath, { recursive: true });
  const validateDims = options?.validateDimensions === true;

  const downloadedUrls: string[] = [];


  for (const fileUrl of fileUrls) {
    const logoFileNameSanitized = fileNameFromImageUrl(fileUrl);
    const originalExtension = extname(logoFileNameSanitized).toLowerCase();

    try {
      const { mimeType, extension } = await resolveRemoteImageMetadata(fileUrl);
      const resolvedFileName =
        originalExtension === extension
          ? logoFileNameSanitized
          : `${logoFileNameSanitized.replace(/\.[^.]+$/, '')}${extension}`;
      const filePath = join(subdirectoryPath, resolvedFileName);

      if (originalExtension !== extension && originalExtension.length > 0) {
        console.warn(
          `[download] Extension mismatch for ${fileUrl}. Pathname ext "${originalExtension}", remote "${mimeType}". Saving as ${resolvedFileName}.`
        );
      }

      console.log(`Downloading ${filePath} ...`);
      await downloadFileToFileSystem(fileUrl, filePath);

      if (validateDims && fileType === 'products') {
        const dim = await validateDownloadedDimensions(fileType, filePath);
        if (!dim.ok) {
          unlinkSync(filePath);
          options?.rejectedUrls?.push(fileUrl);
          continue;
        }
      }

      downloadedUrls.push(fileUrl);
      if (fileType === 'products') {
        const provenance = options?.productProvenanceByUrl?.get(fileUrl);
        const sourceTitle = options?.productTitleByUrl?.get(fileUrl);
        recordProductAssetSource(
          directoryPath,
          resolvedFileName,
          fileUrl,
          {
            ...(provenance ?? {}),
            ...(sourceTitle !== undefined && sourceTitle.length > 0 ? { sourceTitle } : {})
          }
        );
      }
      if (fileType === 'logos') {
        recordLogoAssetSource(
          directoryPath,
          resolvedFileName,
          fileUrl,
          options?.logoSourcePhase ?? 'unknown'
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[download] ${fileType} failed ${fileUrl}: ${err.message}`);
      }
    }
  }

  return { downloadedUrls, count: downloadedUrls.length };
}

export type CollectAndDownloadOptions = {
  targetCount: number;
  candidatePool: number;
  excludeUrls?: Set<string>;
  clearFolder?: boolean;
  officialHosts?: readonly string[];
  /** Header lockup URLs scraped from brandURL (tried before Brave image search). */
  prioritizeUrls?: readonly string[];
  /** Official scrape candidates with page provenance (preferred over prioritizeUrls). */
  prioritizeCandidates?: readonly OfficialProductCandidate[];
  /** When true and prioritizeUrls filled the target, skip Brave image search entirely. */
  skipBraveWhenPrioritizedFilled?: boolean;
  productMatchTerms?: readonly string[];
  /** Campaign-specific terms for listing-mode relevance (official URLs included). */
  retailCampaignRelevanceTerms?: readonly string[];
  referenceListingUrls?: readonly string[];
  entertainmentMode?: boolean;
  experienceMode?: boolean;
  logoScoring?: {
    productName: string;
    companyName: string;
    brandName: string;
  };
};

export async function collectAndDownloadValidAssetUrls (
  fileType: 'logos' | 'products',
  directoryPath: string,
  queries: readonly string[],
  options: CollectAndDownloadOptions
): Promise<{ downloadedUrls: string[]; count: number; rejectedUrls: string[] }> {
  const subdirectoryPath = join(directoryPath, fileType);
  if (options.clearFolder === true) {
    clearAssetSubdirectory(subdirectoryPath);
    if (fileType === 'products') {
      clearProductAssetSources(directoryPath);
    }
  } else {
    mkdirSync(subdirectoryPath, { recursive: true });
  }

  const excludeUrls = new Set(options.excludeUrls ?? []);
  const rejectedUrls: string[] = [];
  const downloadedUrls: string[] = [];
  const officialHosts = options.officialHosts ?? [];
  const minContentLength =
    fileType === 'products' ? braveProductMinContentLength() : undefined;

  const listingMode =
    options.entertainmentMode !== true &&
    options.experienceMode !== true &&
    options.referenceListingUrls !== undefined &&
    options.referenceListingUrls.length > 0;
  const entertainmentMode = options.entertainmentMode === true;
  const experienceMode = options.experienceMode === true;

  const productProvenanceByUrl = new Map<string, ProductAssetSourceProvenance>();
  let prioritize: string[] = [];
  if (
    fileType === 'products' &&
    options.prioritizeCandidates !== undefined &&
    options.prioritizeCandidates.length > 0
  ) {
    for (const c of options.prioritizeCandidates) {
      prioritize.push(c.url);
      productProvenanceByUrl.set(c.url, {
        sourcePageUrl: c.sourcePageUrl,
        fromReferencePage: c.fromReferencePage
      });
    }
  } else {
    prioritize = [ ...(options.prioritizeUrls ?? []) ];
  }

  if (fileType === 'products' && prioritize.length > 0) {
    const relevanceTerms =
      options.retailCampaignRelevanceTerms !== undefined &&
      options.retailCampaignRelevanceTerms.length > 0
        ? options.retailCampaignRelevanceTerms
        : options.productMatchTerms;
    if (relevanceTerms !== undefined && relevanceTerms.length > 0) {
      const beforeCount = prioritize.length;
      if (listingMode) {
        const minScore = productMinRelevanceScore();
        prioritize = prioritize.filter((url) => {
          const fileName = url.split('/').pop()?.split('?')[0] ?? '';
          return (
            scoreProductContextRelevance(`${url} ${fileName}`, '', relevanceTerms) >= minScore
          );
        });
      } else {
        prioritize = filterPrioritizeProductUrls(
          prioritize,
          relevanceTerms,
          productMinRelevanceScore(),
          officialHosts
        );
      }
      if (prioritize.length < beforeCount) {
        console.log(
          `[download] Filtered product URLs by campaign relevance: ${String(prioritize.length)}/${String(beforeCount)} kept`
        );
      }
    }
  }

  if (fileType === 'products' && prioritize.length > 0) {
    prioritize = filterOfficialProductPrioritizeUrls(prioritize);
  }

  if (prioritize.length > 0 && (fileType === 'logos' || fileType === 'products')) {
    const assetLabel = fileType === 'logos' ? 'logo' : 'product';
    console.log(
      `[download] Trying ${String(prioritize.length)} official-site ${assetLabel} URL(s) before Brave…`
    );
    const hostTracker = new AssetHostFailureTracker(2);
    for (const fileUrl of prioritize) {
      if (downloadedUrls.length >= options.targetCount) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      if (hostTracker.isBlocked(fileUrl)) {
        continue;
      }
      const batch = await downloadUrlsToAssetFolder(fileType, directoryPath, [ fileUrl ], {
        validateDimensions: true,
        rejectedUrls,
        ...(fileType === 'products' && productProvenanceByUrl.size > 0
          ? { productProvenanceByUrl }
          : {}),
        ...(fileType === 'logos'
          ? { logoSourcePhase: 'official' as const, officialHosts }
          : {})
      });
      if (batch.count > 0) {
        downloadedUrls.push(...batch.downloadedUrls);
        console.log(`[download] Official ${assetLabel} saved: ${fileUrl}`);
      } else {
        excludeUrls.add(fileUrl);
        rejectedUrls.push(fileUrl);
        if (hostTracker.recordFailure(fileUrl)) {
          const host = hostTracker.blockedHostForLog();
          console.log(
            `[download] Skipping remaining official ${assetLabel} URLs on ${host ?? 'host'} (downloads blocked)`
          );
          break;
        }
      }
    }
  }

  if (
    options.skipBraveWhenPrioritizedFilled === true &&
    downloadedUrls.length >= options.targetCount
  ) {
    console.log(
      `[download] Official ${fileType} satisfied — skipping Brave image search for ${fileType}.`
    );
    return { downloadedUrls, count: downloadedUrls.length, rejectedUrls };
  }

  let effectiveListingMode = listingMode;
  if (
    shouldRelaxProductListingBraveFilter({
      fileType,
      listingMode: effectiveListingMode,
      downloadedCount: downloadedUrls.length
    })
  ) {
    console.log(
      prioritize.length > 0
        ? '[download] Official product candidates failed — relaxing listing-mode Brave filter.'
        : '[download] No official product assets — relaxing listing-mode Brave filter.'
    );
    effectiveListingMode = false;
  }

  let pass = 0;
  while (downloadedUrls.length < options.targetCount && pass < 4) {
    pass += 1;
    const need = options.targetCount - downloadedUrls.length;
    const poolSize = Math.max(options.candidatePool, need * 3);
    const gathered = await gatherValidatedImageUrls(queries, {
      maxResults: poolSize,
      perQuery: fileType === 'logos' ? 15 : 12,
      excludeUrls,
      skipLowResUrls: true,
      assetKind: fileType === 'logos' ? 'logo' : 'product',
      officialHosts,
      ...(minContentLength !== undefined ? { minContentLength } : {}),
      ...(fileType === 'products' &&
      options.productMatchTerms !== undefined &&
      options.productMatchTerms.length > 0
        ? { productMatchTerms: options.productMatchTerms }
        : {}),
      ...(fileType === 'products' && effectiveListingMode
        ? { referenceListingUrls: options.referenceListingUrls }
        : {}),
      ...(fileType === 'products' && entertainmentMode ? { entertainmentMode: true } : {}),
      ...(fileType === 'products' && experienceMode ? { experienceMode: true } : {}),
      ...(fileType === 'logos' && options.logoScoring !== undefined
        ? { logoScoring: options.logoScoring }
        : {})
    });
    const candidates = gathered.urls;
    const productTitleByUrl = gathered.titlesByUrl;

    if (fileType === 'products' && candidates.length === 0) {
      console.warn(
        `[download] Brave product search pass ${String(pass)}: 0 candidates after gather` +
          (effectiveListingMode ? ' (listing-mode filter was active)' : '')
      );
    }

    for (const fileUrl of candidates) {
      if (downloadedUrls.length >= options.targetCount) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      const before = downloadedUrls.length;
      const batch = await downloadUrlsToAssetFolder(fileType, directoryPath, [ fileUrl ], {
        validateDimensions: true,
        rejectedUrls,
        ...(fileType === 'products' && productProvenanceByUrl.size > 0
          ? { productProvenanceByUrl }
          : {}),
        ...(fileType === 'products' && productTitleByUrl.size > 0
          ? { productTitleByUrl }
          : {}),
        ...(fileType === 'logos'
          ? {
              logoSourcePhase: /wikimedia\.org|wikipedia\.org/iu.test(fileUrl)
                ? ('wikipedia' as const)
                : ('brave' as const),
              officialHosts
            }
          : {})
      });
      if (batch.count > 0) {
        downloadedUrls.push(...batch.downloadedUrls);
      } else {
        excludeUrls.add(fileUrl);
        rejectedUrls.push(fileUrl);
      }
      if (batch.count === 0 && before === downloadedUrls.length) {
        excludeUrls.add(fileUrl);
      }
    }

    if (downloadedUrls.length >= options.targetCount) {
      break;
    }
  }

  return { downloadedUrls, count: downloadedUrls.length, rejectedUrls };
}

export type RefreshAssetsResult = {
  logoFileUrls: string[];
  productPictureUrls: string[];
  downloaded: { logos: number; products: number };
};

/** Resolves logo Brave queries; `logos: []` means skip logo refresh (no fallback). */
export function resolveRefreshLogoQueries (
  queries: { logos?: string[] },
  context: ImageSearchContext
): string[] {
  const skipLogoRefresh = queries.logos !== undefined && queries.logos.length === 0;
  if (skipLogoRefresh) {
    return [];
  }
  return queries.logos !== undefined && queries.logos.length > 0
    ? queries.logos
    : buildLogoSearchQueries(context);
}

/** Resolves product Brave queries; `products: []` means skip product refresh (no fallback). */
export function resolveRefreshProductQueries (
  queries: { products?: string[] },
  context: ImageSearchContext
): string[] {
  const skipProductRefresh = queries.products !== undefined && queries.products.length === 0;
  if (skipProductRefresh) {
    return [];
  }
  return queries.products !== undefined && queries.products.length > 0
    ? queries.products
    : buildProductSearchQueries(context);
}

export async function refreshAssetsFromQueries (
  directoryPath: string,
  context: ImageSearchContext,
  queries: { logos?: string[]; products?: string[] },
  options?: {
    logoMaxResults?: number;
    productMaxResults?: number;
    excludeUrls?: Set<string>;
    /** When false, keep existing products/ files and only add new downloads (post-audit refresh). */
    clearProductFolder?: boolean;
    /** Skip official-site scrape; use Brave queries only (targeted post-audit retry). */
    preferBraveOnly?: boolean;
  }
): Promise<RefreshAssetsResult & { rejectedUrls: string[] }> {
  const productMax = options?.productMaxResults ?? braveProductTargetCount();
  const excludeUrls = options?.excludeUrls ?? new Set<string>();
  const allRejected: string[] = [];

  const logoQueries = resolveRefreshLogoQueries(queries, context);
  const productQueries = resolveRefreshProductQueries(queries, context);

  let logoDownload = {
    downloadedUrls: [] as string[],
    count: 0,
    rejectedUrls: [] as string[]
  };
  if (logoQueries.length > 0) {
    console.log(`${imageSearchLogPrefix()} Refresh — single transparent logo (official → Wikipedia → image search)…`);
    logoDownload = await collectSingleTransparentLogo(directoryPath, context, logoQueries, {
      excludeUrls
    });
    allRejected.push(...logoDownload.rejectedUrls);
    for (const url of logoDownload.rejectedUrls) {
      excludeUrls.add(url);
    }
  }

  let productDownload = { downloadedUrls: [] as string[], count: 0, rejectedUrls: [] as string[] };
  if (productQueries.length > 0) {
    console.log(`${imageSearchLogPrefix()} Refresh — collecting product candidates…`);
    const preferBraveOnly = options?.preferBraveOnly === true;
    const officialProductCandidates = preferBraveOnly
      ? []
      : await extractOfficialProductImageUrls(context, {
          minimumCandidates: Math.max(productMax * 2, braveProductCandidatePool())
        });
    const matchFields = buildProductMatchFields({
      campaignContext: context.campaignContext ?? null,
      productName: context.productName,
      brandName: context.brandName,
      brandContext: context.brandContext,
      brandURL: context.brandURL
    });
    const retailCampaignRelevanceTerms = buildRetailCampaignRelevanceTerms(matchFields);
    const referenceListingUrls = resolveReferenceListingUrls({
      ...(context.campaignReferenceUrl !== undefined && context.campaignReferenceUrl.length > 0
        ? { campaignReferenceUrl: context.campaignReferenceUrl }
        : {}),
      ...(context.campaignUrls !== undefined && context.campaignUrls.length > 0
        ? { campaignUrls: context.campaignUrls }
        : {})
    });
    const clearProductFolder = options?.clearProductFolder !== false;
    const existingProductCount = clearProductFolder
      ? 0
      : listAssetImageFiles(directoryPath, 'products').length;
    const effectiveTarget = clearProductFolder
      ? productMax
      : productAppendRefreshTargetCount(existingProductCount, productMax);
    if (!clearProductFolder) {
      console.log(
        `[download] Append mode: existing=${String(existingProductCount)}, downloading up to ${String(effectiveTarget)}`
      );
    }
    if (effectiveTarget > 0) {
    productDownload = await collectAndDownloadValidAssetUrls(
      'products',
      directoryPath,
      productQueries,
      {
        targetCount: effectiveTarget,
        candidatePool: braveProductCandidatePool(),
        excludeUrls,
        clearFolder: clearProductFolder,
        officialHosts: officialHostsFromContext(context),
        prioritizeCandidates: officialProductCandidates,
        skipBraveWhenPrioritizedFilled: !preferBraveOnly,
        ...(referenceListingUrls.length > 0 ? { referenceListingUrls } : {}),
        ...(() => {
          const profile = resolveCampaignAssetProfile(matchFields);
          if (profile === 'entertainment') {
            return { entertainmentMode: true as const };
          }
          if (profile === 'experience') {
            return { experienceMode: true as const };
          }
          return {};
        })(),
        ...(retailCampaignRelevanceTerms.length > 0
          ? { retailCampaignRelevanceTerms }
          : {}),
        ...(context.productMatchTerms !== undefined && context.productMatchTerms.length > 0
          ? { productMatchTerms: context.productMatchTerms }
          : {})
      }
    );
    allRejected.push(...productDownload.rejectedUrls);
    } else if (!clearProductFolder) {
      console.log('[download] Append mode: product folder already at max — skipping download.');
    }
  }

  return {
    logoFileUrls: logoDownload.downloadedUrls,
    productPictureUrls: productDownload.downloadedUrls,
    downloaded: {
      logos: logoDownload.count,
      products: productDownload.count
    },
    rejectedUrls: allRejected
  };
}

export function mergeRefreshIntoStyleGuideFile<T extends {
  logoFileUrls: string[];
  productPictureUrls: string[];
}>(
  directoryPath: string,
  styleGuide: T,
  refresh: RefreshAssetsResult
): T {
  const next = {
    ...styleGuide,
    logoFileUrls:
      refresh.logoFileUrls.length > 0 ? refresh.logoFileUrls : styleGuide.logoFileUrls,
    productPictureUrls:
      refresh.productPictureUrls.length > 0
        ? refresh.productPictureUrls
        : styleGuide.productPictureUrls
  };
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(next, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  return next;
}

// ===== logo-pipeline.mts =====
export type CollectSingleLogoResult = {
  downloadedUrls: string[];
  count: number;
  rejectedUrls: string[];
  source: 'official' | 'wikipedia' | 'brave' | null;
};

function countLogoFiles (directoryPath: string): number {
  const logosDir = join(directoryPath, 'logos');
  if (!existsSync(logosDir)) {
    return 0;
  }
  return listAssetImageFiles(directoryPath, 'logos').length;
}

async function tryLogoUrl (
  directoryPath: string,
  fileUrl: string,
  urlBySavedFile: Map<string, string>,
  rejectedUrls: string[],
  options: {
    sourcePhase: 'official' | 'wikipedia' | 'brave';
    officialHosts: readonly string[];
  }
): Promise<boolean> {
  let downloadUrl = fileUrl;
  if (options.sourcePhase === 'wikipedia') {
    const upgraded = upgradeWikimediaThumbToSourceUrl(fileUrl);
    if (upgraded !== null) {
      downloadUrl = upgraded;
    }
  }
  const batch = await downloadUrlsToAssetFolder('logos', directoryPath, [ downloadUrl ], {
    validateDimensions: true,
    rejectedUrls,
    logoSourcePhase: options.sourcePhase,
    officialHosts: options.officialHosts
  });
  if (batch.count === 0) {
    return false;
  }
  for (const name of listAssetImageFiles(directoryPath, 'logos')) {
    if (!urlBySavedFile.has(name)) {
      urlBySavedFile.set(name, downloadUrl);
    }
  }
  return true;
}

/**
 * Acquire exactly one logo: transparent PNG/WebP (alpha) or SVG.
 * Sources in order: brand official site → Wikipedia/Wikimedia → Brave image search.
 */
export async function collectSingleTransparentLogo (
  directoryPath: string,
  context: ImageSearchContext,
  braveQueries: readonly string[],
  options?: { excludeUrls?: Set<string> }
): Promise<CollectSingleLogoResult> {
  const rejectedUrls: string[] = [];
  const excludeUrls = new Set(options?.excludeUrls ?? []);
  const urlBySavedFile = new Map<string, string>();
  let source: CollectSingleLogoResult['source'] = null;

  clearAssetSubdirectory(join(directoryPath, 'logos'));
  clearLogoAssetSources(directoryPath);

  const officialHosts = officialHostsFromContext(context);
  const officialUrls = await extractOfficialSiteLogoUrls(context);
  console.log(
    `[logo] Phase 1 — official site (${String(officialUrls.length)} candidate URL(s))…`
  );
  const officialHostTracker = new AssetHostFailureTracker(2);
  for (const fileUrl of officialUrls) {
    if (countLogoFiles(directoryPath) >= CANONICAL_LOGO_COUNT) {
      break;
    }
    if (excludeUrls.has(fileUrl)) {
      continue;
    }
    if (officialHostTracker.isBlocked(fileUrl)) {
      continue;
    }
    const ok = await tryLogoUrl(directoryPath, fileUrl, urlBySavedFile, rejectedUrls, {
      sourcePhase: 'official',
      officialHosts
    });
    if (ok) {
      source = 'official';
      console.log(`[logo] Official site logo saved: ${fileUrl}`);
      break;
    }
    excludeUrls.add(fileUrl);
    rejectedUrls.push(fileUrl);
    if (officialHostTracker.recordFailure(fileUrl)) {
      const host = officialHostTracker.blockedHostForLog();
      console.log(
        `[logo] Skipping remaining official URLs on ${host ?? 'host'} (downloads blocked)`
      );
      break;
    }
  }

  if (countLogoFiles(directoryPath) < CANONICAL_LOGO_COUNT) {
    const wikiUrls = await extractWikipediaLogoUrls(context);
    console.log(
      `[logo] Phase 2 — Wikipedia / Wikimedia (${String(wikiUrls.length)} candidate URL(s))…`
    );
    const wikiHostTracker = new AssetHostFailureTracker(2);
    for (const fileUrl of wikiUrls) {
      if (countLogoFiles(directoryPath) >= CANONICAL_LOGO_COUNT) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      if (wikiHostTracker.isBlocked(fileUrl)) {
        continue;
      }
      const ok = await tryLogoUrl(directoryPath, fileUrl, urlBySavedFile, rejectedUrls, {
        sourcePhase: 'wikipedia',
        officialHosts
      });
      if (ok) {
        source = 'wikipedia';
        console.log(`[logo] Wikipedia logo saved: ${fileUrl}`);
        break;
      }
      excludeUrls.add(fileUrl);
      rejectedUrls.push(fileUrl);
      if (wikiHostTracker.recordFailure(fileUrl)) {
        break;
      }
    }
  }

  if (countLogoFiles(directoryPath) < CANONICAL_LOGO_COUNT && braveQueries.length > 0) {
    console.log(`[logo] Phase 3 — image search (provider=${resolveImageSearchProvider()})…`);
    const brave = await collectAndDownloadValidAssetUrls('logos', directoryPath, braveQueries, {
      targetCount: CANONICAL_LOGO_COUNT,
      candidatePool: braveLogoCandidatePool(),
      excludeUrls,
      clearFolder: false,
      officialHosts,
      prioritizeUrls: [],
      logoScoring: {
        productName: context.productName,
        companyName: context.companyName,
        brandName: context.brandName
      }
    });
    rejectedUrls.push(...brave.rejectedUrls);
    if (brave.count > 0) {
      source = 'brave';
      for (const fileUrl of brave.downloadedUrls) {
        for (const name of listAssetImageFiles(directoryPath, 'logos')) {
          if (!urlBySavedFile.has(name)) {
            urlBySavedFile.set(name, fileUrl);
          }
        }
      }
    }
  }

  const { kept, removed } = await enforceSingleCanonicalLogo(directoryPath);
  if (removed.length > 0) {
    console.log(`[logo] Canonical logo kept: ${kept ?? 'none'} (removed ${String(removed.length)} extra file(s))`);
  }

  let downloadedUrls: string[] = [];
  if (kept !== null) {
    const keptUrl = urlBySavedFile.get(basename(kept)) ?? urlBySavedFile.get(kept);
    if (keptUrl !== undefined) {
      downloadedUrls = [ keptUrl ];
    }
  }

  return {
    downloadedUrls,
    count: downloadedUrls.length,
    rejectedUrls,
    source
  };
}

// ===== reference-url-preflight.mts =====
const STUDIO_PREFLIGHT_BUDGET_MS = 28_000;
const IMAGE_PROBE_TIMEOUT_MS = 8_000;

export type ReferencePreflightStatus =
  | 'ok'
  | 'warning'
  | 'blocked'
  | 'unreachable'
  | 'invalid';

export type ReferencePreflightResult = {
  status: ReferencePreflightStatus;
  normalizedUrl: string;
  pageStatus: number | null;
  message: string;
  details?: {
    productProbeOk: boolean;
    logoProbeOk: boolean;
    candidateCount: number;
  };
};

function probeErrorIsBlocked (err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const statusMatch =
    /HEAD request failed with status (\d{3})/iu.exec(err.message) ??
    /failed with status[:\s]+(\d{3})/iu.exec(err.message);
  if (statusMatch !== null && statusMatch[1] !== undefined) {
    return isCrawlBlockedHttpStatus(Number.parseInt(statusMatch[1], 10));
  }
  return false;
}

async function probeImageUrl (url: string): Promise<{ ok: boolean; blocked: boolean }> {
  try {
    await Promise.race([
      resolveRemoteImageMetadata(url),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Image probe timed out'));
        }, IMAGE_PROBE_TIMEOUT_MS);
      })
    ]);
    return { ok: true, blocked: false };
  } catch (err: unknown) {
    return { ok: false, blocked: probeErrorIsBlocked(err) };
  }
}

async function withStudioPreflightBudget<T> (work: () => Promise<T>): Promise<T> {
  return Promise.race([
    work(),
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('STUDIO_PREFLIGHT_TIMEOUT'));
      }, STUDIO_PREFLIGHT_BUDGET_MS);
    })
  ]);
}

/**
 * Studio / API check before launching style-guide: page reachability + sample asset probes.
 */
export async function preflightReferenceUrlForStudio (
  rawUrl: string
): Promise<ReferencePreflightResult> {
  try {
    return await withStudioPreflightBudget(() => preflightReferenceUrlForStudioInner(rawUrl));
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'STUDIO_PREFLIGHT_TIMEOUT') {
      return {
        status: 'warning',
        normalizedUrl: rawUrl.trim(),
        pageStatus: null,
        message:
          'Délai dépassé lors de la vérification (site lent ou anti-bot). ' +
          'Vous pouvez lancer la génération — le pipeline tentera le crawl complet.'
      };
    }
    throw err;
  }
}

async function preflightReferenceUrlForStudioInner (
  rawUrl: string
): Promise<ReferencePreflightResult> {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return {
      status: 'invalid',
      normalizedUrl: trimmed,
      pageStatus: null,
      message: 'URL vide.'
    };
  }
  try {
    new URL(trimmed);
  } catch {
    return {
      status: 'invalid',
      normalizedUrl: trimmed,
      pageStatus: null,
      message: 'URL invalide.'
    };
  }

  const page = await preflightCampaignReferenceUrl(trimmed);
  if (page.timedOut) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: null,
      message:
        'Connexion au site trop lente (timeout, fréquent sur Uniqlo). ' +
        'Vous pouvez lancer la génération — le crawl complet sera tenté au lancement.'
    };
  }
  if (page.blocked) {
    return {
      status: 'blocked',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        `Ce site bloque l'accès automatique (HTTP ${String(page.status)}). ` +
        'Choisissez une autre URL de référence (autre domaine ou page produit).'
    };
  }
  if (!page.reachable) {
    return {
      status: 'unreachable',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        page.status === null
          ? "Impossible de joindre cette URL (réseau ou pare-feu). Vérifiez l'adresse."
          : `URL inaccessible (HTTP ${String(page.status)}). Vérifiez l'adresse.`
    };
  }

  const ctx: ImageSearchContext = {
    brandName: '',
    companyName: '',
    productName: '',
    brandURL: page.normalizedUrl,
    campaignReferenceUrl: page.normalizedUrl
  };
  const hosts = hostsFromImageContext(ctx);
  const { html, blocked, status } = await fetchOfficialPageHtml(
    page.normalizedUrl,
    'preflight-reference'
  );

  if (blocked) {
    return {
      status: 'blocked',
      normalizedUrl: page.normalizedUrl,
      pageStatus: status,
      message:
        `La page répond mais bloque le crawl (HTTP ${String(status)}). Utilisez une autre URL.`
    };
  }
  if (html === null || html.length < 200) {
    return {
      status: 'unreachable',
      normalizedUrl: page.normalizedUrl,
      pageStatus: status,
      message:
        'Page atteinte mais contenu HTML insuffisant pour extraire des visuels. Essayez une page produit plus détaillée.'
    };
  }

  const products = extractProductCandidatesFromHtml(html, page.normalizedUrl, hosts);
  const logos = extractLogoCandidatesFromHtml(html, page.normalizedUrl, hosts);
  const topProduct = products[0]?.url;
  const topLogo = logos[0]?.url;

  let productProbeOk = false;
  let logoProbeOk = false;
  let anyProbeBlocked = false;

  if (topProduct !== undefined) {
    const probe = await probeImageUrl(topProduct);
    productProbeOk = probe.ok;
    anyProbeBlocked = anyProbeBlocked || probe.blocked;
  }
  if (topLogo !== undefined) {
    const probe = await probeImageUrl(topLogo);
    logoProbeOk = probe.ok;
    anyProbeBlocked = anyProbeBlocked || probe.blocked;
  }

  const candidateCount = products.length + logos.length;
  const details = { productProbeOk, logoProbeOk, candidateCount };

  if (candidateCount === 0) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        "Page accessible mais aucune image produit/logo détectée. La génération utilisera surtout la recherche d'images.",
      details
    };
  }

  if (!productProbeOk && !logoProbeOk && anyProbeBlocked) {
    return {
      status: 'blocked',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        "Les ressources images de cette page sont bloquées pour le téléchargement automatique. Changez d'URL ou utilisez un site miroir.",
      details
    };
  }

  if (!productProbeOk && !logoProbeOk) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        'Page accessible mais les images officielles ne sont pas téléchargeables. Wikipedia / Brave seront utilisés.',
      details
    };
  }

  if (productProbeOk && !logoProbeOk) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        'Produits OK sur cette page ; logo officiel peut nécessiter Wikipedia / Brave.',
      details
    };
  }

  return {
    status: 'ok',
    normalizedUrl: page.normalizedUrl,
    pageStatus: page.status,
    message: 'URL de référence accessible ; ressources images utilisables.',
    details
  };
}


// ============================================================
// MODULE: codegen
// ============================================================
// Auto-merged module: codegen. Sources: creative-native-skills-compact, creative-native-codegen-presets, creative-native-codegen-regen, creative-native-ad-dom, creative-native-skills, creative-native-codegen-plan, creative-native-codegen-parallel, creative-native-codegen-prompt, creative-native-codegen-loop, bundle-asset-refs, creative-bundle-assets, generic-ad-config, creative-code-versions, creative-asset-descriptions, creative-native-generate.













// ===== creative-native-skills-compact.mts =====
/**
 * Condensed design constraints for creative-native LLM prompts.
 * Full skill files remain in .claude/.skills/ for optional CREATIVE_USE_FULL_SKILLS=1.
 */
export const CREATIVE_DESIGN_SKILLS_COMPACT = `
## Mandatory design checklist (compact)

### Layout and hierarchy
- One clear focal point per ad frame; logo visible at readable scale (not tiny, not dominant).
- Respect exact IAB pixel dimensions per format wrapper; center single-format demos on the page.
- Use consistent spacing scale (4/8/12/16/24 px); avoid cramped or floating elements.
- Safe margins inside the ad frame: leave visible breathing room on all sides; the primary CTA must not sit flush against the bottom edge of #ad-{formatId} (footer padding or margin on the CTA).

### Color
- Use ONLY hex colors from the style guide primary and secondary palettes in CSS.
- Gradients/shadows: only palette hex + opacity or rgba(); never darken/lighten into a new hex.
- Sufficient contrast for text on backgrounds (WCAG-minded: avoid light-on-light).
- One accent color for CTA; do not invent new brand colors.

### Typography
- Use ONLY font families listed in the style guide typography array.
- Clear hierarchy: headline > subhead > body > legal/CTA; limit to 2–3 sizes per frame.
- French ad copy; short punchy headlines.

### Creative format (priority)
- Lead with an innovative, interactive ad concept — the format experience matters more than how many product images you show.
- Prefer distinctive interactions: kinetic typography, layered depth/parallax, split composition, ambient hero motion, CTA pulse, hover/tap feedback — motion on visible content, not content gating.
- A plain image carousel/slider is acceptable only when it clearly serves the concept — never default to it because multiple assets are available.
- One product image is enough for a rich dynamic format; multiple images are optional garnish, not a layout driver.

### Motion and interaction
- CSS animations and JS-driven state changes (transitions, keyframes); no external animation libraries.
- Visible feedback on hover/tap for every interactive control.
- Respect reduced-motion: avoid seizure-inducing flashes; keep loops smooth.

### Assets
- Reference ONLY local ./filename paths for logos and products provided in the user message.
- Do not fetch or embed remote images, fonts, or scripts.
- SVG logos via <img src="./file.svg">; no filters on logos.

### Dark mode
- If a dark palette exists in the style guide, ensure logo remains visible (swap theme if needed).

### Output discipline
- Plain HTML5 + CSS + JS only; file:// compatible; no build tools, React, Tailwind, or npm.
`.trim();

export function isFullSkillsModeEnabled (): boolean {
  return process.env['CREATIVE_USE_FULL_SKILLS']?.trim() === '1';
}

// ===== creative-native-codegen-presets.mts =====
/**
 * Studio / CLI presets → env vars for creative codegen (gen-creative-code-native).
 */

export type CreativeCodegenPresetId = 'fast' | 'balanced' | 'quality';

export type CreativeCodegenPresetEnv = Record<string, string>;

const PRESETS: Record<CreativeCodegenPresetId, CreativeCodegenPresetEnv> = {
  fast: {
    CREATIVE_MODEL: 'claude-sonnet-4-6',
    CREATIVE_THINKING_MODE: 'off',
    CREATIVE_PROMPT_CACHE: '0'
  },
  balanced: {
    CREATIVE_MODEL: 'claude-sonnet-4-6',
    CREATIVE_THINKING_MODE: 'adaptive',
    CREATIVE_PROMPT_CACHE: '1'
  },
  quality: {
    CREATIVE_MODEL: 'claude-opus-4-6',
    CREATIVE_THINKING_MODE: 'adaptive',
    CREATIVE_PROMPT_CACHE: '1'
  }
};

export function isCreativeCodegenPresetId (value: string): value is CreativeCodegenPresetId {
  return value === 'fast' || value === 'balanced' || value === 'quality';
}

export function envForCreativeCodegenPreset (preset: CreativeCodegenPresetId): CreativeCodegenPresetEnv {
  return { ...PRESETS[preset] };
}

// ===== creative-native-codegen-regen.mts =====
const ROOT_FILES = [ 'index.html', 'styles.css', 'app.js' ] as const;

export type CodeBundleFile = {
  fileName: (typeof ROOT_FILES)[number];
  fileContent: string;
  truncated: boolean;
};

export type ExistingCodeBundle = {
  files: CodeBundleFile[];
};

function regenMaxFileChars (): number {
  const raw = process.env['CREATIVE_REGEN_MAX_FILE_CHARS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 80_000;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 1000 ? n : 80_000;
}

export function uiReviewMaxFileChars (): number {
  const raw = process.env['CREATIVE_UI_REVIEW_MAX_FILE_CHARS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 20_000;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 1000 ? n : 20_000;
}

export function isUiReviewIncludeCodeEnabled (): boolean {
  const raw = process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE']?.trim();
  if (raw === undefined || raw.length === 0) {
    return true;
  }
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

function truncateContent (content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, maxChars)}\n\n/* … truncated for prompt (${String(content.length)} chars total) */`,
    truncated: true
  };
}

function loadCodeBundle (codeDirectoryPath: string, maxChars: number): ExistingCodeBundle {
  const files: CodeBundleFile[] = [];

  for (const fileName of ROOT_FILES) {
    const filePath = join(codeDirectoryPath, fileName);
    if (!existsSync(filePath)) {
      throw new Error(
        `Code bundle requires existing ${fileName} at ${filePath}. Run initial generation first.`
      );
    }
    const raw = readFileSync(filePath, { encoding: 'utf8' });
    const { text, truncated } = truncateContent(raw, maxChars);
    files.push({ fileName, fileContent: text, truncated });
  }

  return { files };
}

/** Load index.html, styles.css, app.js from code/ for corrective regen. */
export function loadExistingCodeBundle (codeDirectoryPath: string): ExistingCodeBundle {
  return loadCodeBundle(codeDirectoryPath, regenMaxFileChars());
}

/** Load bundle for UI review prompt (separate char limit from regen). */
export function loadCodeBundleForUiReview (codeDirectoryPath: string): ExistingCodeBundle {
  return loadCodeBundle(codeDirectoryPath, uiReviewMaxFileChars());
}

/** Format bundle for injection into the regen user message. */
export function formatExistingBundleForPrompt (bundle: ExistingCodeBundle): string {
  const anyTruncated = bundle.files.some((f) => f.truncated);
  const lineCounts = bundle.files
    .map((f) => `${f.fileName}: ${String(f.fileContent.split('\n').length)} lines`)
    .join(', ');
  const header =
    '--- EXISTING CODE BUNDLE (patch this; do NOT replace with a new design or layout) ---' +
    `\nLine counts: ${lineCounts}. Your output must stay within ~5% line changes per file unless a blocker explicitly requires more.` +
    (anyTruncated ? '\n(Some files were truncated for context limits; preserve structure and fix blockers only.)' : '');

  const sections = bundle.files.map(
    (f) => `### ${f.fileName}\n\`\`\`\n${f.fileContent}\n\`\`\``
  );

  return `${header}\n\n${sections.join('\n\n')}`;
}

/** Format bundle for injection into the UI review user message. */
export function formatBundleForUiReviewPrompt (bundle: ExistingCodeBundle): string {
  const anyTruncated = bundle.files.some((f) => f.truncated);
  const lineCounts = bundle.files
    .map((f) => `${f.fileName}: ${String(f.fileContent.split('\n').length)} lines`)
    .join(', ');
  const header =
    '--- SOURCE BUNDLE (interpret screenshots with this code) ---' +
    '\nUse code to distinguish transient animation from real layout bugs.' +
    '\nAnimated-state partial text from kinetic JS/CSS is NOT a blocker if settled shows full copy.' +
    `\nLine counts: ${lineCounts}.` +
    (anyTruncated ? '\n(Some files were truncated for context limits.)' : '');

  const sections = bundle.files.map(
    (f) => `### ${f.fileName}\n\`\`\`\n${f.fileContent}\n\`\`\``
  );

  return `${header}\n\n${sections.join('\n\n')}`;
}

// ===== creative-native-ad-dom.mts =====
/** DOM id used by Playwright capture and UI review (must match screenshot selectors). */
export function formatIdToAdDomId (formatId: string): string {
  return `ad-${formatId.replace(/×/g, 'x')}`;
}

export function htmlContainsAdDomId (html: string, domId: string): boolean {
  const re = new RegExp(`\\bid=["']${domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'iu');
  return re.test(html);
}

/** Ad units present in HTML but not in the selected format list (e.g. unrequested arche companions). */
export function findUnselectedAdUnitsInHtml (
  html: string,
  formats: readonly AdFormatSelection[]
): string[] {
  const allowedIds = new Set(formats.map((f) => f.id));
  const allowedDomIds = new Set(formats.map((f) => formatIdToAdDomId(f.id)));
  const extras: string[] = [];
  const seen = new Set<string>();

  const addExtra = (label: string): void => {
    if (!seen.has(label)) {
      seen.add(label);
      extras.push(label);
    }
  };

  for (const m of html.matchAll(/\bdata-format=["']([^"']+)["']/giu)) {
    const fmt = m[1] ?? '';
    if (fmt === 'arche') {
      if (!formats.some((f) => f.arche !== undefined)) {
        addExtra('arche');
      }
      continue;
    }
    if (!allowedIds.has(fmt)) {
      addExtra(fmt);
    }
  }

  for (const m of html.matchAll(/\bid=["']ad-companion-([^"']+)["']/giu)) {
    const fmt = m[1] ?? '';
    if (!allowedIds.has(fmt)) {
      addExtra(fmt);
    }
  }

  for (const m of html.matchAll(/\bid=["'](ad-[^"']+)["']/giu)) {
    const fullId = m[1] ?? '';
    if (fullId.startsWith('ad-companion-')) {
      continue;
    }
    if (allowedDomIds.has(fullId)) {
      continue;
    }
    addExtra(fullId.slice(3));
  }

  return extras;
}

/**
 * Ensures each format has a visible root with id="ad-{formatId}" for Playwright.
 * Adds id to the first `.ad-frame` or dimension-matching wrapper when missing.
 */
export function ensureAdFormatDomIdsInHtml (
  html: string,
  formats: readonly AdFormatSelection[]
): { html: string; fixedFormatIds: string[] } {
  let out = html;
  const fixedFormatIds: string[] = [];

  for (const format of formats) {
    const domId = formatIdToAdDomId(format.id);
    if (htmlContainsAdDomId(out, domId)) {
      continue;
    }

    const adFrameRe =
      /(<(?:div|section|article)\b[^>]*\bclass=["'][^"']*\bad-frame\b[^"']*["'][^>]*)(>)/iu;
    if (adFrameRe.test(out)) {
      out = out.replace(adFrameRe, (match, openTag: string, close: string) => {
        if (/\bid\s*=/iu.test(openTag)) {
          return match.replace(/\bid\s*=\s*["'][^"']*["']/iu, `id="${domId}"`);
        }
        return `${openTag} id="${domId}"${close}`;
      });
      fixedFormatIds.push(format.id);
      continue;
    }

    const wrapperRe = new RegExp(
      `(<(?:div|section|article)\\b[^>]*\\bclass=["'][^"']*\\bad-wrapper\\b[^"']*["'][^>]*)(>)`,
      'iu'
    );
    if (wrapperRe.test(out)) {
      out = out.replace(wrapperRe, (match, openTag: string, close: string) => {
        if (/\bid\s*=/iu.test(openTag)) {
          return match.replace(/\bid\s*=\s*["'][^"']*["']/iu, `id="${domId}"`);
        }
        return `${openTag} id="${domId}"${close}`;
      });
      fixedFormatIds.push(format.id);
    }
  }

  return { html: out, fixedFormatIds };
}

export function appendAdFormatDimensionRules (
  css: string,
  formats: readonly AdFormatSelection[]
): { css: string; appended: boolean } {
  const missing: string[] = [];
  for (const format of formats) {
    const domId = formatIdToAdDomId(format.id);
    const selectorRe = new RegExp(`#${domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u');
    if (!selectorRe.test(css)) {
      missing.push(
        `#${domId} {\n  width: ${String(format.width)}px;\n  height: ${String(format.height)}px;\n  position: relative;\n  overflow: hidden;\n}\n`
      );
    }
  }
  if (missing.length === 0) {
    return { css, appended: false };
  }
  return {
    css: `${css.trimEnd()}\n\n/* Playwright / IAB capture hooks */\n${missing.join('\n')}`,
    appended: true
  };
}

// ===== creative-native-skills.mts =====
export const designSkillFiles = [
  '.claude/.skills/ui-design/commands/design-screen.md',
  '.claude/.skills/ui-design/commands/color-palette.md',
  '.claude/.skills/ui-design/commands/type-system.md',
  '.claude/.skills/ui-design/skills/color-system/SKILL.md',
  '.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md',
  '.claude/.skills/ui-design/skills/layout-grid/SKILL.md',
  '.claude/.skills/ui-design/skills/responsive-design/SKILL.md',
  '.claude/.skills/ui-design/skills/typography-scale/SKILL.md',
  '.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md',
  '.claude/.skills/interaction-design/skills/animation-principles/SKILL.md',
  '.claude/.skills/interaction-design/skills/feedback-patterns/SKILL.md',
  '.claude/.skills/interaction-design/skills/micro-interaction-spec/SKILL.md'
] as const;

export function loadDesignSkillGuidance (repoRoot?: string): string {
  const rootDir = repoRoot ?? join(import.meta.dirname, '..', '..');
  const loadedSkills = designSkillFiles
    .map((relativePath) => {
      const absolutePath = join(rootDir, relativePath);

      if (!existsSync(absolutePath)) {
        return null;
      }

      const content = readFileSync(absolutePath, 'utf8').trim();
      return `### ${relativePath}\n${content}`;
    })
    .filter((value): value is string => value !== null);

  if (loadedSkills.length === 0) {
    throw new Error('No local design skill files were found in .claude/.skills.');
  }

  return loadedSkills.join('\n\n');
}

export interface AssetFile {
  fileName: string;
  filePath: string;
  fileType: 'logos' | 'products';
}

export const creativeNativeCodeFileEntrySchema = z
  .object({
    fileName: z.string().describe('File name'),
    fileContent: z.string().describe('File code content')
  })
  .strict()
  .describe('Code file details');

export const creativeNativeStructuredOutputFilesSchema = z
  .array(creativeNativeCodeFileEntrySchema)
  .describe('List of code files');

export type CreativeNativeCodeFileList = z.infer<typeof creativeNativeStructuredOutputFilesSchema>;

function extractHexColorsFromCss (content: string): Set<string> {
  const matches = content.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  return new Set(
    matches
      .map((hexValue) => normalizeHexColorBare(hexValue))
      .filter((hexValue) => hexValue.length === 6)
  );
}

export function validateCreativeSkillCompliance (
  files: CreativeNativeCodeFileList,
  currentStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>,
  assetFiles: AssetFile[],
  adFormats?: readonly AdFormatSelection[]
): { ok: true } | { ok: false; issues: string[] } {
  const normalizeGeneratedPath = (fileName: string): string =>
    fileName.replace(/\\/g, '/').toLowerCase();

  const indexFile = files.find((file) => normalizeGeneratedPath(file.fileName) === 'index.html');
  if (indexFile === undefined) {
    return { ok: false, issues: [ 'Missing index.html at project root.' ] };
  }

  const stylesFile = files.find((file) => normalizeGeneratedPath(file.fileName) === 'styles.css');
  const appJsFile = files.find((file) => normalizeGeneratedPath(file.fileName) === 'app.js');
  if (stylesFile === undefined) {
    return { ok: false, issues: [ 'Missing styles.css at project root (CSS pur, sans préprocesseur).' ] };
  }
  if (appJsFile === undefined) {
    return { ok: false, issues: [ 'Missing app.js at project root (JavaScript vanilla, sans bundler).' ] };
  }

  const issues: string[] = [];
  const allContent = files.map((file) => file.fileContent).join('\n');
  const allContentLower = allContent.toLowerCase();

  const forbiddenLockfiles = new Set([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb'
  ]);
  for (const file of files) {
    const base = (normalizeGeneratedPath(file.fileName).split('/').pop() ?? '');
    if (forbiddenLockfiles.has(base)) {
      issues.push(`Fichier interdit pour une sortie statique native : ${file.fileName}`);
    }
    const leaf = file.fileName.replace(/\\/g, '/').split('/').pop() ?? '';
    if (/^vite\.config\.(ts|js|mts|mjs|cjs)$/i.test(leaf)) {
      issues.push(`Configuration de build interdite : ${file.fileName}`);
    }
    if (/tailwind\.config\./i.test(leaf) || /postcss\.config\./i.test(leaf)) {
      issues.push(`Fichier d’outil CSS interdit : ${file.fileName}`);
    }
    if (/\.(jsx|tsx)$/i.test(file.fileName)) {
      issues.push(`Fichier React/JSX interdit : ${file.fileName} (utiliser uniquement .html et .js).`);
    }
  }

  if (!/(href|src)\s*=\s*["'][^"']*styles\.css["']/i.test(indexFile.fileContent)) {
    issues.push('index.html doit référencer styles.css (ex. <link rel="stylesheet" href="styles.css">).');
  }
  if (!/src\s*=\s*["'][^"']*app\.js["']/i.test(indexFile.fileContent)) {
    issues.push('index.html doit référencer app.js (ex. <script src="app.js" defer></script>).');
  }

  const forbiddenSnippets: Array<[ string, string ]> = [
    [ 'from "react"', 'React (import)' ],
    [ "from 'react'", 'React (import)' ],
    [ 'from "react-dom"', 'react-dom' ],
    [ "from 'react-dom'", 'react-dom' ],
    [ '@vitejs/', 'Vite' ],
    [ 'tailwindcss', 'Tailwind CSS' ],
    [ 'daisyui', 'DaisyUI' ],
    [ 'createRoot(', 'React createRoot' ],
    [ 'react/jsx-runtime', 'JSX runtime React' ]
  ];
  for (const [ needle, label ] of forbiddenSnippets) {
    if (allContentLower.includes(needle.toLowerCase())) {
      issues.push(`Le code ne doit pas dépendre de frameworks ou d’outils de build (détecté : ${label}).`);
    }
  }

  const fontIssue = getFontComplianceIssue(allContent, currentStyleGuide);
  if (fontIssue !== null) {
    issues.push(fontIssue);
  }

  const allowedColors = styleGuideAllowedHexBareSet(currentStyleGuide);
  const usedHexColors = extractHexColorsFromCss(allContent);
  const unknownHexColors = Array.from(usedHexColors).filter((hexColor) => !allowedColors.has(hexColor));
  if (unknownHexColors.length > 0) {
    issues.push(`Contains colors outside style guide palettes: ${unknownHexColors.slice(0, 10).join(', ')}`);
  }

  const logoAssets = assetFiles.filter((asset) => asset.fileType === 'logos');
  const productAssets = assetFiles.filter((asset) => asset.fileType === 'products');
  const hasLogoReference = logoAssets.some((asset) => allContentLower.includes(asset.fileName.toLowerCase()));
  const hasProductReference = productAssets.some((asset) => allContentLower.includes(asset.fileName.toLowerCase()));
  if (!hasLogoReference) {
    issues.push('Missing at least one local logo asset reference in generated files.');
  }
  if (!hasProductReference) {
    issues.push('Missing at least one local product asset reference in generated files.');
  }

  if (adFormats !== undefined && adFormats.length > 0) {
    for (const format of adFormats) {
      const domId = formatIdToAdDomId(format.id);
      if (!htmlContainsAdDomId(indexFile.fileContent, domId)) {
        issues.push(
          `index.html must expose the ad root as id="${domId}" (${String(format.width)}×${String(format.height)} px) for capture.`
        );
      }
    }
    const unselectedUnits = findUnselectedAdUnitsInHtml(indexFile.fileContent, adFormats);
    if (unselectedUnits.length > 0) {
      issues.push(
        `index.html contains ad unit(s) for format(s) not requested: ${unselectedUnits.join(', ')}. `
        + `Generate only: ${adFormats.map((f) => f.id).join(', ')}.`
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true };
}

// ===== creative-native-codegen-plan.mts =====
export const creativeNativePlanSchema = z
  .object({
    creativeConcept: z.string().describe(
      'One-sentence innovative ad concept in French — interaction/format-led, not asset-count-led'
    ),
    formats: z
      .array(
        z
          .object({
            formatId: z.string(),
            layoutSummary: z.string(),
            keyInteractions: z.string().describe(
              'Primary interactive mechanic for this format (e.g. kinetic type, ambient particles, CTA pulse) — no tap/scratch reveal that hides logo or product'
            ),
            headlineFrench: z.string(),
            ctaFrench: z.string()
          })
          .strict()
      )
      .min(1),
    colorUsageNotes: z.string(),
    typographyNotes: z.string()
  })
  .strict()
  .describe('Creative plan before HTML/CSS/JS implementation');

export type CreativeNativePlan = z.infer<typeof creativeNativePlanSchema>;

export function buildPlanPhaseUserMessage (adFormats: readonly AdFormatSelection[]): string {
  const sizes = adFormats.map((f) => `${f.id} (${String(f.width)}×${String(f.height)} px)`).join(', ');
  return (
    'Phase 1 — planning only. Using the style guide JSON and local assets above, produce a structured creative plan. '
    + `Cover every required format: ${sizes}. `
    + 'Lead with an innovative, interactive format concept per frame; asset count (one or many images) is secondary. '
    + 'Do not default to a generic carousel/slider. Do not output HTML/CSS/JS yet.'
  );
}

export function slicePlanForFormat (plan: CreativeNativePlan, formatId: string): CreativeNativePlan {
  const formatEntry = plan.formats.find((entry) => entry.formatId === formatId);
  if (formatEntry === undefined) {
    return plan;
  }
  return { ...plan, formats: [ formatEntry ] };
}

export function buildCodePhaseUserMessage (
  plan: CreativeNativePlan,
  options?: { singleFormatId?: string }
): string {
  const effectivePlan =
    options?.singleFormatId !== undefined
      ? slicePlanForFormat(plan, options.singleFormatId)
      : plan;
  const formatScope =
    options?.singleFormatId !== undefined
      ? ` Implement ONLY format "${options.singleFormatId}" from this plan.`
      : '';
  return (
    'Phase 2 — implementation. Follow this approved creative plan exactly:\n\n'
    + `${JSON.stringify(effectivePlan, null, 2)}\n\n`
    + `Now output the structured file list (index.html, styles.css, app.js) implementing the plan.${formatScope} `
    + 'Use only local asset paths and style guide colors/fonts.'
  );
}

// ===== creative-native-codegen-parallel.mts =====
export function isParallelFormatCodegenEnabled (): boolean {
  return process.env['CREATIVE_PARALLEL_FORMATS']?.trim() === '1';
}

export function shouldUseParallelFormatCodegen (formats: readonly AdFormatSelection[]): boolean {
  return isParallelFormatCodegenEnabled() && formats.length > 1 && formats.every((f) => f.arche === undefined);
}

/**
 * Merge per-format file bundles into one multi-format creative (prototype).
 * Expects each bundle's index.html to contain a single ad unit; rewrites ids and concatenates CSS/JS.
 */
export function mergeParallelFormatBundles (
  bundles: Array<{ format: AdFormatSelection; files: CreativeNativeCodeFileList }>
): CreativeNativeCodeFileList {
  if (bundles.length === 0) {
    throw new Error('mergeParallelFormatBundles: empty bundles');
  }
  if (bundles.length === 1) {
    return bundles[0]!.files;
  }

  const htmlParts: string[] = [];
  const cssParts: string[] = [ '/* Merged multi-format creative (parallel generation) */' ];
  const jsParts: string[] = [ '(function () { "use strict";' ];

  for (const { format, files } of bundles) {
    const idx = files.find((f) => f.fileName.replace(/\\/g, '/').toLowerCase() === 'index.html');
    const css = files.find((f) => f.fileName.replace(/\\/g, '/').toLowerCase() === 'styles.css');
    const js = files.find((f) => f.fileName.replace(/\\/g, '/').toLowerCase() === 'app.js');
    const wrapperId = `ad-${format.id}`;

    if (idx !== undefined) {
      const bodyMatch = idx.fileContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const inner = bodyMatch !== null ? bodyMatch[1]!.trim() : idx.fileContent;
      htmlParts.push(
        `<section class="format-unit" id="${wrapperId}" data-format="${format.id}" aria-label="${format.id} ${String(format.width)}×${String(format.height)}">`,
        inner,
        '</section>'
      );
    }

    if (css !== undefined) {
      cssParts.push(`\n/* --- ${format.id} --- */\n`, css.fileContent);
    }
    if (js !== undefined) {
      jsParts.push(`\n/* --- ${format.id} --- */\n`, js.fileContent);
    }
  }

  const indexHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Creative native — multi-format</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="formats-gallery">
${htmlParts.map((p) => `    ${p}`).join('\n')}
  </div>
  <script src="app.js" defer></script>
</body>
</html>`;

  const stylesCss =
    '.formats-gallery { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px; min-height: 100vh; box-sizing: border-box; }\n'
    + '.format-unit { flex-shrink: 0; }\n'
    + cssParts.join('\n');

  const appJs = jsParts.join('\n') + '\n})();';

  return [
    { fileName: 'index.html', fileContent: indexHtml },
    { fileName: 'styles.css', fileContent: stylesCss },
    { fileName: 'app.js', fileContent: appJs }
  ];
}

// ===== creative-native-codegen-prompt.mts =====
export const DEFAULT_CREATIVE_MODEL = 'claude-opus-4-6';
export const DEFAULT_CREATIVE_REGEN_MODEL = 'claude-sonnet-4-6';

export function resolveCreativeModel (isRegen: boolean): string {
  if (isRegen) {
    return process.env['CREATIVE_REGEN_MODEL']?.trim() ?? DEFAULT_CREATIVE_REGEN_MODEL;
  }
  const fromEnv = process.env['CREATIVE_MODEL']?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_CREATIVE_MODEL;
}

/** Campaign product visuals — at least one per format; creative concept drives how many are shown. */
export function buildCampaignProductHeroInstruction (
  prunedStyleGuide: Pick<StyleGuide, 'productName' | 'brandName'>
): string {
  const product = prunedStyleGuide.productName?.trim() ?? '';
  const brand = prunedStyleGuide.brandName?.trim() ?? '';
  const label = product.length > 0 ? product : brand;
  if (label.length === 0) {
    return (
      'Each ad format must include at least one product visual from the provided assets (relative path ./filename). '
      + 'Pick the interaction concept first, then choose which asset(s) support it — one hero image is sufficient for a bold dynamic format. '
      + 'Do not substitute unrelated stock imagery.'
    );
  }
  return (
    `Campaign focus: "${label}". Each format must include at least one product visual from products/ `
    + '(relative path ./filename.jpg). Choose assets to serve the creative format — use one, a few, or many; '
    + 'displaying every file is never required. Do not substitute unrelated stock imagery.'
  );
}

/** Motion-first interaction patterns — logo and product hero stay visible on load. */
export const CREATIVE_MOTION_INTERACTION_IDEAS =
  'kinetic headline, floating particles, layered parallax, split or diagonal layout, '
  + 'ambient loop on hero, CTA pulse, hover/tap scale feedback, ken-burns on product, countdown pulse, '
  + 'interactive hotspots that highlight (not hide) the product';

/** Rules forbidding two-stage hide/reveal creatives. */
export const CREATIVE_NO_CONTENT_GATING_RULES = [
  'DO NOT build two-stage ads that hide logo, product hero, price, or primary CTA behind an overlay until user tap.',
  'FORBIDDEN: pre-reveal overlay, triggerReveal(), scratch-to-reveal, flip card that masks brand/product on load, "Appuyez pour révéler" gating.',
  'Logo and product packshot MUST be visible in the initial rendered state (opacity > 0, not display:none).',
  'Interaction = motion and feedback ON TOP of visible content — not content gating.',
  'Omit window.__CREATIVE_REVIEW__ on new creatives; do not require a revealed screenshot state.'
].join('\n');

/** Creative-format focus — always injected; asset count is secondary to the interaction concept. */
export function buildCreativeFormatFocusInstruction (productAssetCount: number): string {
  const assetNote =
    productAssetCount > 1
      ? `${String(productAssetCount)} product visuals are available — use only those that fit the concept (subset is fine). `
      : 'A single product visual is available — build a rich interactive format around it (motion, depth, typography). ';
  return (
    '**Creative format first**: invent an innovative, interactive, dynamic ad experience for the IAB frame. '
    + assetNote
    + `Interaction ideas (pick one strong concept, do not stack weak patterns): ${CREATIVE_MOTION_INTERACTION_IDEAS}. `
    + 'Avoid defaulting to a generic image carousel or dot-slider unless it is clearly the best fit for the concept.\n'
    + CREATIVE_NO_CONTENT_GATING_RULES
  );
}

/** @deprecated Use buildCreativeFormatFocusInstruction — kept as alias for callers. */
export function buildMultiAssetCreativeInstruction (productAssetCount: number): string {
  return buildCreativeFormatFocusInstruction(productAssetCount);
}

export function buildCreativeVersionsInstruction (formats: readonly AdFormatSelection[]): string {
  const n = formats.length;
  if (n <= 1) {
    return (
      'Create one innovative, interactive, dynamic layout for the required ad frame. '
      + 'The format experience (motion, interaction, hierarchy) is the creative priority — not the number of product images used.'
    );
  }
  if (n === 2) {
    return (
      'Create **one distinct innovative layout per required ad format** (2 total). ' +
      'Each format gets its own interaction concept and composition adapted to its aspect ratio — not a resized copy of the other.'
    );
  }
  return (
    `Create **one distinct innovative layout per required ad format** (${String(n)} formats). ` +
    'Each format should have a unique interactive concept and look while sharing brand tokens from the style guide.'
  );
}

export function loadSkillsForCodegenPrompt (repoRoot: string): string {
  if (isFullSkillsModeEnabled()) {
    return loadDesignSkillGuidance(repoRoot);
  }
  return CREATIVE_DESIGN_SKILLS_COMPACT;
}

export type CodegenSystemParts = {
  staticBlock: string;
  dynamicBlock: string;
};

export function buildRegenPatchSystemPrompt (params: {
  adFormats: readonly AdFormatSelection[];
  skillsText: string;
  styleGuide: StyleGuideCodegenHints;
}): string {
  return `You are patching an existing HTML5/CSS/JS advertisement bundle after a visual UI review.

The user message includes the CURRENT index.html, styles.css, and app.js. Your job is a **minimal corrective edit**, not a redesign.

Rules (strict):
- Fix ONLY issues described in the UI review feedback (blockers required; warns if easy).
- **Surgical patch only**: change the minimum lines needed (typically &lt; 5% of each file). Do NOT rewrite styles.css or index.html from scratch.
- If a fix is one CSS rule or one HTML attribute, change only that — leave all unrelated rules, selectors, animations, and copy unchanged.
- Preserve the existing creative concept, layout structure, DOM hierarchy, class names, and JS behavior unless a blocker requires a one-line structural fix.
- Do NOT invent a new format, new variant, or different visual concept.
- Do NOT add or remove IAB ad formats; keep the same format wrappers and ids (e.g. id="ad-{formatId}").
- Keep the same local asset paths (./logo.svg, product images) unless a blocker is about a wrong path.
- Return the complete updated index.html, styles.css, and app.js (structured output schema) — file bodies must be the existing code plus tiny edits, not a new design.
- When fixing capture/DOM issues: add or fix id="ad-{formatId}" and dimensions only — do not restyle the creative.
- When feedback mentions content-gating or hidden logo/product: remove pre-reveal overlay and triggerReveal; keep logo and hero product visible on load (${CREATIVE_NO_CONTENT_GATING_RULES.replace(/\n/g, '; ')}).

Stack: plain HTML5, CSS, JavaScript only. No React, bundlers, Tailwind, or npm. file:// compatible.

${buildCreativeAdFormatInstructions(params.adFormats)}

${buildStyleGuideColorConstraintText(params.styleGuide)}

${buildStyleGuideFontConstraintText(params.styleGuide)}

Ad copy in French.
Follow design skills for compliance on what you touch:
${params.skillsText}`.trim();
}

export function buildCodegenSystemParts (params: {
  isRegen: boolean;
  adFormats: readonly AdFormatSelection[];
  skillsText: string;
  styleGuide: StyleGuideCodegenHints;
  productAssetCount?: number;
}): CodegenSystemParts {
  if (params.isRegen) {
    return {
      staticBlock: buildRegenPatchSystemPrompt({
        adFormats: params.adFormats,
        skillsText: params.skillsText,
        styleGuide: params.styleGuide
      }),
      dynamicBlock: ''
    };
  }

  const productAssetCount = params.productAssetCount ?? 0;
  const creativeFormatInstruction = buildCreativeFormatFocusInstruction(productAssetCount);

  const staticBlock = `You are an agent that invents innovative, interactive, dynamic advertisement formats.

Required stack: plain HTML5, CSS, and JavaScript only. No React, Vue, Svelte, no Vite/Webpack,
no Tailwind/DaisyUI/npm dependencies, no JSX/TSX, no build step. The result must open from disk
(file://) in a browser when index.html is loaded.

${creativeFormatInstruction}

Assets: use ONLY the local logo and product files described in the user message (already downloaded and pre-described).
The "Visual description (authoritative)" lines in the user message are the ground truth for each asset — do NOT re-scan, re-describe, or infer new pixels; use only those descriptions and the local paths (e.g. ./product.jpg).
Do NOT search the web for new images, fonts, or brand facts — everything needed is in the style guide JSON and local assets.
${buildCreativeVersionsInstruction(params.adFormats)}

Graphic elements (fonts, colors, pictures) must follow only the JSON style guide from the user.
Your primary creative job is the **format experience**: surprising layout, motion, and interaction — not filling slides with every provided image.
Use CSS/JS animation, state changes, and micro-interactions boldly where they serve the concept.
Only use one logo image by default the light theme only; if the logo is not visible in the light theme, use the dark theme.
The logo should remain visible at a good scale; do not apply filters to the logo.
Logo and product images are local files copied next to index.html under code/. Reference them with
relative paths (e.g. ./brand-logo.svg or ./product.jpg). SVG logos: <img src="./filename.svg">.

Output: a list of files with their contents. Paths must be relative to the project root.

You MUST output exactly these root files (no subfolders required for these three):
- index.html — viewport meta width=device-width; link to styles.css; script src app.js (defer recommended).
- styles.css — all presentation (no preprocessor).
- app.js — vanilla DOM scripting only (no import maps to npm).
- **No content gating:** ${CREATIVE_NO_CONTENT_GATING_RULES.replace(/\n/g, '\n  ')}

${buildCreativeAdFormatInstructions(params.adFormats)}

Optional: additional static assets only if needed (e.g. extra .svg), still no package.json or bundlers.

Fonts and colors: use ONLY hex colors from the closed allowlist in the user message and below.
For gradients/shadows use opacity or rgba() derived from a palette hex — never invent new hex codes.
Ad copy in French.
Include at least one logo and one product image from the provided assets in the HTML/CSS/JS.
Product visual integration is detailed in the user message (campaign product instruction).
Do not add browser chrome: no zoom, fullscreen, or VR toggles in the creative UI.

Gallery export (generic-config.json): follow style-guide-ui/public/ad-format-json-reference.md —
stable semantic classes: .eyebrow, .headline (accent inside <em> for headlineAccent), .subhead,
.body-copy, .ad-footer span for footer copy; plain Unicode in copy (no &amp; / &nbsp; in text nodes).
CTA: <a class="cta-btn" href="…"><span class="cta-label">Label</span></a> (export binds ctaText on the anchor only).
Skip non-editable chrome in the ad frame: no aria-hidden decorative layers (floating bubbles),
no ::before gradient strips on the ad root, no preview-only border-radius/box-shadow on the IAB wrapper.

The design skills below are brand compliance rules (colors, typography, logo visibility, IAB dimensions).
Prioritize innovative format design and dynamic interactions over safe template layouts; technical consistency is validated by the pipeline after generation.
Load brand typography via Google Fonts CDN only (see user message font constraints — no proprietary font names in CSS).
Follow the design skills below for brand compliance on color, typography, hierarchy, and interaction polish:
${params.skillsText}`.trim();

  const dynamicBlock = [
    buildStyleGuideColorConstraintText(params.styleGuide),
    buildStyleGuideFontConstraintText(params.styleGuide)
  ].join('\n\n');

  return { staticBlock, dynamicBlock };
}

/** System param with prompt caching on the static skills/stack block. */
export function buildCachedSystemParam (
  parts: CodegenSystemParts,
  extraDynamic?: string
): string | Anthropic.Messages.TextBlockParam[] {
  const useCache = process.env['CREATIVE_PROMPT_CACHE']?.trim() !== '0';
  const dynamicText = [ parts.dynamicBlock, extraDynamic ].filter((s) => s !== undefined && s.length > 0).join('\n\n');

  if (!useCache) {
    return dynamicText.length > 0 ? `${parts.staticBlock}\n\n${dynamicText}` : parts.staticBlock;
  }

  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: parts.staticBlock,
      cache_control: { type: 'ephemeral' }
    }
  ];
  if (dynamicText.length > 0) {
    blocks.push({ type: 'text', text: dynamicText });
  }
  return blocks;
}

export function buildInitialThinkingConfig (isRegen: boolean): Record<string, unknown> | undefined {
  if (isRegen) {
    return undefined;
  }
  const mode = process.env['CREATIVE_THINKING_MODE']?.trim() ?? 'adaptive';
  if (mode === 'off' || mode === 'disabled') {
    return undefined;
  }
  if (mode === 'budget') {
    const raw = process.env['CREATIVE_THINKING_BUDGET_TOKENS']?.trim() ?? '32000';
    const budget = Number.parseInt(raw, 10);
    return {
      thinking: {
        type: 'enabled' as const,
        budget_tokens: Number.isFinite(budget) && budget > 0 ? budget : 32_000,
        display: 'omitted' as const
      }
    };
  }
  return {
    thinking: {
      type: 'adaptive' as const,
      display: 'omitted' as const
    }
  };
}

// ===== creative-native-codegen-loop.mts =====
const CREATIVE_OPUS_MAX_OUTPUT_TOKENS = 128_000;
const CREATIVE_HAIKU_MAX_OUTPUT_TOKENS = 64_000;

export function maxOutputTokensForModel (model: string): number {
  return model.toLowerCase().includes('haiku')
    ? CREATIVE_HAIKU_MAX_OUTPUT_TOKENS
    : CREATIVE_OPUS_MAX_OUTPUT_TOKENS;
}

export type CodegenTurnTiming = {
  turn: number;
  duration_ms: number;
  stop_reason: string | null;
  /** Set when formats are generated in parallel (e.g. `banner 300x250`). */
  format_label?: string;
};

export type CodegenLoopResult = {
  files: CreativeNativeCodeFileList;
  usage: UsageAccumulator;
  timings: CodegenTurnTiming[];
  duration_ms_total: number;
};

function describeTurnForLogs (stopReason: Anthropic.Message['stop_reason']): string {
  return stopReason !== null && stopReason !== undefined ? `arrêt: ${stopReason}` : 'réponse API';
}

async function runSingleCodegenLoop (params: {
  anthropicClient: Anthropic;
  model: string;
  isRegen: boolean;
  systemParts: CodegenSystemParts;
  messages: Anthropic.Messages.MessageParam[];
  adFormats: readonly AdFormatSelection[];
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  assetFiles: AssetFile[];
  extraSystemDynamic?: string;
}): Promise<CodegenLoopResult> {
  const filesSchema = creativeNativeStructuredOutputFilesSchema;
  const usage = createEmptyUsageAccumulator();
  const timings: CodegenTurnTiming[] = [];
  const loopStart = Date.now();

  let codeFileList: CreativeNativeCodeFileList | null = null;
  let generationIndex = 0;
  const maxGenerationTurns = 8;
  let structuredOutputRetryCount = 0;
  const maxStructuredOutputRetries = 2;
  const messages = [ ...params.messages ];

  while (true) {
    generationIndex += 1;
    if (generationIndex > maxGenerationTurns) {
      throw new Error(`Generation exceeded ${maxGenerationTurns} turns without valid output.`);
    }

    const turnStart = Date.now();
    const thinkingConfig = buildInitialThinkingConfig(params.isRegen);

    const creativeCodeResponse = await withAnthropicRetry('creative generation', async () => {
      const streamParams: Anthropic.Messages.MessageCreateParams = {
        max_tokens: maxOutputTokensForModel(params.model),
        system: buildCachedSystemParam(params.systemParts, params.extraSystemDynamic),
        messages,
        model: params.model,
        output_config: {
          format: zodOutputFormat(filesSchema)
        },
        ...(thinkingConfig ?? {})
      };
      const stream = await params.anthropicClient.messages.stream(streamParams);
      return await stream.finalMessage();
    });

    const turnMs = Date.now() - turnStart;
    timings.push({
      turn: generationIndex,
      duration_ms: turnMs,
      stop_reason: creativeCodeResponse.stop_reason
    });
    const cacheRead = creativeCodeResponse.usage.cache_read_input_tokens ?? 0;
    const cacheCreate = creativeCodeResponse.usage.cache_creation_input_tokens ?? 0;
    console.log(
      `[creative-native] Turn ${String(generationIndex)}: ${formatDurationMinSec(turnMs)} — ${describeTurnForLogs(creativeCodeResponse.stop_reason)}`
        + (cacheRead > 0 || cacheCreate > 0
          ? ` (cache read ${String(cacheRead)}, create ${String(cacheCreate)})`
          : '')
    );

    addUsageToAccumulator(usage, creativeCodeResponse.usage);
    messages.push({ role: 'assistant', content: creativeCodeResponse.content });

    if (creativeCodeResponse.stop_reason !== 'tool_use') {
      const parsedFiles = creativeCodeResponse.parsed_output as CreativeNativeCodeFileList | null;
      if (parsedFiles !== null && parsedFiles.length > 0) {
        const complianceCheck = validateCreativeSkillCompliance(
          parsedFiles,
          params.prunedStyleGuide,
          params.assetFiles,
          params.adFormats
        );
        if (complianceCheck.ok) {
          codeFileList = parsedFiles;
          break;
        }

        structuredOutputRetryCount += 1;
        if (structuredOutputRetryCount > maxStructuredOutputRetries) {
          throw new Error(`AI output failed skill compliance checks: ${complianceCheck.issues.join(' | ')}`);
        }

        const regenHint = params.isRegen
          ? 'Apply a minimal patch to the existing bundle; do not rewrite unrelated CSS/HTML.'
          : 'Regenerate all files and fix every issue.';
        messages.push({
          role: 'user',
          content:
            `Your previous output is not compliant with mandatory skills/style-guide constraints: ${complianceCheck.issues.join(' ; ')}. `
            + `${regenHint} Required ad sizes (px): ${params.adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}.`
            + buildComplianceRetryHint(complianceCheck.issues, params.prunedStyleGuide)
        });
        continue;
      }

      structuredOutputRetryCount += 1;
      if (structuredOutputRetryCount > maxStructuredOutputRetries) {
        throw new Error('AI returned no structured code output after retries.');
      }

      messages.push({
        role: 'user',
        content:
          'Your previous response did not include the required structured file list. Respond now with only valid structured output matching the expected schema.'
      });
      continue;
    }

    messages.push({
      role: 'user',
      content:
        'Continue: return the structured file list (index.html, styles.css, app.js) matching the schema. '
        + `Respect every required ad size: ${params.adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}.`
    });
  }

  if (codeFileList === null || codeFileList.length === 0) {
    throw new Error('Missing or empty code file list returned by AI.');
  }

  return {
    files: codeFileList,
    usage,
    timings,
    duration_ms_total: Date.now() - loopStart
  };
}

async function runPlanPhase (params: {
  anthropicClient: Anthropic;
  model: string;
  systemParts: CodegenSystemParts;
  baseMessages: Anthropic.Messages.MessageParam[];
  adFormats: readonly AdFormatSelection[];
}): Promise<{ plan: CreativeNativePlan; usage: UsageAccumulator }> {
  const usage = createEmptyUsageAccumulator();
  const messages: Anthropic.Messages.MessageParam[] = [
    ...params.baseMessages,
    { role: 'user', content: buildPlanPhaseUserMessage(params.adFormats) }
  ];

  const planStart = Date.now();
  const planThinking = buildInitialThinkingConfig(false);
  const response = await withAnthropicRetry('creative plan phase', async () => {
    const stream = await params.anthropicClient.messages.stream({
      max_tokens: Math.min(16_000, maxOutputTokensForModel(params.model)),
      system: buildCachedSystemParam(params.systemParts),
      messages,
      model: params.model,
      output_config: { format: zodOutputFormat(creativeNativePlanSchema) },
      ...(planThinking ?? {})
    });
    return await stream.finalMessage();
  });
  console.log(`[creative-native] Plan phase: ${formatDurationMinSec(Date.now() - planStart)}`);

  addUsageToAccumulator(usage, response.usage);
  if (response.parsed_output === null) {
    throw new Error('Two-phase codegen: plan phase returned no structured output.');
  }
  return { plan: response.parsed_output, usage };
}

export async function runCreativeCodegen (params: {
  anthropicClient: Anthropic;
  model: string;
  isRegen: boolean;
  repoRoot: string;
  skillsText: string;
  baseMessages: Anthropic.Messages.MessageParam[];
  adFormats: readonly AdFormatSelection[];
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  assetFiles: AssetFile[];
}): Promise<CodegenLoopResult> {
  const productAssetCount = params.assetFiles.filter((a) => a.fileType === 'products').length;
  const systemParts = buildCodegenSystemParts({
    isRegen: params.isRegen,
    adFormats: params.adFormats,
    skillsText: params.skillsText,
    styleGuide: params.prunedStyleGuide,
    productAssetCount
  });

  if (params.isRegen) {
    return runSingleCodegenLoop({
      anthropicClient: params.anthropicClient,
      model: params.model,
      isRegen: true,
      systemParts,
      messages: params.baseMessages,
      adFormats: params.adFormats,
      prunedStyleGuide: params.prunedStyleGuide,
      assetFiles: params.assetFiles
    });
  }

  console.log('[creative-native] Two-phase generation (plan → code)');
  const codegenStart = Date.now();
  const { plan, usage: planUsage } = await runPlanPhase({
    anthropicClient: params.anthropicClient,
    model: params.model,
    systemParts,
    baseMessages: params.baseMessages,
    adFormats: params.adFormats
  });

  if (shouldUseParallelFormatCodegen(params.adFormats)) {
    console.log(
      `[creative-native] Parallel code phase (${String(params.adFormats.length)} formats, shared plan)`
    );
    const parallelUsage = createEmptyUsageAccumulator();
    mergeUsageAccumulators(parallelUsage, planUsage);
    const allTimings: CodegenTurnTiming[] = [];
    const bundles: Array<{ format: AdFormatSelection; files: CreativeNativeCodeFileList }> = [];

    const results = await Promise.all(
      params.adFormats.map(async (format) => {
        const singleFormat = [ format ] as const;
        const parts = buildCodegenSystemParts({
          isRegen: false,
          adFormats: singleFormat,
          skillsText: params.skillsText,
          styleGuide: params.prunedStyleGuide,
          productAssetCount
        });
        const formatInstructions = buildCreativeAdFormatInstructions(singleFormat);
        const extraDynamic = `Generate ONLY for this single format. ${formatInstructions}`;
        const codeMessages: Anthropic.Messages.MessageParam[] = [
          ...params.baseMessages,
          { role: 'user', content: buildCodePhaseUserMessage(plan, { singleFormatId: format.id }) }
        ];
        const result = await runSingleCodegenLoop({
          anthropicClient: params.anthropicClient,
          model: params.model,
          isRegen: false,
          systemParts: parts,
          messages: codeMessages,
          adFormats: singleFormat,
          prunedStyleGuide: params.prunedStyleGuide,
          assetFiles: params.assetFiles,
          extraSystemDynamic: extraDynamic
        });
        return { format, result };
      })
    );

    for (const { format, result } of results) {
      mergeUsageAccumulators(parallelUsage, result.usage);
      const formatLabel = `${format.id} ${String(format.width)}x${String(format.height)}`;
      for (const t of result.timings) {
        allTimings.push({ ...t, format_label: formatLabel });
      }
      bundles.push({ format, files: result.files });
    }

    const merged = mergeParallelFormatBundles(bundles);
    const compliance = validateCreativeSkillCompliance(
      merged,
      params.prunedStyleGuide,
      params.assetFiles,
      params.adFormats
    );
    if (compliance.ok) {
      return {
        files: merged,
        usage: parallelUsage,
        timings: allTimings,
        duration_ms_total: Date.now() - codegenStart
      };
    }
    console.warn(
      '[creative-native] Merged parallel bundle failed compliance; falling back to unified code phase.'
    );
  }

  const codeMessages: Anthropic.Messages.MessageParam[] = [
    ...params.baseMessages,
    { role: 'user', content: buildCodePhaseUserMessage(plan) }
  ];

  const codeResult = await runSingleCodegenLoop({
    anthropicClient: params.anthropicClient,
    model: params.model,
    isRegen: false,
    systemParts,
    messages: codeMessages,
    adFormats: params.adFormats,
    prunedStyleGuide: params.prunedStyleGuide,
    assetFiles: params.assetFiles
  });

  mergeUsageAccumulators(planUsage, codeResult.usage);
  return {
    files: codeResult.files,
    usage: planUsage,
    timings: codeResult.timings,
    duration_ms_total: Date.now() - codegenStart
  };
}

// ===== bundle-asset-refs.mts =====
function isRemoteOrDataRef (ref: string): boolean {
  const t = ref.trim();
  return t.startsWith('data:') || /^https?:\/\//iu.test(t);
}

export function isLocalAssetRef (ref: string): boolean {
  const t = ref.trim();
  return t.length > 0 && !isRemoteOrDataRef(t);
}

/** Nom de fichier plat pour un chemin local `./foo.png` (assets à la racine du bundle). */
export function normalizeLocalAssetFileName (ref: string): string {
  const trimmed = ref.trim().replace(/^\.\//u, '');
  const segments = trimmed.split(/[/\\]/u);
  return segments[segments.length - 1] ?? trimmed;
}

export function collectLocalAssetRefsFromSource (parts: {
  html?: string;
  css?: string;
  js?: string;
  imageUrls?: string[];
}): string[] {
  const seen = new Set<string>();
  const add = (ref: string | undefined): void => {
    if (ref !== undefined && isLocalAssetRef(ref)) {
      seen.add(ref);
    }
  };
  for (const u of parts.imageUrls ?? []) {
    add(u);
  }
  const html = parts.html ?? '';
  for (const m of html.matchAll(/\bsrc=["']([^"']+)["']/giu)) {
    add(m[1]);
  }
  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    add(m[1]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    add(m[1]);
  }
  const css = parts.css ?? '';
  const js = parts.js ?? '';
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    add(m[1]);
  }
  for (const m of js.matchAll(/["'](\.\/[^"']+)["']/giu)) {
    add(m[1]);
  }
  return [ ...seen ];
}

// ===== creative-bundle-assets.mts =====
const PROTECTED_BUNDLE_FILES = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'generic-config.json'
]);

const RUN_ASSET_SUBDIRS = [ 'products', 'logos' ] as const;

function normalizeComparableName (fileName: string): string {
  return fileName.replace(/\\/g, '/').toLowerCase();
}

function leafFileName (filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? normalized;
}

function codeFileContentsByLeaf (
  files: CreativeNativeCodeFileList
): { html?: string; css?: string; js?: string } {
  const out: { html?: string; css?: string; js?: string } = {};
  for (const file of files) {
    const leaf = normalizeComparableName(leafFileName(file.fileName));
    if (leaf === 'index.html') {
      out.html = file.fileContent;
    } else if (leaf === 'styles.css') {
      out.css = file.fileContent;
    } else if (leaf === 'app.js') {
      out.js = file.fileContent;
    }
  }
  return out;
}

function referencedNameMatches (fileName: string, referencedNames: Set<string>): boolean {
  const normalized = normalizeComparableName(fileName);
  for (const ref of referencedNames) {
    if (normalizeComparableName(ref) === normalized) {
      return true;
    }
  }
  return false;
}

function refsToFileNameSet (refs: string[]): Set<string> {
  const out = new Set<string>();
  for (const ref of refs) {
    out.add(normalizeLocalAssetFileName(ref));
  }
  return out;
}

function resolveAssetSourcePath (
  fileName: string,
  assetFiles: AssetFile[],
  runDirectoryPath?: string
): string | null {
  const normalized = normalizeComparableName(fileName);
  for (const assetFile of assetFiles) {
    if (normalizeComparableName(assetFile.fileName) === normalized) {
      return assetFile.filePath;
    }
  }
  if (runDirectoryPath === undefined) {
    return null;
  }
  for (const subdir of RUN_ASSET_SUBDIRS) {
    const candidate = join(runDirectoryPath, subdir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function collectReferencedAssetFileNamesFromCodeFiles (
  files: CreativeNativeCodeFileList
): Set<string> {
  return refsToFileNameSet(collectLocalAssetRefsFromSource(codeFileContentsByLeaf(files)));
}

export function collectReferencedAssetFileNamesFromBundleSource (parts: {
  html: string;
  css?: string;
  js?: string;
}): Set<string> {
  return refsToFileNameSet(collectLocalAssetRefsFromSource(parts));
}

export function copyReferencedCodegenAssets (params: {
  bundleDir: string;
  assetFiles: AssetFile[];
  referencedNames: Set<string>;
  runDirectoryPath?: string;
}): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const refName of params.referencedNames) {
    if (PROTECTED_BUNDLE_FILES.has(refName)) {
      continue;
    }
    const sourcePath = resolveAssetSourcePath(refName, params.assetFiles, params.runDirectoryPath);
    if (sourcePath === null) {
      missing.push(refName);
      console.warn(`[creative-native] Referenced asset missing from bundle sources: ${refName}`);
      continue;
    }
    copyFileSync(sourcePath, join(params.bundleDir, refName));
    copied.push(refName);
  }
  return { copied, missing };
}

export function pruneUnreferencedBundleImageAssets (
  bundleDir: string,
  referencedNames: Set<string>
): string[] {
  const removed: string[] = [];
  if (!existsSync(bundleDir)) {
    return removed;
  }
  for (const fileName of readdirSync(bundleDir)) {
    if (PROTECTED_BUNDLE_FILES.has(fileName) || !isAssetImageFileName(fileName)) {
      continue;
    }
    if (referencedNameMatches(fileName, referencedNames)) {
      continue;
    }
    unlinkSync(join(bundleDir, fileName));
    console.log(`[creative-native] Pruned unused bundle asset: ${fileName}`);
    removed.push(fileName);
  }
  return removed;
}

export function syncBundleAssetsFromCodeFiles (params: {
  bundleDir: string;
  codeFiles: CreativeNativeCodeFileList;
  assetFiles: AssetFile[];
  runDirectoryPath?: string;
}): { copied: string[]; removed: string[]; missing: string[] } {
  const referencedNames = collectReferencedAssetFileNamesFromCodeFiles(params.codeFiles);
  const copyParams: Parameters<typeof copyReferencedCodegenAssets>[0] = {
    bundleDir: params.bundleDir,
    assetFiles: params.assetFiles,
    referencedNames
  };
  if (params.runDirectoryPath !== undefined) {
    copyParams.runDirectoryPath = params.runDirectoryPath;
  }
  const { copied, missing } = copyReferencedCodegenAssets(copyParams);
  const removed = pruneUnreferencedBundleImageAssets(params.bundleDir, referencedNames);
  return { copied, removed, missing };
}

export function syncBundleAssetsFromBundleSource (params: {
  bundleDir: string;
  html: string;
  css: string;
  js: string;
}): string[] {
  const referencedNames = collectReferencedAssetFileNamesFromBundleSource(params);
  return pruneUnreferencedBundleImageAssets(params.bundleDir, referencedNames);
}

/** Re-copy referenced assets from run products/logos into an existing bundle (e.g. before UI review). */
export function healBundleAssetsFromRunDirectory (params: {
  bundleDir: string;
  runDirectoryPath: string;
  assetFiles?: AssetFile[];
}): { copied: string[]; missing: string[] } {
  const indexPath = join(params.bundleDir, 'index.html');
  if (!existsSync(indexPath)) {
    return { copied: [], missing: [] };
  }
  const html = readFileSync(indexPath, { encoding: 'utf8' });
  const stylesPath = join(params.bundleDir, 'styles.css');
  const jsPath = join(params.bundleDir, 'app.js');
  const css = existsSync(stylesPath) ? readFileSync(stylesPath, { encoding: 'utf8' }) : '';
  const js = existsSync(jsPath) ? readFileSync(jsPath, { encoding: 'utf8' }) : '';
  const referencedNames = collectReferencedAssetFileNamesFromBundleSource({ html, css, js });
  return copyReferencedCodegenAssets({
    bundleDir: params.bundleDir,
    assetFiles: params.assetFiles ?? [],
    referencedNames,
    runDirectoryPath: params.runDirectoryPath
  });
}

// ===== generic-ad-config.mts =====
export interface GenericTextField {
  text: string;
  font: string;
  size: number;
  weight: string;
  style: string;
  color: string;
}

/** Paramètres globaux — §1.4 / §2.4 (obligatoire, peut être `{}`). */
export interface GenericAdSettings {
  backgroundColor?: string;
  clickTag?: string;
  slideInterval?: number;
}

/** Config format `generic` — schéma strict ad-format-json-reference.md §2. */
export interface GenericAdConfig {
  type: 'generic';
  dimensions: { width: number; height: number };
  settings: GenericAdSettings;
  fields: Record<string, GenericTextField>;
  images: Record<string, string[]>;
  html: string;
  css?: string;
  js?: string;
}

/** Clés racine legacy refusées à l’import (§2.8). */
export const GENERIC_OBSOLETE_ROOT_KEYS = [
  'tagLine',
  'headline',
  'headlineAccent',
  'subhead',
  'ctaText',
  'legalText',
  'backgroundColor',
  'clickTag',
  'slideInterval',
  'bindings'
] as const;

interface StyleGuideSlice {
  brandURL?: string;
  primaryColorPalette?: string[];
  typography?: Array<{ fontFamily?: string; fontWeight?: number }>;
}

const DEFAULT_SLIDE_INTERVAL = 2800;
const DEFAULT_BG = '#000000';
const DEFAULT_CLICK = 'https://example.com';
const DEFAULT_FONT = 'Inter';
const DEFAULT_ACCENT_COLOR = '#EC1C24';
const DEFAULT_MUTED_COLOR = '#B0B3B8';
const DEFAULT_HEADLINE_COLOR = '#FFFFFF';

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);

const TEXT_DISCOVERY_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'a',
  'button',
  'label',
  'li',
  'div'
]);

interface DiscoveredText {
  key: string;
  innerHtml: string;
  openTag: string;
  gvType: 'text' | 'link';
}

function defaultTextField (
  text: string,
  overrides: Partial<GenericTextField> = {}
): GenericTextField {
  return normalizeTextStyle({
    text,
    font: DEFAULT_FONT,
    size: 12,
    weight: '500',
    style: 'normal',
    color: DEFAULT_MUTED_COLOR,
    ...overrides
  });
}

/** TextStyle conforme §1.1 ad-format-json-reference.md */
export function normalizeTextStyle (field: GenericTextField): GenericTextField {
  const weightRaw = field.weight;
  const weight =
    typeof weightRaw === 'number'
      ? String(weightRaw)
      : typeof weightRaw === 'string' && weightRaw.trim().length > 0
        ? weightRaw.trim()
        : '400';
  const sizeRaw = field.size;
  const size =
    typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw > 0
      ? Math.round(sizeRaw)
      : 12;
  return {
    text: typeof field.text === 'string' ? field.text : '',
    font: typeof field.font === 'string' && field.font.trim().length > 0 ? field.font.trim() : DEFAULT_FONT,
    size,
    weight,
    style: field.style === 'italic' ? 'italic' : 'normal',
    color:
      typeof field.color === 'string' && field.color.trim().length > 0
        ? field.color.trim()
        : DEFAULT_MUTED_COLOR
  };
}

export function htmlHasDataGvBind (html: string): boolean {
  return /\bdata-gv-bind=/iu.test(html);
}

export function htmlHasImageListBinding (html: string): boolean {
  return /data-gv-type=["']image-list["']/iu.test(html);
}

function validateTextStyleEntry (key: string, v: unknown): string | null {
  if (typeof v === 'string') {
    return null;
  }
  if (typeof v !== 'object' || v === null) {
    return `fields.${key} must be TextStyle or string.`;
  }
  const t = v as GenericTextField;
  if (typeof t.text !== 'string' || typeof t.font !== 'string' || typeof t.size !== 'number') {
    return `fields.${key}: invalid TextStyle (text, font, size required).`;
  }
  if (typeof t.weight !== 'string' || (t.style !== 'normal' && t.style !== 'italic')) {
    return `fields.${key}: invalid TextStyle (weight string, style normal|italic).`;
  }
  if (typeof t.color !== 'string') {
    return `fields.${key}: invalid TextStyle (color required).`;
  }
  return null;
}

/** Valide la config exportée (validateGenericConfig / référence §2). */
export function validateGenericAdConfig (
  config: unknown
): { ok: true; config: GenericAdConfig } | { ok: false; error: string } {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, error: 'Config must be an object.' };
  }
  const o = config as Record<string, unknown>;
  if (o['type'] !== 'generic') {
    return { ok: false, error: 'type must be "generic".' };
  }
  for (const legacy of GENERIC_OBSOLETE_ROOT_KEYS) {
    if (legacy in o) {
      return {
        ok: false,
        error: `Schéma obsolète : la clé racine "${legacy}" n'est plus acceptée.`
      };
    }
  }
  const dims = o['dimensions'];
  if (typeof dims !== 'object' || dims === null) {
    return { ok: false, error: 'dimensions is required.' };
  }
  const d = dims as { width?: unknown; height?: unknown };
  if (
    typeof d.width !== 'number' ||
    typeof d.height !== 'number' ||
    !Number.isFinite(d.width) ||
    !Number.isFinite(d.height) ||
    d.width <= 0 ||
    d.height <= 0
  ) {
    return { ok: false, error: 'dimensions.width and dimensions.height must be positive numbers.' };
  }
  if (typeof o['settings'] !== 'object' || o['settings'] === null) {
    return { ok: false, error: 'settings is required.' };
  }
  if (typeof o['fields'] !== 'object' || o['fields'] === null) {
    return { ok: false, error: 'fields is required.' };
  }
  if (typeof o['images'] !== 'object' || o['images'] === null) {
    return { ok: false, error: 'images is required.' };
  }
  if (typeof o['html'] !== 'string' || o['html'].trim().length === 0) {
    return { ok: false, error: 'html is required and must be non-empty.' };
  }
  if (!htmlHasDataGvBind(o['html'])) {
    return { ok: false, error: 'html must contain at least one data-gv-bind attribute.' };
  }
  const settings = o['settings'] as Record<string, unknown>;
  if (
    settings['slideInterval'] !== undefined &&
    (typeof settings['slideInterval'] !== 'number' || settings['slideInterval'] < 0)
  ) {
    return { ok: false, error: 'settings.slideInterval must be a non-negative number when present.' };
  }
  const imgs = o['images'] as Record<string, unknown>;
  for (const [ key, val ] of Object.entries(imgs)) {
    if (!Array.isArray(val) || !val.every((u) => typeof u === 'string')) {
      return { ok: false, error: `images.${key} must be an array of strings.` };
    }
  }
  const fields = o['fields'] as Record<string, unknown>;
  for (const [ key, val ] of Object.entries(fields)) {
    const err = validateTextStyleEntry(key, val);
    if (err !== null) {
      return { ok: false, error: err };
    }
  }
  const unbound = getUnboundGenericConfigKeysError(config as GenericAdConfig);
  if (unbound !== null) {
    return { ok: false, error: unbound };
  }
  return { ok: true, config: config as GenericAdConfig };
}

const RESERVED_BIND_KEYS = new Set([ 'canvas', 'background' ]);

/** Clés `data-gv-bind` présentes dans le HTML (§2.7). */
export function getBoundKeysInHtml (html: string): Set<string> {
  const keys = new Set<string>();
  for (const m of html.matchAll(/\bdata-gv-bind=["']([^"']+)["']/giu)) {
    const key = m[1];
    if (key !== undefined && key.length > 0 && !RESERVED_BIND_KEYS.has(key)) {
      keys.add(key);
    }
  }
  return keys;
}

function htmlHasBindWithTypes (html: string, key: string, types: string[]): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const typeAlt = types.join('|');
  const re = new RegExp(
    `data-gv-bind=["']${esc}["'][^>]*data-gv-type=["'](${typeAlt})["']|data-gv-type=["'](${typeAlt})["'][^>]*data-gv-bind=["']${esc}["']`,
    'iu'
  );
  return re.test(html);
}

/** §2.8 — chaque clé `fields` / `images` doit avoir un binding HTML correspondant. */
export function getUnboundGenericConfigKeysError (config: GenericAdConfig): string | null {
  const html = config.html;
  for (const key of Object.keys(config.fields)) {
    if (!htmlHasBindWithTypes(html, key, [ 'text', 'link' ])) {
      return `La clé fields "${key}" n'a pas de data-gv-bind (type text ou link) dans le html.`;
    }
  }
  for (const key of Object.keys(config.images)) {
    if (!htmlHasBindWithTypes(html, key, [ 'image', 'image-list' ])) {
      return `La clé images "${key}" n'a pas de data-gv-bind (type image ou image-list) dans le html.`;
    }
  }
  return null;
}

function normalizeSettings (settings: GenericAdSettings, html: string): GenericAdSettings {
  const out: GenericAdSettings = {};
  if (typeof settings.backgroundColor === 'string' && settings.backgroundColor.trim().length > 0) {
    out.backgroundColor = settings.backgroundColor.trim();
  }
  if (typeof settings.clickTag === 'string' && settings.clickTag.trim().length > 0) {
    out.clickTag = settings.clickTag.trim();
  }
  if (
    htmlHasImageListBinding(html) &&
    typeof settings.slideInterval === 'number' &&
    settings.slideInterval > 0
  ) {
    out.slideInterval = Math.round(settings.slideInterval);
  }
  return out;
}

const PLAIN_TEXT_HTML_ENTITIES: ReadonlyArray<[ string, string ]> = [
  [ '&amp;', '&' ],
  [ '&nbsp;', ' ' ],
  [ '&lt;', '<' ],
  [ '&gt;', '>' ],
  [ '&quot;', '"' ],
  [ '&#39;', "'" ],
  [ '&apos;', "'" ]
];

/** §1.6 — decode HTML entities in plain-text field values (no `<`). */
function decodeHtmlEntitiesInPlainText (text: string): string {
  if (/<[a-z]/iu.test(text)) {
    return text;
  }
  let out = text;
  for (const [ entity, ch ] of PLAIN_TEXT_HTML_ENTITIES) {
    out = out.split(entity).join(ch);
  }
  out = out.replace(/&#(\d+);/gu, (_, n) => String.fromCharCode(Number(n)));
  out = out.replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return out;
}

function getVisibleBoundKeysInHtml (html: string): Set<string> {
  const withoutHidden = html.replace(
    /<div class="gv-field-bindings"[\s\S]*?<\/div>/giu,
    ''
  );
  return getBoundKeysInHtml(withoutHidden);
}

/** §8.5.1 — remove hidden bindings for keys already bound in visible markup. */
export function stripRedundantGvFieldBindings (html: string): string {
  const visible = getVisibleBoundKeysInHtml(html);
  return html.replace(
    /<div class="gv-field-bindings"[^>]*>([\s\S]*?)<\/div>/giu,
    (full, inner) => {
      const cleaned = inner.replace(
        /<span\b[^>]*\bdata-gv-bind=["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/giu,
        (span: string, key: string) => (visible.has(key) ? '' : span)
      );
      if (!/\bdata-gv-bind=/iu.test(cleaned)) {
        return '';
      }
      return full.replace(inner, cleaned);
    }
  );
}

/** §2.5 / §8.5.1 — plain `ctaText`, drop redundant `cta_label`, decode entities. */
function sanitizeFieldsForReference (
  fields: Record<string, GenericTextField>
): Record<string, GenericTextField> {
  const out: Record<string, GenericTextField> = {};
  for (const [ key, field ] of Object.entries(fields)) {
    if (key === 'cta_label') {
      continue;
    }
    let text = field.text;
    if (key === 'ctaText' && /<[a-z]/iu.test(text)) {
      text = stripHtmlTags(text);
    }
    text = decodeHtmlEntitiesInPlainText(text);
    out[key] = normalizeTextStyle({ ...field, text });
  }
  if (fields['ctaText'] === undefined && fields['cta_label'] !== undefined) {
    let text = fields['cta_label'].text;
    if (/<[a-z]/iu.test(text)) {
      text = stripHtmlTags(text);
    }
    out['ctaText'] = normalizeTextStyle({
      ...fields['cta_label'],
      text: decodeHtmlEntitiesInPlainText(text)
    });
  }
  return out;
}

function stripCtaLabelChildBindings (html: string): string {
  return html.replace(
    /<span\b([^>]*)\bclass=["'][^"']*\bcta-label\b[^"']*["']([^>]*)>/giu,
    () => '<span class="cta-label">'
  );
}

/** Align export HTML/fields with ad-format-json-reference.md (§1.6, §2.5, §8.5.1). */
function conformGenericConfigToReference (draft: GenericAdConfig): GenericAdConfig {
  let html = draft.html.trim();
  html = restructureHeadlineAccentHtml(html);
  html = restructureCtaLabelHtml(html);
  html = stripCtaLabelChildBindings(html);
  html = stripRedundantGvFieldBindings(html);
  const fields = sanitizeFieldsForReference(draft.fields);
  return {
    ...draft,
    html,
    fields,
    settings: normalizeSettings(draft.settings, html)
  };
}

function normalizeImages (images: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [ key, urls ] of Object.entries(images)) {
    if (urls.length > 0) {
      out[key] = urls;
    }
  }
  return out;
}

/** Sérialise en JSON d’import strict (§2.1 + ad-format-json-reference.md). */
export function serializeGenericAdConfig (draft: GenericAdConfig): GenericAdConfig {
  const conformed = conformGenericConfigToReference(draft);
  const html = conformed.html.trim();
  if (html.length === 0) {
    throw new Error('html must be non-empty for generic config export.');
  }
  if (!htmlHasDataGvBind(html)) {
    throw new Error('html must contain at least one data-gv-bind attribute.');
  }

  const out: GenericAdConfig = {
    type: 'generic',
    dimensions: {
      width: Math.max(1, Math.round(conformed.dimensions.width)),
      height: Math.max(1, Math.round(conformed.dimensions.height))
    },
    settings: conformed.settings,
    fields: conformed.fields,
    images: normalizeImages(conformed.images),
    html
  };

  const css = conformed.css?.trim() ?? '';
  const js = conformed.js?.trim() ?? '';
  if (css.length > 0) {
    out.css = css;
  }
  if (js.length > 0) {
    out.js = js;
  }

  const validated = validateGenericAdConfig(out);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return validated.config;
}

type GvBindingType = 'text' | 'image' | 'image-list' | 'link' | 'background' | 'root';

interface BindingRule {
  bind: string;
  gvType: GvBindingType;
  match: (tagName: string, attrs: string) => boolean;
}

const GENERIC_BINDING_RULES: BindingRule[] = [
  {
    bind: 'canvas',
    gvType: 'root',
    match: (tag, attrs) => tag === 'div' && /\bid=["']ad[-A-Za-z0-9]*["']/iu.test(attrs)
  },
  {
    bind: 'canvas',
    gvType: 'root',
    match: (tag, attrs) => tag === 'div' && /\bid=["']adFrame["']/iu.test(attrs)
  },
  {
    bind: 'background',
    gvType: 'background',
    match: (_tag, attrs) => /\bad-bg\b/iu.test(attrs) || /\bbg-glow\b/iu.test(attrs)
  },
  {
    bind: 'tagLine',
    gvType: 'text',
    match: (_tag, attrs) =>
      /\bid=["']tagLine["']/iu.test(attrs)
      || /\btag-line\b/iu.test(attrs)
      || /\bad-tagline\b/iu.test(attrs)
      || /\bad-tag\b/iu.test(attrs)
      || /\bv1-tag\b/iu.test(attrs)
      || /\bv3-label\b/iu.test(attrs)
  },
  {
    bind: 'headline',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'span')
      && (
        /\bad-headline\b/iu.test(attrs)
        || /\bid=["']ad-headline["']/iu.test(attrs)
        || /\bid=["']adHeadline["']/iu.test(attrs)
        || /\bid=["']headlineMain["']/iu.test(attrs)
        || (/\bheadline\b/iu.test(attrs) && !/\bheadline-accent\b/iu.test(attrs) && !/\bdmi\b/iu.test(attrs))
        || /\bv1-title\b/iu.test(attrs)
        || /\bv4-headline\b/iu.test(attrs)
      )
  },
  {
    bind: 'headlineAccent',
    gvType: 'text',
    match: (_tag, attrs) =>
      /\bid=["']headlineAccent["']/iu.test(attrs)
      || /\bdmi\b/iu.test(attrs)
      || /\bheadline-accent\b/iu.test(attrs)
  },
  {
    bind: 'subhead',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'span')
      && (
        /\bad-sub\b/iu.test(attrs)
        || /\bid=["']ad-sub["']/iu.test(attrs)
        || /\bid=["']adSub["']/iu.test(attrs)
        || /\bid=["']subhead["']/iu.test(attrs)
        || /\bsubhead\b/iu.test(attrs)
        || /\bv1-sub\b/iu.test(attrs)
        || /\bv4-body\b/iu.test(attrs)
      )
  },
  {
    bind: 'price',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'span')
      && (/\bad-price\b/iu.test(attrs) || /\bid=["']ad-price["']/iu.test(attrs))
  },
  {
    bind: 'ctaText',
    gvType: 'link',
    match: (tag, attrs) =>
      tag === 'a'
      && (/\bad-cta\b/iu.test(attrs) || /\bcta-btn\b/iu.test(attrs) || /\bcta\b/iu.test(attrs))
  },
  {
    bind: 'legalText',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'span')
      && (/\bid=["']legalText["']/iu.test(attrs) || /\blegal\b/iu.test(attrs) || /\bad-legal\b/iu.test(attrs))
  },
  {
    bind: 'logo',
    gvType: 'image',
    match: (tag, attrs) =>
      tag === 'img'
      && (
        /\bad-logo\b/iu.test(attrs)
        || /\blogo-img\b/iu.test(attrs)
        || /\blogo-main\b/iu.test(attrs)
        || (/\blogo\b/iu.test(attrs) && !/\bwm-logo\b/iu.test(attrs))
      )
  },
  {
    bind: 'heroSlides',
    gvType: 'image-list',
    match: (tag, attrs) => isHeroSlidesContainerTag(tag, attrs)
  }
];

const HERO_SLIDES_BIND_KEY = 'heroSlides';
const HERO_BIND_KEY = 'hero';

const STATIC_HERO_IMG_CLASS_HINTS = [
  'product-img',
  'hero-img',
  'product-image',
  'ad-product'
] as const;

/** §2.6 / §2.12 — conteneur carousel (pas les `<img>` enfants). */
function isHeroSlidesContainerTag (tag: string, attrs: string): boolean {
  if (tag !== 'div') {
    return false;
  }
  return (
    /\bad-carousel\b/iu.test(attrs)
    || /\bhero-wrap\b/iu.test(attrs)
    || /\bhero-track\b/iu.test(attrs)
    || /\bcarousel-track\b/iu.test(attrs)
    || /\bcarousel-wrapper\b/iu.test(attrs)
    || /\bslide-track\b/iu.test(attrs)
    || /\bslides-track\b/iu.test(attrs)
    || /\bslider-track\b/iu.test(attrs)
    || /\bslides-wrapper\b/iu.test(attrs)
    || /\bproduct-slider\b/iu.test(attrs)
    || /\bid=["']carousel["']/iu.test(attrs)
    || /\bid=["']slideTrack["']/iu.test(attrs)
    || (/\bcarousel\b/iu.test(attrs) && !/\bnav-btn\b/iu.test(attrs))
  );
}

function scoreHeroSlidesContainer (attrs: string, imgCount: number): number {
  let priority = 0;
  if (/\bslide-track\b/iu.test(attrs)) {
    priority = 100;
  } else if (/\bslides-track\b/iu.test(attrs)) {
    priority = 95;
  } else if (/\bid=["']slideTrack["']/iu.test(attrs)) {
    priority = 94;
  } else if (/\bcarousel-wrapper\b/iu.test(attrs)) {
    priority = 90;
  } else if (/\bad-carousel\b/iu.test(attrs)) {
    priority = 92;
  } else if (/\bcarousel-track\b/iu.test(attrs)) {
    priority = 88;
  } else if (/\bhero-track\b/iu.test(attrs)) {
    priority = 85;
  } else if (/\bid=["']carousel["']/iu.test(attrs)) {
    priority = 84;
  } else if (/\bcarousel\b/iu.test(attrs)) {
    priority = 50;
  } else if (/\bclass=["'][^"']*\bslide\b/iu.test(attrs)) {
    priority = 12;
  }
  return priority * 1000 + imgCount;
}

/** outerHTML from an opening tag at `start` (balanced close for same tag name). */
function extractOuterHtmlFromOpenTag (html: string, start: number, tagName: string): string | null {
  const tagRe = new RegExp(`<(/?)(${tagName})\\b[^>]*>`, 'giu');
  tagRe.lastIndex = start;
  let depth = 0;
  let end = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m.index === undefined) {
      break;
    }
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else if (!/\/\s*>$/u.test(m[0])) {
      const innerTag = m[2]!.toLowerCase();
      if (!HTML_VOID_ELEMENTS.has(innerTag)) {
        depth += 1;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  return html.slice(start, end);
}

/** §2.8 — injecte `heroSlides` + `image-list` sur le meilleur conteneur carousel. */
export function ensureHeroSlidesImageListBinding (html: string): string {
  if (htmlHasBindWithTypes(html, HERO_SLIDES_BIND_KEY, [ 'image-list' ])) {
    return html;
  }
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu;
  let best: {
    index: number;
    length: number;
    tagName: string;
    attrs: string;
    selfClose: string;
    score: number;
  } | null = null;

  for (const m of html.matchAll(openTagRe)) {
    if (m.index === undefined || m[1] === undefined) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const selfClose = m[3] ?? '';
    if (!isHeroSlidesContainerTag(tag, attrs)) {
      continue;
    }
    if (/\bdata-gv-bind=["']heroSlides["']/iu.test(attrs)) {
      return html;
    }
    const outer =
      selfClose === '/'
        ? null
        : extractOuterHtmlFromOpenTag(html, m.index, tag);
    const imgCount = outer?.match(/<img\b/giu)?.length ?? 0;
    const score = scoreHeroSlidesContainer(attrs, imgCount);
    if (best === null || score > best.score) {
      best = {
        index: m.index,
        length: m[0].length,
        tagName: m[1],
        attrs,
        selfClose,
        score
      };
    }
  }

  if (best === null) {
    return html;
  }

  const inject = ` data-gv-bind="${HERO_SLIDES_BIND_KEY}" data-gv-type="image-list"`;
  const replacement = `<${best.tagName}${best.attrs}${inject}${best.selfClose}>`;
  return html.slice(0, best.index) + replacement + html.slice(best.index + best.length);
}

/** Injecte data-gv-bind / data-gv-type sur les nœuds qui n’en ont pas encore (§2.7). */
export function injectGenericBindings (html: string): string {
  return html.replace(
    /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu,
    (full, tagName, attrs, selfClose) => {
      if (/\bdata-gv-bind=/iu.test(attrs)) {
        return full;
      }
      const tag = tagName.toLowerCase();
      for (const rule of GENERIC_BINDING_RULES) {
        if (rule.match(tag, attrs)) {
          const inject = ` data-gv-bind="${rule.bind}" data-gv-type="${rule.gvType}"`;
          return `<${tagName}${attrs}${inject}${selfClose}>`;
        }
      }
      return full;
    }
  );
}

function readUtf8 (path: string): string {
  return readFileSync(path, { encoding: 'utf8' }).replace(/^\uFEFF/u, '').trim();
}

export function findFirstAdDomId (html: string): string | null {
  const iab = /\bid=["'](ad-[^"']+)["']/iu.exec(html);
  if (iab?.[1] !== undefined) {
    return iab[1];
  }
  const frame = /\bid=["'](adFrame)["']/iu.exec(html);
  if (frame?.[1] !== undefined) {
    return frame[1];
  }
  const other = /\bid=["'](ad[a-zA-Z][a-zA-Z0-9_-]*)["']/iu.exec(html);
  return other?.[1] ?? null;
}

/** Extract outerHTML of the element with the given id (first match). */
export function extractAdRootHtml (html: string, domId: string): string | null {
  const idRe = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*\\bid=["']${domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'iu'
  );
  const openMatch = idRe.exec(html);
  if (openMatch === null || openMatch.index === undefined) {
    return null;
  }
  const tagName = openMatch[1]!.toLowerCase();
  const start = openMatch.index;
  let depth = 0;
  const tagRe = new RegExp(`<(/?)(${tagName})\\b[^>]*>`, 'giu');
  tagRe.lastIndex = start;
  let end = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m.index === undefined) {
      break;
    }
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else if (!/\/\s*>$/u.test(m[0])) {
      const innerTag = m[2]!.toLowerCase();
      if (!HTML_VOID_ELEMENTS.has(innerTag)) {
        depth += 1;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  return html.slice(start, end).replace(/\s+/gu, ' ').trim();
}

/** Fragment pub (#ad-*) fiable pour extraction texte + export HTML. */
export function getAdFragmentForExtraction (indexHtml: string, domId: string): string {
  const extracted =
    extractAdRootHtml(indexHtml, domId)
    ?? (domId !== 'ad-generic' ? extractAdRootHtml(indexHtml, 'ad-generic') : null);
  const full = indexHtml.trim();
  if (extracted === null || extracted.length === 0) {
    return full;
  }
  const markers = [
    'ad-headline',
    'adHeadline',
    'ad-copy',
    'cta-btn',
    'ad-cta',
    'ad-tagline',
    'ad-price'
  ];
  for (const mk of markers) {
    if (full.includes(mk) && !extracted.includes(mk)) {
      return full;
    }
  }
  return extracted;
}

function parseDimensionsFromFormatsFile (outputRunDir: string): { width: number; height: number } | null {
  const path = join(outputRunDir, 'creative-native-ad-formats.json');
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readUtf8(path)) as { adFormats?: unknown };
    const first = Array.isArray(raw.adFormats) ? raw.adFormats[0] : null;
    if (typeof first !== 'object' || first === null) {
      return null;
    }
    const w = (first as { width?: unknown }).width;
    const h = (first as { height?: unknown }).height;
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  } catch {
    return null;
  }
  return null;
}

function cssSelectorsForDomId (domId: string): string[] {
  const escaped = domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selectors = [ `#${escaped}` ];
  if (domId === 'adFrame') {
    selectors.push('\\.ad-frame');
  }
  return selectors;
}

function readCssBlock (css: string, selectorPattern: string): string | null {
  const blockRe = new RegExp(`${selectorPattern}\\s*\\{([^}]+)\\}`, 'iu');
  return blockRe.exec(css)?.[1] ?? null;
}

function parseDimensionsFromCss (css: string, domId: string): { width: number; height: number } | null {
  for (const sel of cssSelectorsForDomId(domId)) {
    const body = readCssBlock(css, sel);
    if (body === null) {
      continue;
    }
    const w = /width\s*:\s*(\d+(?:\.\d+)?)\s*px/iu.exec(body);
    const h = /height\s*:\s*(\d+(?:\.\d+)?)\s*px/iu.exec(body);
    if (w?.[1] !== undefined && h?.[1] !== undefined) {
      return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
    }
  }
  return null;
}

/** Lit `ad-300x250` / `ad-970x250` depuis l’id racine du créatif. */
function parseDimensionsFromDomId (domId: string): { width: number; height: number } | null {
  const m = /^ad-(\d+)x(\d+)$/iu.exec(domId);
  if (m?.[1] === undefined || m[2] === undefined) {
    return null;
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function parseDimensionsFromTitle (html: string): { width: number; height: number } | null {
  const m = /<title\b[^>]*>[\s\S]*?(\d+)\s*[×x]\s*(\d+)/iu.exec(html);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return { width: Number(m[1]), height: Number(m[2]) };
  }
  return null;
}

function parseBackgroundFromCss (css: string, domId: string): string | null {
  for (const sel of cssSelectorsForDomId(domId)) {
    const body = readCssBlock(css, sel);
    if (body === null) {
      continue;
    }
    const solid = /background(?:-color)?\s*:\s*(#[0-9A-Fa-f]{3,8})/iu.exec(body);
    if (solid?.[1] !== undefined) {
      return solid[1];
    }
  }
  return null;
}

function resolveSafeBundlePath (bundleDir: string, ref: string): string | null {
  const trimmed = ref.trim().replace(/^\.\//u, '');
  if (
    trimmed.length === 0 ||
    trimmed.includes('..') ||
    trimmed.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)
  ) {
    return null;
  }
  const bundleResolved = resolve(bundleDir);
  const abs = resolve(bundleResolved, trimmed);
  const rel = relative(bundleResolved, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return abs;
}

export function resolveLocalAssetToDataUrl (bundleDir: string, ref: string): string | null {
  if (!isLocalAssetRef(ref)) {
    return null;
  }
  const abs = resolveSafeBundlePath(bundleDir, ref);
  if (abs === null || !existsSync(abs)) {
    return null;
  }
  const buf = readFileSync(abs);
  const name = basename(abs);
  if (isSvgAssetFile(name, buf)) {
    return `data:image/svg+xml,${encodeURIComponent(buf.toString('utf8'))}`;
  }
  const mimeType = sniffImageMimeFromBuffer(buf) ?? mime.getType(abs);
  if (mimeType === null || !mimeType.startsWith('image/')) {
    return null;
  }
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

function collectLocalAssetRefs (config: GenericAdConfig): string[] {
  const imageUrls: string[] = [];
  for (const urls of Object.values(config.images)) {
    imageUrls.push(...urls);
  }
  return collectLocalAssetRefsFromSource({
    html: config.html,
    ...(config.css !== undefined ? { css: config.css } : {}),
    ...(config.js !== undefined ? { js: config.js } : {}),
    imageUrls
  });
}

function replaceAllLiteral (content: string, from: string, to: string): string {
  if (!content.includes(from)) {
    return content;
  }
  return content.split(from).join(to);
}

export function embedBundleAssetsInConfig (
  config: GenericAdConfig,
  bundleDir: string
): GenericAdConfig {
  const urlMap = new Map<string, string>();
  for (const ref of collectLocalAssetRefs(config)) {
    const dataUrl = resolveLocalAssetToDataUrl(bundleDir, ref);
    if (dataUrl !== null) {
      urlMap.set(ref, dataUrl);
    }
  }
  if (urlMap.size === 0) {
    return config;
  }
  // Clear bound <img src> while paths are still short — never inline data URLs into html
  // (base64 payloads contain character sequences that break tag-boundary heuristics).
  const html = stripBoundImageDataUrlsFromHtml(config.html, Object.keys(config.images));
  let css = config.css;
  let js = config.js;
  for (const [ from, to ] of urlMap) {
    if (css !== undefined) {
      css = replaceAllLiteral(css, from, to);
    }
    if (js !== undefined) {
      js = replaceAllLiteral(js, from, to);
    }
  }
  const remap = (list: string[]): string[] => list.map((u) => urlMap.get(u) ?? u);
  const images: Record<string, string[]> = {};
  for (const [ key, urls ] of Object.entries(config.images)) {
    images[key] = remap(urls);
  }

  return {
    ...config,
    html,
    images,
    ...(css !== undefined ? { css } : {}),
    ...(js !== undefined ? { js } : {})
  };
}

function stripSrcOnDirectImageBinds (html: string, bindKey: string): string {
  const esc = bindKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = html;
  out = out.replace(
    new RegExp(`<img\\b([^>]*?)\\bdata-gv-bind=["']${esc}["']([^>]*?)>`, 'giu'),
    (full) => full.replace(/\bsrc=["'][^"']*["']/iu, 'src=""')
  );
  out = out.replace(
    new RegExp(`<img\\b([^>]*?)\\bsrc=["'][^"']*["']([^>]*?)\\bdata-gv-bind=["']${esc}["']([^>]*?)>`, 'giu'),
    (full) => full.replace(/\bsrc=["'][^"']*["']/iu, 'src=""')
  );
  return out;
}

/** §2.11 — vider `src` sur les `<img>` enfants d’un conteneur `image-list`. */
function stripSrcOnImageListContainer (html: string, bindKey: string): string {
  const esc = bindKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bindOnContainer = new RegExp(
    `data-gv-bind=["']${esc}["'][^>]*data-gv-type=["']image-list["']|data-gv-type=["']image-list["'][^>]*data-gv-bind=["']${esc}["']`,
    'iu'
  );
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu;
  let best: { start: number; end: number; replacement: string; span: number } | null = null;

  for (const m of html.matchAll(openTagRe)) {
    if (m.index === undefined || m[1] === undefined || (m[3] ?? '') === '/') {
      continue;
    }
    const attrs = m[2] ?? '';
    if (!bindOnContainer.test(attrs)) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const outer = extractOuterHtmlFromOpenTag(html, m.index, tag);
    if (outer === null) {
      continue;
    }
    const stripped = outer.replace(
      /<img\b([^>]*)>/giu,
      (full) => full.replace(/\bsrc=["'][^"']*["']/iu, 'src=""')
    );
    if (stripped === outer) {
      continue;
    }
    const span = outer.length;
    if (best === null || span > best.span) {
      best = {
        start: m.index,
        end: m.index + outer.length,
        replacement: stripped,
        span
      };
    }
  }

  if (best === null) {
    return html;
  }
  return html.slice(0, best.start) + best.replacement + html.slice(best.end);
}

/** §2.11 — URLs d’images dans `images.*` uniquement ; `src=""` sur les `<img>` liés. */
export function stripBoundImageDataUrlsFromHtml (
  html: string,
  imageKeys: string[]
): string {
  let out = html;
  for (const key of imageKeys) {
    if (htmlHasBindWithTypes(out, key, [ 'image-list' ])) {
      out = stripSrcOnImageListContainer(out, key);
    }
    out = stripSrcOnDirectImageBinds(out, key);
  }
  out = out.replace(
    /<img\b([^>]*)\bsrc=["']data:image[^"']*["']([^>]*)>/giu,
    '<img$1src=""$2>'
  );
  return out;
}

/** §2.8 — bindings HTML pour chaque clé `fields` sans nœud visible (variantes JS, etc.). */
export function appendHiddenFieldBindings (
  html: string,
  fields: Record<string, GenericTextField>
): string {
  const bound = getBoundKeysInHtml(html);
  const missing = Object.keys(fields).filter(
    (k) => fields[k] !== undefined && fields[k].text.trim().length > 0 && !bound.has(k)
  );
  if (missing.length === 0) {
    return html;
  }
  const nodes = missing
    .map((k) => {
      const gvType = k === 'ctaText' || k.startsWith('cta') ? 'link' : 'text';
      const text = fields[k]!.text;
      return `<span data-gv-bind="${k}" data-gv-type="${gvType}">${text}</span>`;
    })
    .join('');
  return `${html}<div class="gv-field-bindings" aria-hidden="true" hidden style="display:none">${nodes}</div>`;
}

function parseSlideInterval (js: string): number {
  const intervalConst = /INTERVAL\s*=\s*(\d+)/iu.exec(js);
  if (intervalConst?.[1] !== undefined) {
    return Number(intervalConst[1]);
  }
  const setInterval = /setInterval\s*\([^,]+,\s*(\d+)/iu.exec(js);
  if (setInterval?.[1] !== undefined) {
    return Number(setInterval[1]);
  }
  return DEFAULT_SLIDE_INTERVAL;
}

function stripHtmlTags (s: string): string {
  return s.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Split `<em>` accent out of a combined headline field (e.g. Préparez votre + Bubble Tea). */
export function splitHeadlineAccentFields (
  fields: Record<string, GenericTextField>,
  styleForKey: (key: string) => Partial<GenericTextField>
): void {
  const headline = fields['headline'];
  if (headline === undefined || fields['headlineAccent'] !== undefined) {
    return;
  }
  const emRe = /<em\b[^>]*>([\s\S]*?)<\/em>/iu;
  const emMatch = emRe.exec(headline.text);
  if (emMatch?.[1] === undefined) {
    return;
  }
  const accentText = stripHtmlTags(emMatch[1]);
  if (accentText.length === 0) {
    return;
  }
  let mainHtml = headline.text;
  const brEm = /<br\s*\/?>\s*<em\b/iu.exec(mainHtml);
  if (brEm?.index !== undefined) {
    mainHtml = mainHtml.slice(0, brEm.index);
  } else {
    mainHtml = mainHtml.replace(emRe, '');
  }
  const hasBr = /<br\s*\/?>/iu.test(headline.text);
  const mainText = stripHtmlTags(mainHtml.replace(/<br\s*\/?>/giu, ' ')).trim();
  if (mainText.length === 0) {
    return;
  }
  fields['headline'] = {
    ...headline,
    text: hasBr ? mainText : mainText
  };
  fields['headlineAccent'] = defaultTextField(accentText, styleForKey('headlineAccent'));
}

/** Move headline bindings onto inner spans; accent lives inside `<em>` (gallery import shape). */
export function restructureHeadlineAccentHtml (html: string): string {
  return html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/giu, (full, attrs, inner) => {
    if (
      !/\bclass=["'][^"']*\bheadline\b/iu.test(attrs)
      && !/\bdata-gv-bind=["']headline["']/iu.test(full)
    ) {
      return full;
    }
    if (/\bdata-gv-bind=["']headlineAccent["']/iu.test(full)) {
      return full;
    }
    const emRe = /<em\b[^>]*>([\s\S]*?)<\/em>/iu;
    const emMatch = emRe.exec(inner);
    if (emMatch?.[1] === undefined || emMatch.index === undefined) {
      return full;
    }
    const before = inner.slice(0, emMatch.index).trim();
    const accentText = stripHtmlTags(emMatch[1]) || emMatch[1].trim();
    let headlineText = stripHtmlTags(before.replace(/<br\s*\/?>/giu, ' ')).trim();
    let emFirst = false;
    if (headlineText.length === 0 && accentText.length > 0) {
      const after = inner.slice(emMatch.index + emMatch[0].length).trim();
      headlineText = stripHtmlTags(after.replace(/<br\s*\/?>/giu, ' ')).trim();
      emFirst = headlineText.length > 0;
    }
    if (headlineText.length === 0 || accentText.length === 0) {
      return full;
    }
    const hasBr = emFirst
      ? /<br\s*\/?>/iu.test(inner.slice(emMatch.index + emMatch[0].length))
      : /<br\s*\/?>/iu.test(before);
    const newInner = hasBr
      ? `<span data-gv-bind="headline" data-gv-type="text">${headlineText}</span><br><em><span data-gv-bind="headlineAccent" data-gv-type="text">${accentText}</span></em>`
      : `<span data-gv-bind="headline" data-gv-type="text">${headlineText}</span> <em><span data-gv-bind="headlineAccent" data-gv-type="text">${accentText}</span></em>`;
    const newAttrs = attrs
      .replace(/\s*data-gv-bind=["']headline["']/giu, '')
      .replace(/\s*data-gv-type=["']text["']/giu, '');
    return `<h1${newAttrs}>${newInner}</h1>`;
  });
}

/** Remove decorative `aria-hidden` blocks from the exported ad fragment. */
export function stripDecorativeAriaHidden (html: string): string {
  let out = html;
  let prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(
      /<([a-z][a-z0-9]*)\b[^>]*\baria-hidden=["']true["'][^>]*>[\s\S]*?<\/\1>/giu,
      ''
    );
  }
  return out
    .replace(/<!--\s*Background bubbles\s*-->/giu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

type ParsedCssTextDecl = {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: 'normal' | 'italic';
  color?: string;
};

const GENERIC_FONT_FALLBACKS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui'
]);

function escapeCssSelectorForRegex (selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract typographic declarations from a simple CSS rule block. */
export function parseCssRuleBlock (css: string, selector: string): ParsedCssTextDecl | null {
  const esc = escapeCssSelectorForRegex(selector.trim());
  const re = new RegExp(`${esc}\\s*\\{([^}]+)\\}`, 'iu');
  const body = re.exec(css)?.[1];
  if (body === undefined || body.length === 0) {
    return null;
  }
  const decl: ParsedCssTextDecl = {};
  const ff = /font-family\s*:\s*([^;]+);/iu.exec(body);
  if (ff?.[1] !== undefined) {
    const first =
      ff[1]
        .split(',')[0]
        ?.trim()
        .replace(/^["']|["']$/gu, '') ?? '';
    if (first.length > 0) {
      decl.fontFamily = first;
    }
  }
  const fs = /font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/iu.exec(body);
  if (fs?.[1] !== undefined) {
    decl.fontSize = Math.round(Number(fs[1]));
  }
  const fw = /font-weight\s*:\s*([^;]+);/iu.exec(body);
  if (fw?.[1] !== undefined) {
    decl.fontWeight = fw[1].trim();
  }
  const fst = /font-style\s*:\s*([^;]+);/iu.exec(body);
  if (fst?.[1] !== undefined) {
    decl.fontStyle = fst[1].trim().toLowerCase() === 'italic' ? 'italic' : 'normal';
  }
  const col = /color\s*:\s*([^;]+);/iu.exec(body);
  if (col?.[1] !== undefined) {
    decl.color = col[1].trim();
  }
  return Object.keys(decl).length > 0 ? decl : null;
}

function cssDeclToFieldPartial (decl: ParsedCssTextDecl): Partial<GenericTextField> {
  const out: Partial<GenericTextField> = {};
  if (decl.fontFamily !== undefined) {
    out.font = decl.fontFamily;
  }
  if (decl.fontSize !== undefined) {
    out.size = decl.fontSize;
  }
  if (decl.fontWeight !== undefined) {
    out.weight = decl.fontWeight;
  }
  if (decl.fontStyle !== undefined) {
    out.style = decl.fontStyle;
  }
  if (decl.color !== undefined) {
    out.color = decl.color;
  }
  return out;
}

const FIELD_CSS_SELECTORS: Record<string, string[]> = {
  eyebrow: [ '.eyebrow' ],
  headline: [ '.headline' ],
  headlineAccent: [ '.headline em' ],
  subhead: [ '.subhead' ],
  body_copy: [ '.body-copy' ],
  ctaText: [ '.cta-btn' ],
  legalText: [ '.ad-legal', '.ad-footer span' ]
};

function selectorsForFieldKey (key: string): string[] | null {
  if (FIELD_CSS_SELECTORS[key] !== undefined) {
    return FIELD_CSS_SELECTORS[key]!;
  }
  if (key.startsWith('text_')) {
    return [ '.ad-footer span', '.ad-legal' ];
  }
  return null;
}

/** Merge TextStyle from bundle CSS onto discovered `fields` (keeps `text`). */
export function applyFieldStylesFromCss (
  fields: Record<string, GenericTextField>,
  css: string
): void {
  for (const [ key, field ] of Object.entries(fields)) {
    const selectors = selectorsForFieldKey(key);
    if (selectors === null) {
      continue;
    }
    for (const selector of selectors) {
      const decl = parseCssRuleBlock(css, selector);
      if (decl === null) {
        continue;
      }
      const partial = cssDeclToFieldPartial(decl);
      if (Object.keys(partial).length === 0) {
        continue;
      }
      fields[key] = normalizeTextStyle({ ...field, ...partial });
      break;
    }
  }
}

/** §2.5 — CTA binding on `<a>` with empty `.cta-label` child (hydration injects label). */
export function restructureCtaLabelHtml (html: string): string {
  return html.replace(
    /<a\b([^>]*)\bdata-gv-bind=["']ctaText["']([^>]*)>([\s\S]*?)<\/a>/giu,
    (full, before, after) => {
      const gvType = /\bdata-gv-type=["']link["']/iu.test(full) ? '' : ' data-gv-type="link"';
      return `<a${before}data-gv-bind="ctaText"${after}${gvType}><span class="cta-label"></span></a>`;
    }
  );
}

function buildGalleryFontsImportUrl (css: string, sg: StyleGuideSlice): string {
  const used = collectUsedFontFamilies(css);
  const params: string[] = [];
  const seen = new Set<string>();
  const addParam = (param: string): void => {
    if (!seen.has(param)) {
      seen.add(param);
      params.push(param);
    }
  };

  const accentDecl = parseCssRuleBlock(css, '.headline em');
  const needsPlayfairItalic = accentDecl?.fontStyle === 'italic';

  for (const font of used) {
    const norm = normalizeFontFamilyName(font);
    if (GENERIC_FONT_FALLBACKS.has(norm)) {
      continue;
    }
    if (norm === 'montserrat') {
      addParam('family=Montserrat:wght@400;600;700');
    } else if (norm === 'playfair display') {
      addParam(
        needsPlayfairItalic
          ? 'family=Playfair+Display:ital,wght@0,700;1,700'
          : 'family=Playfair+Display:wght@400;600;700'
      );
    } else {
      const sub = resolveGoogleFontSubstitute(font);
      const encoded = sub.googleFamily.trim().replace(/\s+/gu, '+');
      addParam(`family=${encoded}:wght@${sub.weights}`);
    }
  }

  if (params.length === 0 && Array.isArray(sg.typography) && sg.typography.length > 0) {
    const substitutes = sg.typography
      .map((row) => resolveGoogleFontSubstitute(row.fontFamily ?? DEFAULT_FONT))
      .filter((sub, idx, arr) => arr.findIndex((s) => s.googleFamily === sub.googleFamily) === idx);
    return buildGoogleFontsCss2Url(substitutes);
  }

  if (params.length === 0) {
    return buildGoogleFontsCss2Url([ { googleFamily: 'Inter', weights: '400;600;700' } ]);
  }

  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}

function stripCssDeclaration (block: string, property: string): string {
  const re = new RegExp(`\\s*${property}\\s*:[^;]+;`, 'giu');
  return block.replace(re, '');
}

/** Remove one `@keyword name { … }` block with balanced braces. */
function removeCssAtBlock (css: string, keyword: string, name: string): string {
  const startRe = new RegExp(`@${keyword}\\s+${escapeCssSelectorForRegex(name)}\\b[^\\{]*\\{`, 'iu');
  const start = startRe.exec(css);
  if (start?.index === undefined) {
    return css;
  }
  const openBrace = css.indexOf('{', start.index);
  if (openBrace < 0) {
    return css;
  }
  let depth = 0;
  for (let i = openBrace; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(0, start.index) + css.slice(i + 1);
      }
    }
  }
  return css;
}

/** Remove `@media` blocks whose body only references removed decorative selectors. */
function removeEmptyOrBubbleMediaQueries (css: string): string {
  return css.replace(/@media[^{]+\{([\s\S]*?)\}/giu, (full, body) => {
    const trimmed = body.replace(/\s+/gu, '');
    if (trimmed.length === 0) {
      return '';
    }
    if (/\.bubble\b/iu.test(body) && !/\.\w+-\w+/iu.test(body.replace(/\.bubble\b/giu, ''))) {
      return '';
    }
    return full;
  });
}

/** Gallery-ready CSS: Google Fonts @import, no decorative-only rules from preview chrome. */
export function prepareCssForGalleryExport (
  css: string,
  styleGuide: StyleGuideSlice,
  domId: string
): string {
  let out = css.trim();
  const escId = escapeCssSelectorForRegex(domId);

  out = out.replace(/\/\*[\s\S]*?Animated Background Bubbles[\s\S]*?\*\/\s*/giu, '');
  out = out.replace(/\/\*[\s\S]*?Colour stripe divider[\s\S]*?\*\/\s*/giu, '');
  out = out.replace(/\.bg-bubbles\s*\{[^}]*\}/giu, '');
  out = out.replace(/\.bubble\s*\{[^}]*\}/giu, '');
  out = out.replace(/\.b[1-7]\s*\{[^}]*\}/giu, '');
  out = removeCssAtBlock(out, 'keyframes', 'floatUp');
  out = removeEmptyOrBubbleMediaQueries(out);
  out = out.replace(new RegExp(`#${escId}::before\\s*\\{[^}]*\\}`, 'giu'), '');

  out = out.replace(/(\.ad-header\s*\{)([^}]*)(\})/giu, (_m, open, body, close) => {
    return `${open}${stripCssDeclaration(body, 'border-bottom')}${close}`;
  });

  out = out.replace(new RegExp(`(#${escId}\\s*\\{)([^}]*)(\\})`, 'giu'), (_m, open, body, close) => {
    let cleaned = stripCssDeclaration(body, 'border-radius');
    cleaned = stripCssDeclaration(cleaned, 'box-shadow');
    return `${open}${cleaned}${close}`;
  });

  if (!/@import\s+url\(/iu.test(out)) {
    const importUrl = buildGalleryFontsImportUrl(out, styleGuide);
    out = `@import url('${importUrl}');\n\n${out}`;
  }

  return out.replace(/\n{3,}/gu, '\n\n').trim();
}

function readHtmlAttr (attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, 'iu');
  return re.exec(attrs)?.[1] ?? null;
}

function hasClassToken (attrs: string, token: string): boolean {
  const cls = readHtmlAttr(attrs, 'class');
  if (cls === null) {
    return false;
  }
  return cls.split(/\s+/u).includes(token);
}

function unescapeJsString (raw: string): string {
  return raw
    .replace(/\\u00A0/gu, '\u00A0')
    .replace(/\\n/gu, '\n')
    .replace(/\\'/gu, "'")
    .replace(/\\"/gu, '"');
}

/** Lit une chaîne JS littérale (quotes simples ou doubles) dans un bloc objet. */
function readJsObjectStringField (body: string, field: string): string | null {
  const re = new RegExp(
    `${field}\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`,
    'iu'
  );
  const m = re.exec(body);
  if (m?.[2] === undefined) {
    return null;
  }
  return unescapeJsString(m[2]);
}

/** Extrait le HTML intérieur d’une balise ouvrante à l’index donné (fermeture équilibrée). */
function extractBalancedInnerHtml (
  html: string,
  openIndex: number
): { inner: string; openTag: string } | null {
  const slice = html.slice(openIndex);
  const openMatch = /^<([a-z][a-z0-9]*)\b([^>]*)(\/?)>/iu.exec(slice);
  if (openMatch === null) {
    return null;
  }
  const tag = openMatch[1]!.toLowerCase();
  const openTag = openMatch[0];
  if (HTML_VOID_ELEMENTS.has(tag) || openMatch[3] === '/') {
    return { inner: '', openTag };
  }
  const contentStart = openIndex + openTag.length;
  let depth = 1;
  const tagRe = /<\/?([a-z][a-z0-9]*)\b[^>]*>/giu;
  tagRe.lastIndex = contentStart;
  let closeEnd = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m.index === undefined) {
      break;
    }
    const t = m[1]!.toLowerCase();
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        closeEnd = m.index;
        break;
      }
    } else if (!HTML_VOID_ELEMENTS.has(t) && !/\/\s*>$/u.test(m[0])) {
      depth += 1;
    }
  }
  if (closeEnd < 0) {
    return null;
  }
  return { inner: html.slice(contentStart, closeEnd).trim(), openTag };
}

function findParentDataSlide (fragment: string, beforeIndex: number): string | null {
  const head = fragment.slice(0, beforeIndex);
  const matches = [ ...head.matchAll(/data-slide=["']([^"']+)["']/giu) ];
  return matches.at(-1)?.[1] ?? null;
}

function resolveCanonicalFieldKey (
  tag: string,
  attrs: string,
  fragment: string,
  openIndex: number
): string | null {
  if (tag === 'span' && hasClassToken(attrs, 'hl')) {
    return null;
  }
  const id = readHtmlAttr(attrs, 'id');
  const variant = readHtmlAttr(attrs, 'data-variant');

  if (id === 'ad-headline' || id === 'adHeadline' || id === 'headlineMain') {
    return 'headline';
  }
  if (id === 'ad-sub' || id === 'adSub' || id === 'subhead') {
    return 'subhead';
  }
  if (id === 'ad-price') {
    return 'price';
  }
  if (id === 'headlineAccent') {
    return 'headlineAccent';
  }
  if (id === 'tagLine' || id === 'legalText') {
    return id;
  }
  if (hasClassToken(attrs, 'ad-headline') || hasClassToken(attrs, 'v1-title') || hasClassToken(attrs, 'v4-headline')) {
    return 'headline';
  }
  if (hasClassToken(attrs, 'ad-sub') || hasClassToken(attrs, 'v1-sub') || hasClassToken(attrs, 'v4-body')) {
    return 'subhead';
  }
  if (hasClassToken(attrs, 'ad-price')) {
    return 'price';
  }
  if (
    hasClassToken(attrs, 'ad-tagline')
    || hasClassToken(attrs, 'tag-line')
    || hasClassToken(attrs, 'ad-tag')
    || hasClassToken(attrs, 'v1-tag')
    || hasClassToken(attrs, 'v3-label')
  ) {
    return 'tagLine';
  }
  if (hasClassToken(attrs, 'ad-legal') || hasClassToken(attrs, 'legal')) {
    return 'legalText';
  }
  if (hasClassToken(attrs, 'headline-accent') || hasClassToken(attrs, 'dmi')) {
    return 'headlineAccent';
  }
  if (tag === 'a' && (hasClassToken(attrs, 'cta-btn') || hasClassToken(attrs, 'ad-cta') || hasClassToken(attrs, 'cta'))) {
    return 'ctaText';
  }
  if (tag === 'button' && hasClassToken(attrs, 'tab-btn') && variant !== null) {
    return `tab_${variant}`;
  }
  if (hasClassToken(attrs, 'hero-badge')) {
    const slide = findParentDataSlide(fragment, openIndex);
    if (slide !== null) {
      return `badge_${slide}`;
    }
  }

  if (id !== null && id.length > 0) {
    return id.replace(/-/gu, '_');
  }
  const cls = readHtmlAttr(attrs, 'class');
  if (cls !== null) {
    const first = cls.split(/\s+/u)[0]?.replace(/-/gu, '_');
    if (first !== undefined && first.length > 0 && first !== 'active') {
      return first;
    }
  }
  return `text_${openIndex}`;
}

function isDecorativeTextNode (attrs: string): boolean {
  if (/\baria-hidden=["']true["']/iu.test(attrs)) {
    return true;
  }
  if (hasClassToken(attrs, 'wm-logo') || hasClassToken(attrs, 'lion-watermark')) {
    return true;
  }
  return false;
}

/** Passe B — découverte exhaustive des textes dans le fragment pub. */
export function discoverTextFieldsFromHtml (fragment: string): DiscoveredText[] {
  const out: DiscoveredText[] = [];
  const seenKeys = new Set<string>();
  const tagAlt = [ ...TEXT_DISCOVERY_TAGS ].join('|');
  const openRe = new RegExp(`<(${tagAlt})\\b([^>]*)>`, 'giu');
  for (let m = openRe.exec(fragment); m !== null; m = openRe.exec(fragment)) {
    if (m.index === undefined || m[1] === undefined || m[2] === undefined) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (isDecorativeTextNode(attrs)) {
      continue;
    }
    if (tag === 'div' && !hasClassToken(attrs, 'hero-badge')) {
      continue;
    }
    if (tag === 'span' && hasClassToken(attrs, 'cta-label')) {
      continue;
    }
    const balanced = extractBalancedInnerHtml(fragment, m.index);
    if (balanced === null) {
      continue;
    }
    const plain = stripHtmlTags(balanced.inner);
    if (plain.length === 0) {
      continue;
    }
    const key = resolveCanonicalFieldKey(tag, attrs, fragment, m.index);
    if (key === null) {
      continue;
    }
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    const richTag = tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'p' || tag === 'span' || tag === 'a';
    const innerHtml = richTag ? balanced.inner : plain;
    out.push({
      key,
      innerHtml,
      openTag: balanced.openTag,
      gvType: key === 'ctaText' ? 'link' : 'text'
    });
  }
  return out;
}

/** Passe C — textes dans app.js (variants, slideCopy). */
export function parseVariantTextsFromJs (js: string): Record<string, string> {
  const out: Record<string, string> = {};
  const variantsBlock = /(?:const|let|var)\s+variants\s*=\s*\{([\s\S]*?)\}\s*;/iu.exec(js);
  if (variantsBlock?.[1] !== undefined) {
    for (const vm of variantsBlock[1].matchAll(/(\w+)\s*:\s*\{([^}]*)\}/giu)) {
      const variantKey = vm[1];
      const body = vm[2] ?? '';
      if (variantKey === undefined || body.length === 0) {
        continue;
      }
      const headline = readJsObjectStringField(body, 'headline');
      const sub = readJsObjectStringField(body, 'sub');
      const price = readJsObjectStringField(body, 'price');
      if (headline !== null) {
        out[`headline_${variantKey}`] = headline;
      }
      if (sub !== null) {
        out[`subhead_${variantKey}`] = sub;
      }
      if (price !== null) {
        out[`price_${variantKey}`] = price;
      }
    }
  }
  const slideBlock = /slideCopy\s*=\s*\[([\s\S]*?)\];/iu.exec(js);
  if (slideBlock?.[1] !== undefined) {
    let idx = 0;
    for (const item of slideBlock[1].matchAll(/\{([\s\S]*?)\}/giu)) {
      const body = item[1] ?? '';
      const headline = readJsObjectStringField(body, 'headline');
      const sub = readJsObjectStringField(body, 'sub');
      if (headline !== null) {
        out[idx === 0 ? 'headline' : `headline_slide_${idx}`] = headline;
      }
      if (sub !== null) {
        out[idx === 0 ? 'subhead' : `subhead_slide_${idx}`] = sub;
      }
      idx += 1;
    }
  }
  return out;
}

function injectBindingsForDiscovered (html: string, discovered: DiscoveredText[]): string {
  let out = html;
  for (const d of discovered) {
    if (new RegExp(`data-gv-bind=["']${d.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'iu').test(out)) {
      continue;
    }
    if (!out.includes(d.openTag)) {
      continue;
    }
    const injected = d.openTag.replace(
      />$/u,
      ` data-gv-bind="${d.key}" data-gv-type="${d.gvType}">`
    );
    out = out.replace(d.openTag, injected);
  }
  return out;
}

function fieldStyleDefaults (
  key: string,
  sg: StyleGuideSlice,
  primaryFont: string,
  accentColor: string
): Partial<GenericTextField> {
  if (key === 'tagLine' || key.startsWith('tab_')) {
    return { size: 10, weight: '600', font: primaryFont };
  }
  if (key === 'headline' || key.startsWith('headline')) {
    return {
      size: 26,
      weight: fontWeightFromStyleGuide(sg, 0, '700'),
      color: DEFAULT_HEADLINE_COLOR,
      font: primaryFont
    };
  }
  if (key === 'headlineAccent') {
    return {
      size: 26,
      weight: fontWeightFromStyleGuide(sg, 0, '700'),
      color: accentColor,
      font: primaryFont
    };
  }
  if (key === 'subhead' || key.startsWith('subhead')) {
    return { size: 12, weight: fontWeightFromStyleGuide(sg, 2, '500'), font: primaryFont };
  }
  if (key === 'price' || key.startsWith('price_')) {
    return { size: 11, weight: '600', font: primaryFont, color: DEFAULT_HEADLINE_COLOR };
  }
  if (key.startsWith('badge_')) {
    return { size: 9, weight: '700', font: primaryFont, color: DEFAULT_HEADLINE_COLOR };
  }
  if (key === 'ctaText') {
    return {
      size: 13,
      weight: fontWeightFromStyleGuide(sg, 2, '600'),
      color: DEFAULT_HEADLINE_COLOR,
      font: primaryFont
    };
  }
  if (key === 'legalText') {
    return { size: 8, weight: '500', font: primaryFont };
  }
  return { size: 12, weight: '500', font: primaryFont };
}

function buildFieldsFromCreative (params: {
  fragment: string;
  appJs: string;
  sg: StyleGuideSlice;
  primaryFont: string;
  accentColor: string;
}): { fields: Record<string, GenericTextField>; discovered: DiscoveredText[] } {
  const { fragment, appJs, sg, primaryFont, accentColor } = params;
  const textByKey: Record<string, string> = {};
  const discovered = discoverTextFieldsFromHtml(fragment);
  for (const d of discovered) {
    textByKey[d.key] = d.innerHtml;
  }
  for (const [ key, text ] of Object.entries(parseVariantTextsFromJs(appJs))) {
    if (text.trim().length > 0) {
      textByKey[key] = text;
    }
  }
  const slideCopy = parseSlideCopyFromJs(appJs);
  if (slideCopy !== null) {
    if (slideCopy.headline.trim().length > 0) {
      textByKey['headline'] = slideCopy.headline;
    }
    if (slideCopy.sub.trim().length > 0) {
      textByKey['subhead'] = slideCopy.sub;
    }
  }
  for (const base of [ 'headline', 'subhead', 'price' ] as const) {
    if ((textByKey[base]?.trim() ?? '').length === 0) {
      const electric = textByKey[`${base}_electric`];
      if (electric !== undefined && electric.trim().length > 0) {
        textByKey[base] = electric;
      }
    }
  }

  const fields: Record<string, GenericTextField> = {};
  for (const [ key, text ] of Object.entries(textByKey)) {
    if (text.trim().length === 0) {
      continue;
    }
    fields[key] = defaultTextField(text, fieldStyleDefaults(key, sg, primaryFont, accentColor));
  }
  return { fields, discovered };
}

function fontWeightFromStyleGuide (sg: StyleGuideSlice, index: number, fallback: string): string {
  const row = sg.typography?.[index];
  if (row !== undefined && typeof row.fontWeight === 'number' && Number.isFinite(row.fontWeight)) {
    return String(row.fontWeight);
  }
  return fallback;
}

function extractImgSrcs (fragment: string, ...classHints: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const classHint of classHints) {
    const re = new RegExp(
      `<img\\b[^>]*\\bclass=["'][^"']*${classHint}[^"']*["'][^>]*\\bsrc=["']([^"']+)["']`,
      'giu'
    );
    for (const m of fragment.matchAll(re)) {
      if (m[1] !== undefined && m[1].length > 0 && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    const re2 = new RegExp(
      `<img\\b[^>]*\\bsrc=["']([^"']+)["'][^>]*\\bclass=["'][^"']*${classHint}`,
      'giu'
    );
    for (const m of fragment.matchAll(re2)) {
      if (m[1] !== undefined && m[1].length > 0 && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
  }
  return out;
}

function extractHeroSlideSrcs (fragment: string): string[] {
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu;
  let best: { index: number; tagName: string; score: number } | null = null;

  for (const m of fragment.matchAll(openTagRe)) {
    if (m.index === undefined || m[1] === undefined) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const selfClose = m[3] ?? '';
    if (!isHeroSlidesContainerTag(tag, attrs) || selfClose === '/') {
      continue;
    }
    const outer = extractOuterHtmlFromOpenTag(fragment, m.index, tag);
    const imgCount = outer?.match(/<img\b/giu)?.length ?? 0;
    const score = scoreHeroSlidesContainer(attrs, imgCount);
    if (best === null || score > best.score) {
      best = { index: m.index, tagName: tag, score };
    }
  }

  if (best === null) {
    return [];
  }

  const outer = extractOuterHtmlFromOpenTag(fragment, best.index, best.tagName);
  if (outer === null) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of outer.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/giu)) {
    const src = m[1];
    if (src !== undefined && src.length > 0 && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

function isStaticHeroImageAttrs (attrs: string): boolean {
  if (/\bdata-gv-bind=/iu.test(attrs) || /\blogo\b/iu.test(attrs)) {
    return false;
  }
  return STATIC_HERO_IMG_CLASS_HINTS.some((hint) => new RegExp(`\\b${hint}\\b`, 'iu').test(attrs));
}

function extractStaticHeroSrcs (fragment: string): string[] {
  return extractImgSrcs(fragment, ...STATIC_HERO_IMG_CLASS_HINTS);
}

/** §2.6 — image produit unique (hors carousel `heroSlides`). */
export function ensureStaticHeroImageBinding (html: string): string {
  if (htmlHasBindWithTypes(html, HERO_BIND_KEY, [ 'image' ])) {
    return html;
  }
  let bound = false;
  return html.replace(
    /<img\b([^>]*?)(\/?)>/giu,
    (full, attrs, selfClose) => {
      if (bound || !isStaticHeroImageAttrs(attrs)) {
        return full;
      }
      bound = true;
      const inject = ` data-gv-bind="${HERO_BIND_KEY}" data-gv-type="image"`;
      return `<img${attrs}${inject}${selfClose}>`;
    }
  );
}

function extractClickTag (fragment: string): string | null {
  const patterns = [
    /<a\b[^>]*\bclass=["'][^"']*(?:cta|ad-cta)[^"']*["'][^>]*\bhref=["']([^"']+)["']/iu,
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bclass=["'][^"']*(?:cta|ad-cta)[^"']*["']/iu,
    /<a\b[^>]*\bclass=["'][^"']*cta-btn[^"']*["'][^>]*\bhref=["']([^"']+)["']/iu,
    /<a\b[^>]*\bhref=["']([^"#][^"']*)["']/iu
  ];
  for (const re of patterns) {
    const m = re.exec(fragment);
    if (m?.[1] !== undefined && m[1].length > 0 && m[1] !== '#') {
      return m[1];
    }
  }
  return null;
}

function extractCtaText (fragment: string): string {
  const m =
    /<a\b[^>]*\bclass=["'][^"']*(?:cta|ad-cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu.exec(fragment)
    ?? /<a\b[^>]*\bclass=["'][^"']*cta-btn[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu.exec(fragment);
  if (m?.[1] !== undefined) {
    const inner = stripHtmlTags(m[1]);
    if (inner.length > 0) {
      return inner;
    }
  }
  return '';
}

function parseSlideCopyFromJs (js: string): { headline: string; sub: string } | null {
  const block = /slideCopy\s*=\s*\[([\s\S]*?)\];/iu.exec(js);
  if (block?.[1] === undefined) {
    return null;
  }
  const first = /\{\s*headline\s*:\s*['"]([^'"]*)['"]\s*,\s*sub\s*:\s*['"]([^'"]*)['"]/iu.exec(block[1]);
  if (first?.[1] !== undefined && first[2] !== undefined) {
    return {
      headline: first[1].replace(/\\u00A0/gu, '\u00A0').replace(/\\n/gu, '\n'),
      sub: first[2]
    };
  }
  const firstHtml = /\{\s*headline\s*:\s*['"]([^'"]*(?:\\.[^'"]*)*)['"]/iu.exec(block[1]);
  const subM = /sub\s*:\s*['"]([^'"]*)['"]/iu.exec(block[1]);
  if (firstHtml?.[1] !== undefined) {
    return {
      headline: firstHtml[1].replace(/\\u00A0/gu, '\u00A0'),
      sub: subM?.[1] ?? ''
    };
  }
  return null;
}

function readStyleGuideSlice (outputRunDir: string): StyleGuideSlice {
  const path = join(outputRunDir, 'style-guide.json');
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readUtf8(path)) as StyleGuideSlice;
  } catch {
    return {};
  }
}

function primaryFontFromStyleGuide (sg: StyleGuideSlice): string {
  const first = sg.typography?.[0]?.fontFamily;
  return typeof first === 'string' && first.length > 0 ? first : DEFAULT_FONT;
}

function accentColorFromStyleGuide (sg: StyleGuideSlice): string {
  const palette = sg.primaryColorPalette;
  if (Array.isArray(palette) && palette.length > 1 && typeof palette[1] === 'string') {
    return palette[1];
  }
  return DEFAULT_ACCENT_COLOR;
}

export function buildGenericAdConfigFromStrings (params: {
  indexHtml: string;
  stylesCss: string;
  appJs: string;
  outputRunDir?: string;
}): GenericAdConfig {
  const { indexHtml, stylesCss, appJs, outputRunDir } = params;
  const sg = outputRunDir !== undefined ? readStyleGuideSlice(outputRunDir) : {};
  const primaryFont = primaryFontFromStyleGuide(sg);
  const accentColor = accentColorFromStyleGuide(sg);

  const domId = findFirstAdDomId(indexHtml) ?? 'ad-generic';
  const fragment = getAdFragmentForExtraction(indexHtml, domId);
  if (fragment.length === 0) {
    throw new Error('Cannot export generic config: ad HTML root is empty.');
  }

  const dimensions =
    parseDimensionsFromCss(stylesCss, domId)
    ?? parseDimensionsFromDomId(domId)
    ?? parseDimensionsFromTitle(indexHtml)
    ?? (outputRunDir !== undefined ? parseDimensionsFromFormatsFile(outputRunDir) : null)
    ?? { width: 320, height: 480 };

  const backgroundColor =
    parseBackgroundFromCss(stylesCss, domId)
    ?? (Array.isArray(sg.primaryColorPalette) && typeof sg.primaryColorPalette[0] === 'string'
      ? sg.primaryColorPalette[0]
      : DEFAULT_BG);

  const clickTag =
    extractClickTag(fragment)
    ?? (typeof sg.brandURL === 'string' && sg.brandURL.length > 0 ? sg.brandURL : DEFAULT_CLICK);

  const logoImgs = extractImgSrcs(fragment, 'logo');
  const logo = logoImgs.length > 0 ? logoImgs : extractImgSrcs(fragment, 'ad-logo-img', 'ad-logo');
  const heroSlides = extractHeroSlideSrcs(fragment);
  const hasCarousel = heroSlides.length > 0;
  const staticHeroSrcs = hasCarousel ? [] : extractStaticHeroSrcs(fragment);

  const { fields, discovered } = buildFieldsFromCreative({
    fragment,
    appJs,
    sg,
    primaryFont,
    accentColor
  });

  if (fields['ctaText'] === undefined) {
    const ctaText = extractCtaText(fragment);
    if (ctaText.length > 0) {
      fields['ctaText'] = defaultTextField(ctaText, fieldStyleDefaults('ctaText', sg, primaryFont, accentColor));
    }
  }

  splitHeadlineAccentFields(fields, (key) =>
    fieldStyleDefaults(key, sg, primaryFont, accentColor)
  );
  applyFieldStylesFromCss(fields, stylesCss);

  const images: Record<string, string[]> = {};
  if (logo.length > 0) {
    images['logo'] = logo;
  }
  if (hasCarousel) {
    images['heroSlides'] = heroSlides;
  } else if (staticHeroSrcs.length > 0) {
    images[HERO_BIND_KEY] = [ staticHeroSrcs[0]! ];
  }

  const settings: GenericAdSettings = {};
  if (backgroundColor.length > 0) {
    settings.backgroundColor = backgroundColor;
  }
  if (clickTag.length > 0) {
    settings.clickTag = clickTag;
  }

  let htmlWithBindings = stripDecorativeAriaHidden(injectGenericBindings(fragment));
  htmlWithBindings = injectBindingsForDiscovered(htmlWithBindings, discovered);
  if (fields['headlineAccent'] !== undefined) {
    htmlWithBindings = restructureHeadlineAccentHtml(htmlWithBindings);
  }
  htmlWithBindings = restructureCtaLabelHtml(htmlWithBindings);
  htmlWithBindings = appendHiddenFieldBindings(htmlWithBindings, fields);
  if (hasCarousel && !htmlHasBindWithTypes(htmlWithBindings, HERO_SLIDES_BIND_KEY, [ 'image-list' ])) {
    htmlWithBindings = ensureHeroSlidesImageListBinding(htmlWithBindings);
  }
  const hasHeroSlidesBinding = htmlHasBindWithTypes(htmlWithBindings, HERO_SLIDES_BIND_KEY, [ 'image-list' ]);
  if (!hasHeroSlidesBinding) {
    delete images['heroSlides'];
  } else if (images['heroSlides'] !== undefined) {
    settings.slideInterval = parseSlideInterval(appJs);
  }
  if (!hasCarousel && images[HERO_BIND_KEY] !== undefined) {
    htmlWithBindings = ensureStaticHeroImageBinding(htmlWithBindings);
  }
  if (!htmlHasBindWithTypes(htmlWithBindings, HERO_BIND_KEY, [ 'image' ])) {
    delete images[HERO_BIND_KEY];
  }

  const draft: GenericAdConfig = {
    type: 'generic',
    dimensions,
    settings,
    fields,
    images,
    html: htmlWithBindings,
    css: prepareCssForGalleryExport(stylesCss, sg, domId),
    js: appJs
  };

  return serializeGenericAdConfig(draft);
}

export function buildGenericAdConfig (params: {
  bundleDir: string;
  outputRunDir: string;
}): GenericAdConfig {
  const indexPath = join(params.bundleDir, 'index.html');
  const cssPath = join(params.bundleDir, 'styles.css');
  const jsPath = join(params.bundleDir, 'app.js');
  for (const p of [ indexPath, cssPath, jsPath ]) {
    if (!existsSync(p)) {
      throw new Error(`Missing required file: ${p}`);
    }
  }
  const indexHtml = readUtf8(indexPath);
  const stylesCss = readUtf8(cssPath);
  const appJs = readUtf8(jsPath);
  syncBundleAssetsFromBundleSource({
    bundleDir: params.bundleDir,
    html: indexHtml,
    css: stylesCss,
    js: appJs
  });
  const base = buildGenericAdConfigFromStrings({
    indexHtml,
    stylesCss,
    appJs,
    outputRunDir: params.outputRunDir
  });
  const embedded = embedBundleAssetsInConfig(base, params.bundleDir);
  return serializeGenericAdConfig(embedded);
}

/** Nom du fichier JSON galerie écrit dans chaque `code/Vn/`. */
export const GENERIC_CONFIG_FILENAME = 'generic-config.json';

export function genericConfigFilePath (bundleDir: string): string {
  return join(bundleDir, GENERIC_CONFIG_FILENAME);
}

/** True when `generic-config.json` exists and is at least as new as `index.html`. */
export function isGenericConfigFileFresh (bundleDir: string): boolean {
  const jsonPath = genericConfigFilePath(bundleDir);
  const indexPath = join(bundleDir, 'index.html');
  if (!existsSync(jsonPath) || !existsSync(indexPath)) {
    return false;
  }
  return statSync(jsonPath).mtimeMs >= statSync(indexPath).mtimeMs;
}

export function readGenericAdConfigFile (bundleDir: string): GenericAdConfig {
  const validated = validateGenericAdConfig(
    JSON.parse(readFileSync(genericConfigFilePath(bundleDir), 'utf8')) as unknown
  );
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return validated.config;
}

export function writeGenericAdConfigFile (params: {
  bundleDir: string;
  outputRunDir: string;
  outPath?: string;
}): { path: string; config: GenericAdConfig } {
  const config = buildGenericAdConfig({
    bundleDir: params.bundleDir,
    outputRunDir: params.outputRunDir
  });
  const outPath = params.outPath ?? genericConfigFilePath(params.bundleDir);
  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
  return { path: outPath, config };
}

// ===== creative-code-versions.mts =====
const VERSION_DIR_RE = /^V(\d+)$/iu;

export type CodeVersionInfo = {
  versionId: string;
  versionNumber: number;
  versionLabel: string;
  directoryPath: string;
  indexHtmlPath: string;
  mtimeMs: number;
  /** True when bundle lives at `code/index.html` (pre-versioning layout). */
  isLegacyLayout: boolean;
};

export function versionLabelFromNumber (n: number): string {
  return `Version ${String(n)}`;
}

export function parseVersionDirName (name: string): number | null {
  const m = VERSION_DIR_RE.exec(name);
  if (m === null || m[1] === undefined) {
    return null;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readActiveVersionId (codeRoot: string): string | null {
  const activePath = join(codeRoot, 'active-version.json');
  if (!existsSync(activePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(activePath, 'utf8')) as { activeVersion?: unknown };
    return typeof parsed.activeVersion === 'string' && parsed.activeVersion.trim().length > 0
      ? parsed.activeVersion.trim()
      : null;
  } catch {
    return null;
  }
}

export function writeActiveVersionId (outputRunPath: string, versionId: string): void {
  const codeRoot = join(outputRunPath, 'code');
  mkdirSync(codeRoot, { recursive: true });
  writeFileSync(
    join(codeRoot, 'active-version.json'),
    `${JSON.stringify({ activeVersion: versionId }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
}

/** All creative bundles under `output/<run>/code/` (Vn subdirs + optional legacy flat layout). */
export function listCodeVersions (outputRunPath: string): CodeVersionInfo[] {
  const codeRoot = join(outputRunPath, 'code');
  if (!existsSync(codeRoot) || !statSync(codeRoot).isDirectory()) {
    return [];
  }

  const versions: CodeVersionInfo[] = [];

  for (const ent of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      continue;
    }
    const versionNumber = parseVersionDirName(ent.name);
    if (versionNumber === null) {
      continue;
    }
    const directoryPath = join(codeRoot, ent.name);
    const indexHtmlPath = join(directoryPath, 'index.html');
    if (!existsSync(indexHtmlPath)) {
      continue;
    }
    versions.push({
      versionId: ent.name,
      versionNumber,
      versionLabel: versionLabelFromNumber(versionNumber),
      directoryPath,
      indexHtmlPath,
      mtimeMs: statSync(indexHtmlPath).mtimeMs,
      isLegacyLayout: false
    });
  }

  const legacyIndex = join(codeRoot, 'index.html');
  const hasV1Dir = versions.some((v) => v.versionNumber === 1);
  if (existsSync(legacyIndex) && !hasV1Dir) {
    versions.push({
      versionId: 'V1',
      versionNumber: 1,
      versionLabel: versionLabelFromNumber(1),
      directoryPath: codeRoot,
      indexHtmlPath: legacyIndex,
      mtimeMs: statSync(legacyIndex).mtimeMs,
      isLegacyLayout: true
    });
  }

  versions.sort((a, b) => a.versionNumber - b.versionNumber);
  return versions;
}

export function latestCodeVersion (outputRunPath: string): CodeVersionInfo | null {
  const versions = listCodeVersions(outputRunPath);
  if (versions.length === 0) {
    return null;
  }
  const activeId = readActiveVersionId(join(outputRunPath, 'code'));
  if (activeId !== null) {
    const active = versions.find((v) => v.versionId.toLowerCase() === activeId.toLowerCase());
    if (active !== undefined) {
      return active;
    }
  }
  return versions[versions.length - 1] ?? null;
}

export function resolveCodeDirectory (
  outputRunPath: string,
  versionId?: string | null
): string | null {
  const versions = listCodeVersions(outputRunPath);
  if (versions.length === 0) {
    return null;
  }
  const trimmed = versionId?.trim() ?? '';
  if (trimmed.length > 0) {
    const match = versions.find((v) => v.versionId.toLowerCase() === trimmed.toLowerCase());
    return match?.directoryPath ?? null;
  }
  return latestCodeVersion(outputRunPath)?.directoryPath ?? null;
}

function maxAllocatedVersionNumber (outputRunPath: string): number {
  const codeRoot = join(outputRunPath, 'code');
  let max = 0;
  for (const v of listCodeVersions(outputRunPath)) {
    max = Math.max(max, v.versionNumber);
  }
  if (!existsSync(codeRoot) || !statSync(codeRoot).isDirectory()) {
    return max;
  }
  for (const ent of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      continue;
    }
    const n = parseVersionDirName(ent.name);
    if (n !== null) {
      max = Math.max(max, n);
    }
  }
  return max;
}

/** Creates `code/V{n}/` and sets it as the active version. */
export function allocateNextCodeVersionDirectory (outputRunPath: string): CodeVersionInfo {
  const nextNumber = maxAllocatedVersionNumber(outputRunPath) + 1;
  const versionId = `V${String(nextNumber)}`;
  const directoryPath = join(outputRunPath, 'code', versionId);
  mkdirSync(directoryPath, { recursive: true });
  writeActiveVersionId(outputRunPath, versionId);

  const indexHtmlPath = join(directoryPath, 'index.html');
  return {
    versionId,
    versionNumber: nextNumber,
    versionLabel: versionLabelFromNumber(nextNumber),
    directoryPath,
    indexHtmlPath,
    mtimeMs: Date.now(),
    isLegacyLayout: false
  };
}

export function codeVersionCount (outputRunPath: string): number {
  return listCodeVersions(outputRunPath).length;
}

// ===== creative-asset-descriptions.mts =====
export const DEFAULT_ASSET_DESCRIPTION_MODEL = 'claude-haiku-4-5-20251001';

export const assetKindSchema = z.enum([
  'product_packshot',
  'lifestyle_scene',
  'text_only_banner',
  'theatrical_poster',
  'key_art',
  'film_still',
  'promotional_photo',
  'attraction_photo',
  'ticket_pass',
  'venue_lifestyle',
  'mascot_brand',
  'logo',
  'other'
]);

/** Film/series promo kinds accepted by entertainment audit (not retail packshots). */
export const ENTERTAINMENT_PROMO_ASSET_KINDS = new Set([
  'theatrical_poster',
  'key_art',
  'film_still',
  'promotional_photo',
  'lifestyle_scene'
]);

/** Theme park / destination promo kinds accepted by experience audit. */
export const EXPERIENCE_PROMO_ASSET_KINDS = new Set([
  'attraction_photo',
  'ticket_pass',
  'venue_lifestyle',
  'lifestyle_scene',
  'promotional_photo',
  'product_packshot'
]);

/** Promo / experience visuals usable as ad heroes (not text-only navigation tiles). */
export const USABLE_PROMO_ASSET_KINDS = new Set([
  'product_packshot',
  'lifestyle_scene',
  ...ENTERTAINMENT_PROMO_ASSET_KINDS,
  ...EXPERIENCE_PROMO_ASSET_KINDS
]);

export const assetDescriptionEntrySchema = z.object({
  asset_id: z.string(),
  fileName: z.string(),
  fileType: z.enum([ 'logos', 'products' ]),
  description: z.string(),
  layout_hints: z.array(z.string()),
  dominant_colors: z.array(z.string()),
  shows_physical_product: z.boolean().optional(),
  asset_kind: assetKindSchema.optional(),
  /** Concrete SKU / ritual / kit name visible in the image (products only). */
  primary_product_name: z.string().optional(),
  /** True when the image is a multi-SKU flat-lay with no single dominant product. */
  is_generic_collection: z.boolean().optional()
});

export const assetDescriptionsFileSchema = z.object({
  generated_at: z.string(),
  model: z.string(),
  assets: z.array(assetDescriptionEntrySchema)
});

export type AssetDescriptionEntry = z.infer<typeof assetDescriptionEntrySchema>;
export type AssetDescriptionsFile = z.infer<typeof assetDescriptionsFileSchema>;

const describeBatchOutputSchema = z.object({
  assets: z.array(assetDescriptionEntrySchema)
});

export function assetDescriptionsPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'asset-descriptions.json');
}

export function loadAssetDescriptions (directoryPath: string): AssetDescriptionsFile | null {
  const path = assetDescriptionsPath(directoryPath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return assetDescriptionsFileSchema.parse(raw);
  } catch {
    return null;
  }
}

export function maxProductAssetsForCodegen (): number {
  const raw = process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return n;
}

function listAssetFiles (directoryPath: string, fileType: 'logos' | 'products'): string[] {
  return listAssetImageFiles(directoryPath, fileType);
}

function filenameFallbackDescription (fileName: string, fileType: 'logos' | 'products'): string {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const keywordString = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const categoryLabel = fileType === 'logos' ? 'logo de marque' : 'visuel produit';
  const usageHint =
    fileType === 'logos'
      ? 'a utiliser en branding (header, badge, signature visuelle)'
      : 'a utiliser comme visuel hero ou element de scene principal';
  return `Description asset (${categoryLabel}): ${keywordString || baseName}. ${usageHint}.`;
}

function descriptionMapFromFile (file: AssetDescriptionsFile | null): Map<string, AssetDescriptionEntry> {
  const map = new Map<string, AssetDescriptionEntry>();
  if (file === null) {
    return map;
  }
  for (const entry of file.assets) {
    map.set(`${entry.fileType}/${entry.fileName}`, entry);
    map.set(entry.fileName, entry);
  }
  return map;
}

function urlHostMatchesOfficialReview (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0 || url.length === 0) {
    return false;
  }
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
    return officialHosts.some((oh) => h === oh || h.endsWith(`.${oh}`) || oh.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function rankProductFiles (
  directoryPath: string,
  fileNames: string[],
  officialHosts: readonly string[],
  descriptions?: AssetDescriptionsFile | null
): Promise<string[]> {
  const sourceMap = loadProductAssetSources(directoryPath);
  const descByKey = descriptionMapFromFile(descriptions ?? null);
  const scored: { fileName: string; score: number }[] = [];
  for (const fileName of fileNames) {
    let score = 0;
    const sourceUrl = sourceMap.get(fileName)?.sourceUrl ?? '';
    if (urlHostMatchesOfficialReview(sourceUrl, officialHosts)) {
      score += 1000;
    }
    const entry = descByKey.get(`products/${fileName}`) ?? descByKey.get(fileName);
    const usablePromo =
      entry?.asset_kind !== undefined && USABLE_PROMO_ASSET_KINDS.has(entry.asset_kind);
    if (entry?.shows_physical_product === true || usablePromo) {
      score += 5000;
    } else if (entry?.asset_kind === 'text_only_banner') {
      score -= 10_000;
    } else if (entry?.shows_physical_product === false) {
      score -= 5000;
    }
    try {
      const filePath = join(directoryPath, 'products', fileName);
      const { width, height } = await imageSizeFromFile(filePath);
      score += (width ?? 0) * (height ?? 0);
    } catch {
      score += 0;
    }
    scored.push({ fileName, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.fileName);
}

export type BuildCodegenAssetPromptResult = {
  fileMessages: Anthropic.Messages.TextBlockParam[];
  assetFiles: AssetFile[];
  usedPrecomputedDescriptions: boolean;
};

export async function buildCodegenAssetPromptBlocks (params: {
  directoryPath: string;
  styleGuide: StyleGuide;
  descriptionsFile?: AssetDescriptionsFile | null;
  /** Return false to omit a file from the codegen prompt (e.g. video in habillage). */
  shouldIncludeFile?: (file: {
    fileName: string;
    fileType: 'logos' | 'products';
    sniffedMime: string | null;
  }) => boolean;
}): Promise<BuildCodegenAssetPromptResult> {
  const descriptions =
    params.descriptionsFile !== undefined
      ? params.descriptionsFile
      : loadAssetDescriptions(params.directoryPath);
  const descByKey = descriptionMapFromFile(descriptions);
  const usedPrecomputed = descriptions !== null && descriptions.assets.length > 0;

  if (usedPrecomputed) {
    console.log(
      `[creative-native] Using precomputed asset descriptions (${String(descriptions!.assets.length)} assets).`
    );
  } else {
    console.warn(
      '[creative-native] No review/asset-descriptions.json — using filename fallback descriptions.'
    );
  }

  const imageCtx: ImageSearchContext = {
    brandName: params.styleGuide.brandName,
    companyName: params.styleGuide.companyName,
    productName: params.styleGuide.productName,
    brandURL: params.styleGuide.brandURL,
    companyURL: params.styleGuide.companyURL
  };
  const officialHosts = officialHostsFromContext(imageCtx);
  const sourceMap = loadProductAssetSources(params.directoryPath);

  const maxProducts = maxProductAssetsForCodegen();
  const allProducts = listAssetFiles(params.directoryPath, 'products');
  const rankedProducts = await rankProductFiles(
    params.directoryPath,
    allProducts,
    officialHosts,
    descriptions
  );
  const selectedProducts =
    maxProducts === 0
      ? new Set(rankedProducts)
      : new Set(rankedProducts.slice(0, maxProducts));
  if (maxProducts > 0 && allProducts.length > maxProducts) {
    console.log(
      `[creative-native] Product assets capped at ${String(maxProducts)} of ${String(allProducts.length)} for codegen prompt.`
    );
  }

  const fileMessages: Anthropic.Messages.TextBlockParam[] = [];
  const assetFiles: AssetFile[] = [];

  const refUrl = params.styleGuide.campaignReferenceUrl?.trim() ?? '';
  if (refUrl.length > 0) {
    fileMessages.push({
      type: 'text',
      text:
        `Campaign reference URL (listing/collection page for this creative): ${refUrl}\n` +
        'Use product assets as heroes from this campaign context.'
    });
  }

  for (const fileType of [ 'logos', 'products' ] as const) {
    const fileList = listAssetFiles(params.directoryPath, fileType);
    for (const fileName of fileList) {
      if (fileType === 'products' && !selectedProducts.has(fileName)) {
        continue;
      }

      const filePath = join(params.directoryPath, fileType, fileName);
      const fileBuf = readFileSync(filePath);
      const sniffedMimeEarly = sniffImageMimeFromBuffer(fileBuf);
      if (
        params.shouldIncludeFile !== undefined &&
        !params.shouldIncludeFile({
          fileName,
          fileType,
          sniffedMime: sniffedMimeEarly
        })
      ) {
        continue;
      }
      const assetId = `${fileType}/${fileName}`;
      const entry = descByKey.get(assetId) ?? descByKey.get(fileName);
      const description =
        entry?.description ?? filenameFallbackDescription(fileName, fileType);
      const layoutHints =
        entry !== undefined && entry.layout_hints.length > 0
          ? `\n  - Layout hints: ${entry.layout_hints.join(', ')}`
          : '';
      const colors =
        entry !== undefined && entry.dominant_colors.length > 0
          ? `\n  - Dominant colors (reference only — do NOT use in CSS; style-guide palette is mandatory): ${entry.dominant_colors.join(', ')}`
          : '';
      const sourceUrl = sourceMap.get(fileName)?.sourceUrl ?? '';
      const sourceLine =
        sourceUrl.length > 0 ? `\n  - Source URL (context): ${sourceUrl}` : '';
      const localCodePath = `./${fileName}`;

      if (isSvgAssetFile(fileName, fileBuf)) {
        const textPayload =
          `- Asset: ${fileName}\n` +
          `  - Category: logo\n` +
          `  - Format: SVG vector (pre-approved; no image block in this prompt)\n` +
          `  - Local path to use in generated code: ${localCodePath}\n` +
          `  - Visual description (authoritative): ${description}${layoutHints}${colors}\n` +
          `  - Use in HTML as <img src="${localCodePath}" alt="logo">; path is relative to index.html in code/\n` +
          `  - Integrate this SVG wordmark at a readable scale without filters.`;
        fileMessages.push({ type: 'text', text: textPayload });
        assetFiles.push({ fileName, filePath, fileType });
        continue;
      }

      const sniffedMime = sniffImageMimeFromBuffer(fileBuf);
      if (sniffedMime === null) {
        console.warn(
          `[creative-native] Skipping non-image asset ${fileType}/${fileName} (not a raster/SVG image).`
        );
        continue;
      }

      const { width, height } = await imageSizeFromFile(filePath);
      const textPayload =
        `- Asset: ${fileName}\n` +
        `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
        `  - Local path to use in generated code: ${localCodePath}\n` +
        `  - Dimensions: ${String(width)}×${String(height)}\n` +
        `  - Visual description (authoritative — do not re-infer from pixels): ${description}${layoutHints}${colors}${sourceLine}\n` +
        `  - Integrate visually in the creative using the local path above.`;
      fileMessages.push({ type: 'text', text: textPayload });
      assetFiles.push({ fileName, filePath, fileType });
    }
  }

  return { fileMessages, assetFiles, usedPrecomputedDescriptions: usedPrecomputed };
}

export type DescribeApprovedAssetsResult = {
  file: AssetDescriptionsFile;
  usage: {
    api_calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
};

export type DescribeAssetsOptions = {
  anthropicClient: Anthropic;
  directoryPath: string;
  styleGuide: StyleGuide;
  model?: string;
  reviewRound?: number;
  phase?: 'style_guide' | 'creative';
};

export async function describeAssetsForReview (
  params: DescribeAssetsOptions
): Promise<DescribeApprovedAssetsResult | null> {
  if (process.env['STYLE_GUIDE_SKIP_ASSET_DESCRIPTIONS']?.trim() === '1') {
    console.log('[asset-descriptions] Skipped (STYLE_GUIDE_SKIP_ASSET_DESCRIPTIONS=1).');
    return null;
  }

  const model =
    params.model ?? process.env['CREATIVE_ASSET_DESCRIPTION_MODEL']?.trim() ?? DEFAULT_ASSET_DESCRIPTION_MODEL;

  const catalog = isCatalogCampaign({
    campaignContext: params.styleGuide.campaignContext ?? null,
    productName: params.styleGuide.productName,
    brandName: params.styleGuide.brandName,
    brandContext: params.styleGuide.brandContext,
    brandURL: params.styleGuide.brandURL
  });
  const heroProduct = isHeroProductCampaign({
    campaignContext: params.styleGuide.campaignContext ?? null,
    productName: params.styleGuide.productName,
    brandName: params.styleGuide.brandName,
    brandContext: params.styleGuide.brandContext,
    brandURL: params.styleGuide.brandURL,
    ...(params.styleGuide.campaignReferenceUrl !== undefined &&
    params.styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: params.styleGuide.campaignReferenceUrl }
      : {})
  });

  const profile = resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: params.styleGuide.campaignContext ?? null,
    productName: params.styleGuide.productName,
    brandName: params.styleGuide.brandName,
    brandContext: params.styleGuide.brandContext,
    brandURL: params.styleGuide.brandURL,
    campaignAssetProfile: params.styleGuide.campaignAssetProfile
  }));
  console.log(`[asset-descriptions] Campaign asset profile: ${profile}`);

  const describeIntro =
    profile === 'entertainment'
      ? 'Describe each asset below factually for film/series promotional ad review (French descriptions OK). ' +
        'Focus on: poster/key art/stills, cast, title treatment, framing, readable title text, colors.\n'
      : profile === 'experience'
        ? 'Describe each asset below factually for theme park / leisure / destination ad review (French descriptions OK). ' +
          'Focus on: attractions, rides, families, tickets/passes, mascot, venue atmosphere, readable promo text.\n'
        : 'Describe each asset below factually for HTML5 display ad review (French descriptions OK). ' +
          'Focus on: subject, framing, background, readable text on image, colors, photographed products vs text-only graphics.\n';

  const entertainmentRules =
    'Entertainment campaign: products/ are film promotional visuals (posters, key art, stills, cast photos) — NOT retail packshots. ' +
    'Set shows_physical_product=false for theatrical posters, key art, and film stills (normal). ' +
    'Set asset_kind=theatrical_poster | key_art | film_still | promotional_photo | lifestyle_scene as appropriate. ' +
    'Set text_only_banner only for category navigation tiles with no film imagery. ' +
    `Set primary_product_name to the film title (e.g. "${params.styleGuide.productName}") — same title on multiple assets is OK. ` +
    'Set is_generic_collection=false for all entertainment assets.';

  const experienceRules =
    'Experience campaign (theme park, destination, ticketing): products/ are attraction photos, family lifestyle, passes/tickets — NOT retail SKU packshots. ' +
    'Set shows_physical_product=false for rides, attractions, venue scenes, and family moments (normal). ' +
    'Set shows_physical_product=true only when a physical ticket/pass/gift card is visibly photographed. ' +
    'Set asset_kind=attraction_photo | venue_lifestyle | ticket_pass | lifestyle_scene | mascot_brand | promotional_photo as appropriate. ' +
    'Set text_only_banner only for category navigation tiles with no park/attraction imagery. ' +
    `Set primary_product_name to attraction name, ticket type, or campaign offer (e.g. "${params.styleGuide.productName}", "Abonnement Saison", "Mahuka") — generic visit labels are OK. ` +
    'Set is_generic_collection=false for all experience assets.';

  const retailRules =
    'Set shows_physical_product=true only when a real product (packshot, box, garment, food item, etc.) is visibly photographed. ' +
    'Set shows_physical_product=false for category navigation tiles, menu graphics, or promo banners with only typography on a colored background. ' +
    'Set asset_kind=text_only_banner for those text-only graphics; product_packshot or lifestyle_scene when merchandise is visible.\n' +
    'For each products/ asset with shows_physical_product=true: set primary_product_name to the concrete dominant SKU/ritual/kit name visible ' +
    '(e.g. "Sommeil", "Kit Bubble Tea Litchi Rose") — never vague labels like "thés Kusmi" or "sélection". ' +
    'If multiple products appear, name the most prominent hero. ' +
    'Set is_generic_collection=true only for flat-lays showing many different SKUs with no single dominant product; otherwise false.';

  const expectedAssets: { asset_id: string; fileName: string; fileType: 'logos' | 'products' }[] = [];
  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        describeIntro +
        `Brand: ${params.styleGuide.brandName}\n` +
        `Campaign product: ${params.styleGuide.productName}\n` +
        (params.styleGuide.campaignContext !== undefined && params.styleGuide.campaignContext.length > 0
          ? `Campaign context: ${params.styleGuide.campaignContext}\n`
          : '') +
        (params.styleGuide.campaignReferenceUrl !== undefined &&
        params.styleGuide.campaignReferenceUrl.length > 0
          ? `Campaign reference URL: ${params.styleGuide.campaignReferenceUrl}\n`
          : '') +
        (params.styleGuide.brandContext !== undefined && params.styleGuide.brandContext.length > 0
          ? `Brand context: ${params.styleGuide.brandContext}\n`
          : '') +
        (catalog
          ? 'Catalog/listing campaign: each product image should be a different SKU from the collection.\n'
          : '') +
        (heroProduct
          ? 'Hero product campaign: all product images depict the same model/SKU — set the same primary_product_name on every asset (different angles, lifestyle, packshot are OK).\n'
          : '') +
        (profile === 'entertainment'
          ? entertainmentRules
          : profile === 'experience'
            ? experienceRules
            : retailRules)
    }
  ];

  for (const fileType of [ 'logos', 'products' ] as const) {
    const files = listAssetFiles(params.directoryPath, fileType);
    if (files.length === 0) {
      continue;
    }
    userContent.push({
      type: 'text',
      text: `--- ${fileType} (${String(files.length)} file(s)) ---`
    });
    for (const fileName of files) {
      const asset_id = `${fileType}/${fileName}`;
      expectedAssets.push({ asset_id, fileName, fileType });
      const filePath = join(params.directoryPath, fileType, fileName);
      userContent.push({ type: 'text', text: `Asset id: ${asset_id}` });

      if (fileType === 'logos') {
        const logoBlock = await readLogoFileAsAnthropicImageBlock(filePath);
        if (logoBlock !== null) {
          userContent.push(logoBlock);
        } else {
          userContent.push({ type: 'text', text: `(unreadable logo: ${filePath})` });
        }
        continue;
      }

      const block = readFileAsAnthropicImageBlock(filePath);
      if (block !== null) {
        userContent.push(block);
      } else {
        userContent.push({ type: 'text', text: `(unreadable raster: ${filePath})` });
      }
    }
  }

  if (expectedAssets.length === 0) {
    console.log('[asset-descriptions] No assets to describe.');
    return null;
  }

  const systemPrompt =
    profile === 'entertainment'
      ? [
          'You write factual visual descriptions for film/series promotional assets before HTML5 ad approval.',
          'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
          'shows_physical_product (required): false for posters/key art/stills; true only if merchandise (DVD box, etc.) is visibly photographed.',
          'asset_kind (required): theatrical_poster | key_art | film_still | promotional_photo | lifestyle_scene | text_only_banner | logo | other.',
          'primary_product_name (required for products/): film title; same title on multiple assets is expected.',
          'is_generic_collection (required for products/): always false for entertainment campaigns.',
          'layout_hints: short tags e.g. theatrical-poster, key-art, character-close-up, ensemble-cast, production-still, logo-lockup.',
          'dominant_colors: up to 4 hex colors if visible, else empty array.',
          'description: 2-4 factual sentences — identify poster vs still vs BTS; state title text if readable.'
        ].join('\n')
      : profile === 'experience'
        ? [
            'You write factual visual descriptions for theme park / leisure / destination assets before HTML5 ad approval.',
            'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
            'shows_physical_product (required): false for attractions/rides/family scenes; true only for photographed tickets/passes/gift cards.',
            'asset_kind (required): attraction_photo | venue_lifestyle | ticket_pass | lifestyle_scene | mascot_brand | promotional_photo | text_only_banner | logo | other.',
            'primary_product_name (required for products/): attraction name, ticket/pass type, or campaign offer — not retail SKU codes.',
            'is_generic_collection (required for products/): always false for experience campaigns.',
            'layout_hints: short tags e.g. roller-coaster-action, family-moment, ticket-pass, mascot-hero, ride-action, park-setting.',
            'dominant_colors: up to 4 hex colors if visible, else empty array.',
            'description: 2-4 factual sentences — identify ride vs family scene vs ticket; name attraction if visible.'
          ].join('\n')
        : [
            'You write factual visual descriptions for brand assets before HTML5 ad approval.',
            'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
            'shows_physical_product (required): true if a product is visibly photographed; false for text-only banners/tiles.',
            'asset_kind (required): product_packshot | lifestyle_scene | text_only_banner | logo | other.',
            'primary_product_name (required for products/ with shows_physical_product=true): concrete SKU/ritual/kit name; empty for logos.',
            'is_generic_collection (required for products/): true only when no single dominant SKU is identifiable.',
            'layout_hints: short tags e.g. packshot-centre, lifestyle-scene, categorie-banner, logo-lockup.',
            'dominant_colors: up to 4 hex colors if visible, else empty array.',
            'description: 2-4 factual sentences — state explicitly when an image contains only text on a solid/gradient background.'
          ].join('\n');

  console.log(`[asset-descriptions] Describing ${String(expectedAssets.length)} asset(s) — model ${model}`);

  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    'asset-descriptions batch',
    async () =>
      await withAnthropicRetry('asset-descriptions batch', async () => {
        return await params.anthropicClient.messages.parse({
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [ { role: 'user', content: userContent } ],
          output_config: {
            format: zodOutputFormat(describeBatchOutputSchema)
          }
        });
      })
  );

  if (msg.parsed_output === null || msg.parsed_output === undefined) {
    throw new Error('Asset descriptions: empty structured output from API.');
  }

  const parsed = describeBatchOutputSchema.parse(msg.parsed_output);
  const file: AssetDescriptionsFile = {
    generated_at: new Date().toISOString(),
    model,
    assets: parsed.assets
  };

  const reviewDir = join(params.directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const outPath = assetDescriptionsPath(params.directoryPath);
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`[asset-descriptions] Wrote ${outPath} (${String(file.assets.length)} entries).`);

  const usage = {
    api_calls: 1,
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0
  };

  const pipelineEntry = entryFromSingleUsage({
    action: 'asset_descriptions',
    agent: 'lib/creative-asset-descriptions.mts',
    model,
    usage: msg.usage,
    phase: params.phase ?? 'style_guide',
    ...(params.reviewRound !== undefined ? { review_round: params.reviewRound } : {}),
    duration_ms: apiDurationMs
  });
  logPipelineUsageToConsole(appendPipelineUsage(params.directoryPath, pipelineEntry).entries.at(-1)!);

  return { file, usage };
}

// ===== creative-native-generate.mts =====
export type CreativeNativeGenerationOptions = {
  directoryUuid: string;
  repoRoot?: string;
  envOverrides?: NodeJS.ProcessEnv;
};

export type CreativeNativeGenerationResult = {
  directoryPath: string;
  codeDirectoryPath: string;
  activeModel: string;
  isRegen: boolean;
  durationMsTotal: number;
};

export async function runCreativeNativeGeneration (
  options: CreativeNativeGenerationOptions
): Promise<CreativeNativeGenerationResult> {
  const repoRoot = options.repoRoot ?? repoRootFromModuleDir(import.meta.dirname);
  const env = { ...process.env, ...options.envOverrides };
  const directoryPath = join(repoRoot, 'output', options.directoryUuid);

  const assetsReviewSkip = env['CREATIVE_ASSETS_REVIEW_SKIP']?.trim() === '1';
  const assetsReviewFinalPath = join(directoryPath, 'review', 'assets-review-final.json');
  if (!assetsReviewSkip) {
    if (!existsSync(assetsReviewFinalPath)) {
      throw new Error(
        `Assets review required before creative generation. Run the style guide studio job with "Review assets après génération", `
          + `or: node src/agents/run-style-guide-assets-review.mts ${options.directoryUuid}\n`
          + 'Or set CREATIVE_ASSETS_REVIEW_SKIP=1 to bypass (not recommended).'
      );
    }
    const assetsFinal = JSON.parse(readFileSync(assetsReviewFinalPath, 'utf8')) as { satisfied?: boolean };
    if (assetsFinal.satisfied !== true) {
      throw new Error(
        `Assets review not satisfied (${assetsReviewFinalPath}). Re-run: node src/agents/run-style-guide-assets-review.mts ${options.directoryUuid}`
      );
    }
  }

  const regenFeedback = env['CREATIVE_REGEN_FEEDBACK']?.trim();
  const isRegen = regenFeedback !== undefined && regenFeedback.length > 0;
  let codeDirectoryPath: string;
  if (isRegen) {
    const versionHint = env['CREATIVE_CODE_VERSION']?.trim();
    const resolved = resolveCodeDirectory(directoryPath, versionHint ?? undefined);
    if (resolved === null) {
      throw new Error(`No creative code version to patch under ${join(directoryPath, 'code')}. Run a full generation first.`);
    }
    codeDirectoryPath = resolved;
  } else {
    const allocated = allocateNextCodeVersionDirectory(directoryPath);
    codeDirectoryPath = allocated.directoryPath;
    console.log(`[creative-native] New code version ${allocated.versionId} → ${allocated.directoryPath}`);
  }

  const adFormatPresets = loadAdFormatPresets(repoRoot);
  const adFormats = parseCreativeAdFormatsFromEnv(env['CREATIVE_AD_FORMATS'], adFormatPresets);
  console.log('[creative-native] Ad formats:', JSON.stringify(adFormats));
  const styleGuidePath = join(directoryPath, 'style-guide.json');
  const styleGuide = JSON.parse(readFileSync(styleGuidePath, { encoding: 'utf8' })) as StyleGuide;
  const anthropicApiKey = env['ANTHROPIC_API_KEY'];
  if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
    throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
  }

  const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
  const skillsText = loadSkillsForCodegenPrompt(repoRoot);
  const { fileMessages, assetFiles } = await buildCodegenAssetPromptBlocks({ directoryPath, styleGuide });
  const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  delete (prunedStyleGuide as { logoFileUrls?: unknown }).logoFileUrls;
  delete (prunedStyleGuide as { productPictureUrls?: unknown }).productPictureUrls;

  const baseMessages: Anthropic.Messages.MessageParam[] = [{
    role: 'user',
    content: [
      ...fileMessages,
      { type: 'text', text: buildCampaignProductHeroInstruction(prunedStyleGuide) },
      { type: 'text', text: JSON.stringify(prunedStyleGuide) },
      { type: 'text', text: buildStyleGuideColorConstraintText(prunedStyleGuide) },
      { type: 'text', text: buildStyleGuideFontConstraintText(prunedStyleGuide) }
    ]
  }];

  const activeModel = resolveCreativeModel(isRegen);
  console.log(`[creative-native] Model: ${activeModel} (${isRegen ? 'regeneration' : 'generation'})`);
  const messages = [ ...baseMessages ];
  if (isRegen && regenFeedback !== undefined) {
    const existingBundle = loadExistingCodeBundle(codeDirectoryPath);
    if (existingBundle.files.some((f) => f.truncated)) {
      console.warn('[creative-native] Regen: one or more code files truncated for prompt context.');
    }
    messages.push({ role: 'user', content: formatExistingBundleForPrompt(existingBundle) });
    messages.push({ role: 'user', content: regenFeedback });
    if (env['CREATIVE_REGEN_STRICT_MINIMAL']?.trim() === '1') {
      messages.push({
        role: 'user',
        content:
          'STRICT MINIMAL PATCH: Change only the lines required by the feedback. '
          + 'Do not rewrite styles.css. Typical fix is under 15 lines total across all files.'
      });
    }
    console.log('[creative-native] Corrective regen: patching existing index.html, styles.css, app.js.');
  }

  const genStart = Date.now();
  const codegenResult = await runCreativeCodegen({
    anthropicClient,
    model: activeModel,
    isRegen,
    repoRoot,
    skillsText,
    baseMessages: messages,
    adFormats,
    prunedStyleGuide,
    assetFiles
  });
  const durationMsTotal = Date.now() - genStart;

  mkdirSync(codeDirectoryPath, { recursive: true });
  for (const codeFile of codegenResult.files) {
    const filePath = join(codeDirectoryPath, codeFile.fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, codeFile.fileContent, { encoding: 'utf8' });
  }
  const { missing: missingBundleAssets } = syncBundleAssetsFromCodeFiles({
    bundleDir: codeDirectoryPath,
    codeFiles: codegenResult.files,
    assetFiles,
    runDirectoryPath: directoryPath
  });
  if (missingBundleAssets.length > 0) {
    console.warn(
      `[creative-native] ${String(missingBundleAssets.length)} referenced asset(s) could not be copied: ${missingBundleAssets.join(', ')}`
    );
  }

  const { path: genericConfigPath } = writeGenericAdConfigFile({
    bundleDir: codeDirectoryPath,
    outputRunDir: directoryPath
  });
  console.log(`[creative-native] Wrote ${genericConfigPath}`);

  const creativeUsageTotals = codegenResult.usage;
  const sumReportedTokens =
    creativeUsageTotals.input_tokens +
    creativeUsageTotals.output_tokens +
    creativeUsageTotals.cache_creation_input_tokens +
    creativeUsageTotals.cache_read_input_tokens;
  logAnthropicUsageAndCost(basename(import.meta.filename, extname(import.meta.filename)), creativeUsageTotals, activeModel);

  writeFileSync(
    join(directoryPath, 'creative-native-token-usage.json'),
    `${JSON.stringify({
      ...creativeUsageTotals,
      model: activeModel,
      total_tokens_reported_sum: sumReportedTokens,
      price_usd: priceUsdFromAccumulator(creativeUsageTotals, activeModel),
      duration_ms_total: durationMsTotal,
      turn_timings: codegenResult.timings
    }, null, 2)}\n`,
    { encoding: 'utf8' }
  );

  const regenRoundRaw = env['CREATIVE_REGEN_REVIEW_ROUND']?.trim();
  const regenRound = regenRoundRaw !== undefined && regenRoundRaw.length > 0 ? Number.parseInt(regenRoundRaw, 10) : null;
  const pipelineEntry = entryFromAccumulator({
    action: isRegen ? 'creative_regeneration' : 'creative_generation',
    agent: 'agents/gen-creative-code-native.mts',
    model: activeModel,
    acc: creativeUsageTotals,
    phase: 'creative',
    review_round: Number.isFinite(regenRound ?? Number.NaN) ? regenRound : null,
    duration_ms: durationMsTotal,
    api_call_timings: codegenTurnTimingsToApiCallTimings(codegenResult.timings)
  });
  const pipelineFile = appendPipelineUsage(directoryPath, pipelineEntry);
  logPipelineUsageToConsole(pipelineFile.entries[pipelineFile.entries.length - 1]!);
  logPhaseTotalsToConsole(recomputePhaseTotals(pipelineFile.entries));

  writeFileSync(
    join(directoryPath, 'creative-native-ad-formats.json'),
    `${JSON.stringify({ adFormats }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  console.log(`[creative-native] Phase format de pub (génération) : ${formatDurationMinSec(durationMsTotal)}`);
  console.log(`Output directory path: ${directoryPath}`);

  return { directoryPath, codeDirectoryPath, activeModel, isRegen, durationMsTotal };
}


// ============================================================
// MODULE: review
// ============================================================
// Auto-merged module: review. Sources: creative-native-assets-deterministic, asset-descriptions-audit, creative-bundle-integrity, creative-native-playwright-screenshots, creative-native-regen-deterministic, creative-native-regen-diff, creative-native-ui-review-regen.



















// ===== creative-native-assets-deterministic.mts =====
export type DeterministicFinding = {
  asset_id: string;
  severity: 'blocker' | 'warn';
  issue: string;
  fix_hint: string;
};

export type DeterministicAssetsCheckResult = {
  ok: boolean;
  findings: DeterministicFinding[];
};

const MIN_LOGO_W = () => parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_W', 1);
const MIN_LOGO_H = () => parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_H', 1);
const MIN_PRODUCT_W = () => parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_W', 1);
const MIN_PRODUCT_H = () => parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_H', 1);

export function getAssetMinDimensions (fileType: 'logos' | 'products'): {
  minW: number;
  minH: number;
} {
  if (fileType === 'logos') {
    return { minW: MIN_LOGO_W(), minH: MIN_LOGO_H() };
  }
  return { minW: MIN_PRODUCT_W(), minH: MIN_PRODUCT_H() };
}

export async function pruneOversizedAssets (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const maxBytes = MAX_FILE_BYTES();
  for (const fileType of [ 'logos', 'products' ] as const) {
    const subdirectoryPath = join(directoryPath, fileType);
    for (const fileName of listImageFiles(directoryPath, fileType)) {
      const filePath = join(subdirectoryPath, fileName);
      try {
        const sizeBytes = statSync(filePath).size;
        if (sizeBytes > maxBytes) {
          unlinkSync(filePath);
          removed.push(`${fileType}/${fileName}`);
          if (fileType === 'products') {
            removeProductAssetSource(directoryPath, fileName);
          }
          console.log(
            `[assets-prune] Removed oversized ${fileType}/${fileName} (${String(sizeBytes)} bytes, max ${String(maxBytes)})`
          );
        }
      } catch {
        /* keep for deterministic to flag */
      }
    }
  }
  return { removed };
}

export async function pruneUndersizedAssets (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const fileType of [ 'products' ] as const) {
    const { minW, minH } = getAssetMinDimensions(fileType);
    const subdirectoryPath = join(directoryPath, fileType);
    for (const fileName of listImageFiles(directoryPath, fileType)) {
      const filePath = join(subdirectoryPath, fileName);
      try {
        const { width, height } = await imageSizeFromFile(filePath);
        if (
          width !== undefined &&
          height !== undefined &&
          (width < minW || height < minH)
        ) {
          unlinkSync(filePath);
          removed.push(`${fileType}/${fileName}`);
          console.log(
            `[assets-prune] Removed undersized ${fileType}/${fileName} (${String(width)}×${String(height)}, min ${String(minW)}×${String(minH)})`
          );
        }
      } catch {
        /* corrupt files stay for deterministic to flag */
      }
    }
  }
  return { removed };
}

const MAX_FILE_BYTES = () => parseEnvInt('CREATIVE_ASSETS_MAX_FILE_BYTES', 5 * 1024 * 1024);

function listImageFiles (directoryPath: string, fileType: 'logos' | 'products'): string[] {
  return listAssetImageFiles(directoryPath, fileType);
}

async function checkImageFiles (
  fileType: 'products',
  directoryPath: string,
  minW: number,
  minH: number,
  productMatch?: {
    terms: readonly string[];
    listing: boolean;
    entertainment: boolean;
    experience: boolean;
    referenceListingUrls: readonly string[];
    officialHosts: readonly string[];
    relevanceFields?: Pick<ProductMatchFields, 'brandName' | 'companyName'>;
  }
): Promise<DeterministicFinding[]> {
  const findings: DeterministicFinding[] = [];
  const subdirectoryPath = join(directoryPath, fileType);
  const files = listImageFiles(directoryPath, fileType);

  if (files.length === 0) {
    findings.push({
      asset_id: fileType,
      severity: 'blocker',
      issue: `No files in ${fileType}/ directory.`,
      fix_hint: 'Run style guide generation or assets refresh to download at least one image.'
    });
    return findings;
  }

  for (const fileName of files) {
    const assetId = `${fileType}/${fileName}`;
    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);

    if (fileMimeType === null || !allowedImageMimeTypes.has(fileMimeType)) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Unsupported or unknown MIME type: ${fileMimeType ?? 'null'}.`,
        fix_hint: 'Replace with JPEG, PNG, WebP, or GIF.'
      });
      continue;
    }

    const ext = extname(fileName).toLowerCase();
    const expectedExt = fileMimeType === 'image/jpeg' ? '.jpg' : `.${fileMimeType.split('/')[1]}`;
    if (ext !== expectedExt && !(fileMimeType === 'image/jpeg' && ext === '.jpeg')) {
      findings.push({
        asset_id: assetId,
        severity: 'warn',
        issue: `Extension ${ext} may not match MIME ${fileMimeType}.`,
        fix_hint: 'Use a consistent file extension for the image type.'
      });
    }

    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > MAX_FILE_BYTES()) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `File size ${String(sizeBytes)} bytes exceeds max ${String(MAX_FILE_BYTES())}.`,
        fix_hint: 'Use a smaller image or raise CREATIVE_ASSETS_MAX_FILE_BYTES.'
      });
    }

    if (productMatch !== undefined && productMatch.terms.length > 0) {
      const sourceMap = loadProductAssetSources(directoryPath);
      const entry = sourceMap.get(fileName);
      const sourceUrl = entry?.sourceUrl ?? '';
      const minScore = productMinRelevanceScore();

      if (productMatch.entertainment) {
        if (
          !wouldPassEntertainmentProductAsset({
            entry,
            sourceUrl,
            referenceListingUrls: productMatch.referenceListingUrls,
            officialHosts: productMatch.officialHosts,
            terms: productMatch.terms,
            minScore,
            ...(entry?.sourceTitle !== undefined ? { sourceTitle: entry.sourceTitle } : {})
          })
        ) {
          findings.push({
            asset_id: assetId,
            severity: 'blocker',
            issue:
              'Product image is not from an official film/studio host or trusted cinema database (IMDb, Allociné).',
            fix_hint:
              'Use poster/key art from scarymovie.film, Paramount, IMDb, or Allociné — not fan merch or blogs.'
          });
          continue;
        }
      } else if (productMatch.experience) {
        if (
          !wouldPassExperienceProductAsset({
            entry,
            sourceUrl,
            referenceListingUrls: productMatch.referenceListingUrls,
            officialHosts: productMatch.officialHosts,
            terms: productMatch.terms,
            minScore,
            ...(entry?.sourceTitle !== undefined ? { sourceTitle: entry.sourceTitle } : {})
          })
        ) {
          findings.push({
            asset_id: assetId,
            severity: 'blocker',
            issue:
              'Product image is not from the official park/destination site or does not match campaign context.',
            fix_hint:
              'Use official attraction photos, lifestyle scenes, or ticket visuals from the brand domain.'
          });
          continue;
        }
      } else if (productMatch.listing) {
        if (
          !wouldPassListingProductAsset({
            entry,
            sourceUrl,
            referenceListingUrls: productMatch.referenceListingUrls,
            officialHosts: productMatch.officialHosts,
            terms: productMatch.terms,
            minScore,
            ...(productMatch.relevanceFields !== undefined
              ? { relevanceFields: productMatch.relevanceFields }
              : {})
          })
        ) {
          findings.push({
            asset_id: assetId,
            severity: 'blocker',
            issue:
              'Product image is not from the campaign reference page or an official brand visual host.',
            fix_hint:
              'Re-scrape the campaign reference URL or use official product/promo images from the brand domain.'
          });
          continue;
        }
      } else {
        if (sourceUrl.length > 0) {
          const termsForScore =
            productMatch.relevanceFields !== undefined
              ? filterRetailCampaignRelevanceTerms(
                  productMatch.terms,
                  productMatch.relevanceFields
                )
              : productMatch.terms;
          const relevance = scoreProductContextRelevance(
            `${sourceUrl} ${fileName}`,
            entry?.sourceTitle ?? '',
            termsForScore
          );
          if (relevance < minScore) {
            findings.push({
              asset_id: assetId,
              severity: 'blocker',
              issue: 'Product image source URL does not match the campaign context or productName.',
              fix_hint:
                'Refresh assets with Brave queries that name the exact hero product from STYLE_GUIDE_CONTEXT (not other models from the range).'
            });
            continue;
          }
        } else {
          findings.push({
            asset_id: assetId,
            severity: 'warn',
            issue: 'Product image has no recorded source URL; context match could not be verified.',
            fix_hint: 'Re-download assets so product-asset-sources.json records the image URL.'
          });
        }
      }
    }

    try {
      const { width, height } = await imageSizeFromFile(filePath);
      if (width === undefined || height === undefined) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: 'Could not read image dimensions.',
          fix_hint: 'Replace with a valid raster image file.'
        });
        continue;
      }
      if (width < minW || height < minH) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: `Dimensions ${String(width)}×${String(height)} below minimum ${String(minW)}×${String(minH)}.`,
          fix_hint: 'Download a higher-resolution asset via Brave refresh.'
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Failed to read image: ${msg}`,
        fix_hint: 'Replace the corrupt file.'
      });
    }
  }

  return findings;
}

function checkStyleGuideFields (styleGuide: StyleGuide): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];

  if (styleGuide.brandName.trim().length === 0) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'brandName is empty.',
      fix_hint: 'Regenerate the style guide with a valid brand name.'
    });
  }

  if (styleGuide.primaryColorPalette.length < 1) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'primaryColorPalette has no colors.',
      fix_hint: 'Regenerate the style guide with at least one primary hex color.'
    });
  }

  if (styleGuide.typography.length < 1) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'typography array is empty.',
      fix_hint: 'Regenerate the style guide with typography entries.'
    });
  }

  const hexPattern = /^#[0-9A-Fa-f]{6}$/;
  for (const hex of [
    ...styleGuide.primaryColorPalette,
    ...styleGuide.secondaryColorPalette
  ]) {
    if (!hexPattern.test(hex)) {
      findings.push({
        asset_id: 'style_guide',
        severity: 'blocker',
        issue: `Invalid hex color: ${hex}`,
        fix_hint: 'Use #RRGGBB format in the style guide.'
      });
    }
  }

  return findings;
}

/** Remove listing-mode product files that would fail deterministic review (legacy folders). */
export function pruneListingIneligibleProducts (
  directoryPath: string,
  styleGuide: StyleGuide
): string[] {
  const referenceListingUrls = resolveReferenceListingUrls({
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  if (referenceListingUrls.length === 0) {
    return [];
  }

  const listing = isListingPageCampaign({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  if (!listing) {
    return [];
  }

  const imageCtx = imageContextFromStyleGuide(styleGuide);
  const officialHosts = officialHostsFromContext(imageCtx);
  const terms = buildRetailCampaignRelevanceTerms({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    companyName: styleGuide.companyName
  });
  if (terms.length === 0) {
    return [];
  }

  const sourceMap = loadProductAssetSources(directoryPath);
  const removed: string[] = [];

  for (const fileName of listAssetImageFiles(directoryPath, 'products')) {
    const entry = sourceMap.get(fileName);
    const sourceUrl = entry?.sourceUrl ?? '';
    if (
      wouldPassListingProductAsset({
        entry,
        sourceUrl,
        referenceListingUrls,
        officialHosts,
        terms,
        relevanceFields: {
          brandName: styleGuide.brandName,
          companyName: styleGuide.companyName
        }
      })
    ) {
      continue;
    }
    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    removeProductAssetSource(directoryPath, fileName);
    removed.push(fileName);
  }

  if (removed.length > 0) {
    console.log(
      `[assets-deterministic] Pruned ${String(removed.length)} listing-ineligible product file(s): ${removed.join(', ')}`
    );
  }
  return removed;
}

export async function runDeterministicAssetsCheck (
  directoryPath: string,
  styleGuide: StyleGuide
): Promise<DeterministicAssetsCheckResult> {
  const styleGuidePath = join(directoryPath, 'style-guide.json');
  const findings: DeterministicFinding[] = [];

  if (!existsSync(styleGuidePath)) {
    return {
      ok: false,
      findings: [
        {
          asset_id: 'style_guide',
          severity: 'blocker',
          issue: 'Missing style-guide.json.',
          fix_hint: 'Run src/agents/gen-style-guide.mts first.'
        }
      ]
    };
  }

  try {
    JSON.parse(readFileSync(styleGuidePath, 'utf8'));
  } catch {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'style-guide.json is not valid JSON.',
      fix_hint: 'Fix or regenerate the style guide file.'
    });
  }

  findings.push(...checkStyleGuideFields(styleGuide));

  const imageCtx: ImageSearchContext = {
    brandName: styleGuide.brandName,
    companyName: styleGuide.companyName,
    productName: styleGuide.productName,
    brandURL: styleGuide.brandURL,
    companyURL: styleGuide.companyURL,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  };
  const officialHosts = officialHostsFromContext(imageCtx);

  const productMatchTerms = buildProductMatchTerms({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL
  });
  const referenceListingUrls = resolveReferenceListingUrls({
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  const listing = isListingPageCampaign({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  const profile = resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    campaignAssetProfile: styleGuide.campaignAssetProfile,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  }));
  findings.push(
    ...(await checkImageFiles(
      'products',
      directoryPath,
      MIN_PRODUCT_W(),
      MIN_PRODUCT_H(),
      productMatchTerms.length > 0
        ? {
            terms: productMatchTerms,
            listing,
            entertainment: profile === 'entertainment',
            experience: profile === 'experience',
            referenceListingUrls,
            officialHosts,
            relevanceFields: {
              brandName: styleGuide.brandName,
              companyName: styleGuide.companyName
            }
          }
        : undefined
    ))
  );

  const blockers = findings.filter((f) => f.severity === 'blocker');
  return {
    ok: blockers.length === 0,
    findings
  };
}

/** Remove product files flagged as blockers by deterministic pre-audit (before Brave retry). */
export function pruneDeterministicBlockedProducts (
  directoryPath: string,
  findings: readonly { severity: string; asset_id: string }[]
): { removed: string[]; excludedSourceUrls: string[] } {
  const removed: string[] = [];
  const excludedSourceUrls: string[] = [];
  const seenUrls = new Set<string>();
  const sourceMap = loadProductAssetSources(directoryPath);

  for (const f of findings) {
    if (f.severity !== 'blocker' || !f.asset_id.startsWith('products/')) {
      continue;
    }
    const fileName = f.asset_id.slice('products/'.length);
    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removed.push(f.asset_id);
    }
    const sourceUrl = sourceMap.get(fileName)?.sourceUrl?.trim() ?? '';
    if (sourceUrl.length > 0 && !seenUrls.has(sourceUrl)) {
      seenUrls.add(sourceUrl);
      excludedSourceUrls.push(sourceUrl);
    }
    removeProductAssetSource(directoryPath, fileName);
  }

  return { removed, excludedSourceUrls };
}

/** Remove logo files flagged as blockers by Haiku vision audit. */
export function pruneVisionBlockedLogos (
  directoryPath: string,
  findings: readonly { asset_id: string; severity: string }[],
  logoSourceUrls: readonly string[] = []
): { removed: string[]; excludedSourceUrls: string[] } {
  const removed: string[] = [];
  const excludedSourceUrls: string[] = [];
  const seenUrls = new Set<string>();
  const seenFiles = new Set<string>();

  for (const url of logoSourceUrls) {
    const trimmed = url.trim();
    if (trimmed.length > 0 && !seenUrls.has(trimmed)) {
      seenUrls.add(trimmed);
      excludedSourceUrls.push(trimmed);
    }
  }

  for (const f of findings) {
    if (f.severity !== 'blocker' || !f.asset_id.startsWith('logos/')) {
      continue;
    }
    const fileName = f.asset_id.slice('logos/'.length);
    if (fileName.length === 0 || fileName === 'logos' || seenFiles.has(fileName)) {
      continue;
    }
    seenFiles.add(fileName);

    const filePath = join(directoryPath, 'logos', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removeLogoAssetSource(directoryPath, fileName);
      removed.push(f.asset_id);
      console.log(`[assets-prune] Removed vision-blocked logo: ${f.asset_id}`);
    }
  }

  return { removed, excludedSourceUrls };
}

/** Remove product files flagged as blockers by vision or descriptions audit. */
export function pruneVisionBlockedProducts (
  directoryPath: string,
  findings: readonly { asset_id: string; severity: string }[]
): { removed: string[]; excludedSourceUrls: string[] } {
  const removed: string[] = [];
  const excludedSourceUrls: string[] = [];
  const seenUrls = new Set<string>();
  const sourceMap = loadProductAssetSources(directoryPath);
  const seenFiles = new Set<string>();

  for (const f of findings) {
    if (f.severity !== 'blocker' || !f.asset_id.startsWith('products/')) {
      continue;
    }
    const fileName = f.asset_id.slice('products/'.length);
    if (fileName.length === 0 || fileName === 'products' || seenFiles.has(fileName)) {
      continue;
    }
    seenFiles.add(fileName);

    const sourceUrl = sourceMap.get(fileName)?.sourceUrl?.trim() ?? '';
    if (sourceUrl.length > 0 && !seenUrls.has(sourceUrl)) {
      seenUrls.add(sourceUrl);
      excludedSourceUrls.push(sourceUrl);
    }

    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removed.push(f.asset_id);
      console.log(`[assets-prune] Removed vision-blocked product: ${f.asset_id}`);
    }
    removeProductAssetSource(directoryPath, fileName);
  }
  return { removed, excludedSourceUrls };
}

export function logDeterministicFindings (findings: DeterministicFinding[]): void {
  if (findings.length === 0) {
    console.log('[assets-deterministic] (no issues)');
    return;
  }
  console.log(`[assets-deterministic] findings (${String(findings.length)}):`);
  for (const f of findings) {
    console.log(`[assets-deterministic]   [${f.severity}] ${f.asset_id}: ${f.issue}`);
    console.log(`[assets-deterministic]     fix: ${f.fix_hint}`);
  }
}

// ===== asset-descriptions-audit.mts =====
const DEFAULT_ASSETS_REVIEW_MODEL = 'claude-haiku-4-5-20251001';

const TEXT_ONLY_LAYOUT_HINTS = new Set([
  'categorie-banner',
  'texte-lisible',
  'hero-promo',
  'call-to-action',
  'large-text',
  'segment-focus',
  'categorie-coffrets',
  'categorie-thes'
]);

export function minValidProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MIN_VALID_PRODUCTS', 3);
}

export function maxValidProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MAX_VALID_PRODUCTS', 5);
}

/** Cap append-mode product downloads so existing + new files stay within maxValid. */
export function productAppendRefreshTargetCount (
  existingCount: number,
  productMax: number = braveProductTargetCount(),
  maxValid: number = maxValidProductAssets()
): number {
  return Math.max(0, Math.min(productMax, maxValid - existingCount));
}

const EXCESS_PRODUCT_COUNT_ISSUE_RE = /^Too many product files in products\/ \(maximum \d+\); found \d+\.$/u;

/** True when every blocker is the deterministic excess product-file count rule. */
export function isExcessProductCountOnlyBlocker (
  findings: readonly { asset_id: string; severity: string; issue: string }[]
): boolean {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  return (
    blockers.length > 0 &&
    blockers.every(
      (f) => f.asset_id === 'products' && EXCESS_PRODUCT_COUNT_ISSUE_RE.test(f.issue)
    )
  );
}

/** Approve after post-round prune when only excess-count blockers remain and counts are valid. */
export function canReconcileAfterExcessProductPrune (options: {
  finalDeterministicOk: boolean;
  productFileCount: number;
  lastAuditFindings: readonly { asset_id: string; severity: string; issue: string }[];
}): boolean {
  const min = minValidProductAssets();
  const max = maxValidProductAssets();
  return (
    options.finalDeterministicOk &&
    options.productFileCount >= min &&
    options.productFileCount <= max &&
    isExcessProductCountOnlyBlocker(options.lastAuditFindings)
  );
}

export function minDistinctProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MIN_DISTINCT_PRODUCTS', 1);
}

export function requireDistinctWhenPhysicalCountGe (): number {
  return parseEnvInt('CREATIVE_ASSETS_REQUIRE_DISTINCT_WHEN_COUNT_GE', 2);
}

const VAGUE_PRODUCT_NAME_RE =
  /^(?:kusmi|the|thé|tea|produit|product|sélection|selection|collection|gamme|range|assortiment|various|divers)$/iu;

/** Normalize SKU label for deduplication (lowercase, no accents). */
export function normalizeProductName (name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}

function isIdentifiablePhysicalProduct (entry: AssetDescriptionEntry): boolean {
  return (
    entry.fileType === 'products' &&
    entry.shows_physical_product === true &&
    !isTextOnlyProductEntry(entry)
  );
}

function isConcreteProductName (name: string): boolean {
  const normalized = normalizeProductName(name);
  if (normalized.length < 2) {
    return false;
  }
  if (VAGUE_PRODUCT_NAME_RE.test(normalized)) {
    return false;
  }
  return true;
}

function distinctSkuKey (entry: AssetDescriptionEntry): string | null {
  if (!isIdentifiablePhysicalProduct(entry) || entry.is_generic_collection === true) {
    return null;
  }
  const name = entry.primary_product_name?.trim() ?? '';
  if (!isConcreteProductName(name)) {
    return null;
  }
  return normalizeProductName(name);
}

/** Product-name diversity checks on structured describe fields. */
export function auditDistinctProducts (
  descriptions: AssetDescriptionsFile,
  options?: { requireDistinctSkus?: boolean }
): DeterministicFinding[] {
  const requireDistinctSkus = options?.requireDistinctSkus ?? true;
  const findings: DeterministicFinding[] = [];
  const physical = descriptions.assets.filter((e) => isIdentifiablePhysicalProduct(e));
  if (physical.length === 0) {
    return findings;
  }

  const skuKeys = physical.map((e) => distinctSkuKey(e));
  const identifiable = skuKeys.filter((k): k is string => k !== null);
  const distinct = new Set(identifiable);
  const genericCount = physical.filter((e) => e.is_generic_collection === true).length;
  const minDistinct = minDistinctProductAssets();
  const requireDistinctThreshold = requireDistinctWhenPhysicalCountGe();

  const missingName = physical.filter((e) => {
    const key = distinctSkuKey(e);
    return key === null && e.is_generic_collection !== true;
  });

  for (const entry of missingName) {
    const name = entry.primary_product_name?.trim() ?? '';
    if (name.length === 0) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue: 'Physical product image has no primary_product_name — cannot verify distinct SKU.',
        fix_hint:
          'Re-describe or replace with a packshot/lifestyle image where the dominant product name is visible on packaging.'
      });
    } else if (!isConcreteProductName(name)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue: `primary_product_name "${name}" is too vague — need a concrete SKU/ritual/kit name.`,
        fix_hint: 'Use the exact product name printed on the pack (e.g. Sommeil, Kit Bubble Tea Litchi Rose).'
      });
    }
  }

  if (identifiable.length === 0 && genericCount < physical.length) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: 'No identifiable distinct product SKU among physical product images.',
      fix_hint:
        'Refresh with packshots where the product name is readable on the packaging, or distinct ritual/kit heroes.'
    });
  }

  if (identifiable.length > 0 && distinct.size < minDistinct) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minDistinct)} distinct product SKU(s); found ${String(distinct.size)}.`,
      fix_hint: 'Add assets showing different named products from the brand range.'
    });
  }

  if (
    requireDistinctSkus &&
    physical.length >= requireDistinctThreshold &&
    identifiable.length >= requireDistinctThreshold &&
    distinct.size === 1
  ) {
    const onlySku = [ ...distinct ][0] ?? '';
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `${String(physical.length)} physical product image(s) all depict the same SKU ("${onlySku}") — need distinct products for ad variety.`,
      fix_hint:
        'Refresh with Brave queries naming different SKUs from the range (not repeated packshots of the same product).'
    });
  }

  if (genericCount > 0 && genericCount >= Math.ceil(physical.length / 2) && distinct.size < minDistinct) {
    findings.push({
      asset_id: 'products',
      severity: 'warn',
      issue: 'Majority of physical product images are generic multi-SKU collections without a dominant named product.',
      fix_hint: 'Prefer packshots or lifestyle scenes with one clear hero SKU per image.'
    });
  }

  return findings;
}

function isTextOnlyProductEntry (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products') {
    return false;
  }
  if (entry.asset_kind === 'text_only_banner') {
    return true;
  }
  if (entry.asset_kind !== undefined && USABLE_PROMO_ASSET_KINDS.has(entry.asset_kind)) {
    return false;
  }
  const hints = entry.layout_hints.map((h) => h.toLowerCase());
  const hasTextNavHint = hints.some((h) => TEXT_ONLY_LAYOUT_HINTS.has(h));
  const hasPackshotHint = hints.some((h) =>
    /packshot|lifestyle|product-showcase|product-packshot|mise-en-scene|hero-image|ride-action|roller-coaster|park-setting|family-moment/iu.test(
      h
    )
  );
  if (hasPackshotHint) {
    return false;
  }
  if (hasTextNavHint && entry.shows_physical_product !== true) {
    return true;
  }
  const desc = entry.description.toLowerCase();
  if (
    /banni[eè]re promotionnelle|tuile (de )?cat[eé]gorie|navigation menu|texte seul|uniquement du texte/iu.test(
      desc
    ) &&
    entry.shows_physical_product !== true &&
    !/attraction|roller coaster|parc|man[eè]ge|ride|visiteur|famille|lifestyle/iu.test(desc)
  ) {
    return true;
  }
  return false;
}

/** Count product assets suitable as ad heroes (packshots, lifestyle, promo — not text-only tiles). */
export function countUsableProductAssets (descriptions: AssetDescriptionsFile): number {
  return descriptions.assets.filter(
    (e) => e.fileType === 'products' && !isTextOnlyProductEntry(e)
  ).length;
}

const BTS_LAYOUT_HINTS = /production-still|behind-the-scenes|clapperboard|on-set|bts/iu;

function isEntertainmentPromoVisual (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products') {
    return false;
  }
  if (entry.asset_kind !== undefined && ENTERTAINMENT_PROMO_ASSET_KINDS.has(entry.asset_kind)) {
    return true;
  }
  if (entry.asset_kind === 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.join(' ').toLowerCase();
  if (/theatrical-poster|key-art|film-poster|character-close-up|ensemble-cast|cast-photo/iu.test(hints)) {
    return true;
  }
  const desc = entry.description.toLowerCase();
  if (/affiche|poster|key art|film still|cast promo|title treatment/iu.test(desc)) {
    return true;
  }
  return false;
}

function isEntertainmentTextOnlyNavTile (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products' || entry.asset_kind !== 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.map((h) => h.toLowerCase());
  const hasNavHint = hints.some((h) => TEXT_ONLY_LAYOUT_HINTS.has(h));
  const desc = entry.description.toLowerCase();
  const navDesc =
    /banni[eè]re promotionnelle|tuile (de )?cat[eé]gorie|navigation menu|texte seul|uniquement du texte/iu.test(
      desc
    );
  const hasFilmImagery = /affiche|poster|film|cast|personnage|character/iu.test(desc);
  return (hasNavHint || navDesc) && !hasFilmImagery;
}

function campaignTermMatchesEntry (
  entry: AssetDescriptionEntry,
  campaignTerms: readonly string[]
): boolean {
  const hay = normalizeProductName(
    `${entry.primary_product_name ?? ''} ${entry.description} ${entry.fileName}`
  );
  return campaignTerms.some((term) => {
    const t = normalizeProductName(term);
    if (t.length < 3) {
      return false;
    }
    if (/\d{3,}/u.test(t)) {
      return hay.includes(t);
    }
    return t.length >= 3 && hay.includes(t);
  });
}

function isUsableRetailProductEntry (entry: AssetDescriptionEntry): boolean {
  return entry.fileType === 'products' && !isTextOnlyProductEntry(entry);
}

/** Count product assets that match campaign subject terms. */
export function countRelevantRetailProductAssets (
  descriptions: AssetDescriptionsFile,
  campaignTerms: readonly string[]
): number {
  if (campaignTerms.length === 0) {
    return countUsableProductAssets(descriptions);
  }
  return descriptions.assets.filter(
    (e) => isUsableRetailProductEntry(e) && campaignTermMatchesEntry(e, campaignTerms)
  ).length;
}

function scoreProductForPrune (
  fileName: string,
  entry: AssetDescriptionEntry | undefined,
  campaignTerms: readonly string[],
  sourceUrl: string
): number {
  if (entry !== undefined) {
    if (campaignTerms.length > 0 && !campaignTermMatchesEntry(entry, campaignTerms)) {
      return 0;
    }
    if (entry.is_generic_collection === true) {
      return 1;
    }
    return 2;
  }
  if (campaignTerms.length > 0) {
    const hay = normalizeProductName(`${fileName} ${sourceUrl}`);
    const matches = campaignTerms.some((term) => {
      const t = normalizeProductName(term);
      return t.length >= 3 && hay.includes(t);
    });
    if (!matches) {
      return 0;
    }
  }
  return 1;
}

/** Remove lowest-priority product files when products/ exceeds max (off-topic first, then generic). */
export function pruneExcessProductAssets (
  directoryPath: string,
  options?: {
    max?: number;
    campaignTerms?: readonly string[];
    descriptions?: AssetDescriptionsFile | null;
  }
): { removed: string[] } {
  const max = options?.max ?? maxValidProductAssets();
  const files = listAssetImageFiles(directoryPath, 'products');
  if (files.length <= max) {
    return { removed: [] };
  }

  const descriptions = options?.descriptions ?? loadAssetDescriptions(directoryPath);
  const descByFile = new Map<string, AssetDescriptionEntry>();
  if (descriptions !== null) {
    for (const entry of descriptions.assets) {
      if (entry.fileType === 'products') {
        descByFile.set(entry.fileName, entry);
      }
    }
  }

  const sourceMap = loadProductAssetSources(directoryPath);
  const campaignTerms = options?.campaignTerms ?? [];
  const ranked = files.map((fileName) => ({
    fileName,
    score: scoreProductForPrune(
      fileName,
      descByFile.get(fileName),
      campaignTerms,
      sourceMap.get(fileName)?.sourceUrl?.trim() ?? ''
    )
  }));
  ranked.sort((a, b) => a.score - b.score);

  const removed: string[] = [];
  let remaining = files.length;
  for (const { fileName } of ranked) {
    if (remaining <= max) {
      break;
    }
    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removeProductAssetSource(directoryPath, fileName);
      removed.push(`products/${fileName}`);
      remaining -= 1;
      console.log(`[assets-prune] Removed excess product: products/${fileName}`);
    }
  }

  return { removed };
}

/** Entertainment audit — subject relevance, not retail SKU/physical product rules. */
export function deterministicFindingsFromEntertainmentDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  campaignTerms: readonly string[]
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const productEntries = descriptions.assets.filter((e) => e.fileType === 'products');

  for (const entry of productEntries) {
    if (isEntertainmentTextOnlyNavTile(entry)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue:
          'Image is a text-only navigation/category tile with no film promotional imagery — not a usable promotional visual.',
        fix_hint:
          'Replace with official theatrical poster, key art, or cast promotional photo from IMDb/Allociné/official site.'
      });
    }
  }

  const promoVisuals = productEntries.filter(
    (e) => !isEntertainmentTextOnlyNavTile(e) && isEntertainmentPromoVisual(e)
  );
  const relevantPromo = promoVisuals.filter((e) => campaignTermMatchesEntry(e, campaignTerms));

  if (productFileCount > 0 && relevantPromo.length === 0 && promoVisuals.length === 0) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue:
        'No usable film promotional visual (poster, key art, or still) matching the campaign title.',
      fix_hint:
        'Refresh with Brave queries: site:imdb.com, site:allocine.fr, site:impawards.com + film title + poster/key art.'
    });
  }

  const btsOnly =
    productEntries.length > 0 &&
    promoVisuals.length > 0 &&
    promoVisuals.every((e) => {
      const hints = e.layout_hints.join(' ');
      const desc = e.description;
      return BTS_LAYOUT_HINTS.test(hints) || BTS_LAYOUT_HINTS.test(desc);
    }) &&
    !productEntries.some((e) => e.asset_kind === 'theatrical_poster' || e.asset_kind === 'key_art');

  if (btsOnly) {
    findings.push({
      asset_id: 'products',
      severity: 'warn',
      issue:
        'Portfolio contains only behind-the-scenes/production stills — consider adding an official theatrical poster or key art.',
      fix_hint:
        'Add site:impawards.com or site:allocine.fr queries for official theatrical poster.'
    });
  }

  return findings;
}

function isExperiencePromoVisual (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products') {
    return false;
  }
  if (entry.asset_kind !== undefined && EXPERIENCE_PROMO_ASSET_KINDS.has(entry.asset_kind)) {
    return true;
  }
  if (entry.asset_kind === 'mascot_brand') {
    return true;
  }
  if (entry.asset_kind === 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.join(' ').toLowerCase();
  if (
    /attraction|roller-coaster|ride-action|park-setting|family-moment|ticket-pass|venue-lifestyle|mascot/iu.test(
      hints
    )
  ) {
    return true;
  }
  const desc = entry.description.toLowerCase();
  if (/attraction|man[eè]ge|roller coaster|parc|famille|visiteur|billetterie|pass|ticket/iu.test(desc)) {
    return true;
  }
  return false;
}

function isExperienceTextOnlyNavTile (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products' || entry.asset_kind !== 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.map((h) => h.toLowerCase());
  const hasNavHint = hints.some((h) => TEXT_ONLY_LAYOUT_HINTS.has(h));
  const desc = entry.description.toLowerCase();
  const navDesc =
    /banni[eè]re promotionnelle|tuile (de )?cat[eé]gorie|navigation menu|texte seul|uniquement du texte/iu.test(
      desc
    );
  const hasParkImagery = /attraction|parc|man[eè]ge|famille|ride|roller coaster/iu.test(desc);
  return (hasNavHint || navDesc) && !hasParkImagery;
}

/** Experience audit — attractions, lifestyle, ticketing — not retail SKU rules. */
export function deterministicFindingsFromExperienceDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  campaignTerms: readonly string[]
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const minValid = minValidProductAssets();
  const productEntries = descriptions.assets.filter((e) => e.fileType === 'products');

  for (const entry of productEntries) {
    if (isExperienceTextOnlyNavTile(entry)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue:
          'Image is a text-only navigation/category tile with no park or attraction imagery — not a usable promotional visual.',
        fix_hint:
          'Replace with official attraction photo, family lifestyle scene, or ticket/pass visual from the brand site.'
      });
    }
    if (entry.asset_kind === 'mascot_brand') {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'warn',
        issue: 'Mascot render is suitable as secondary accent — prefer attraction or lifestyle heroes as primary assets.',
        fix_hint: 'Keep mascot for corner/badge use; ensure at least 2 attraction or lifestyle heroes exist.'
      });
    }
  }

  const promoVisuals = productEntries.filter(
    (e) => !isExperienceTextOnlyNavTile(e) && isExperiencePromoVisual(e)
  );
  const usableCount = promoVisuals.length;
  const relevantPromo = promoVisuals.filter((e) => campaignTermMatchesEntry(e, campaignTerms));

  if (productFileCount > 0 && usableCount < minValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minValid)} usable experience visual(s) (attraction, lifestyle, ticket); found ${String(usableCount)}.`,
      fix_hint:
        'Refresh with Brave queries naming attractions, summer campaign, or family park photos from the official site.'
    });
  } else if (
    productFileCount > 0 &&
    relevantPromo.length === 0 &&
    promoVisuals.length === 0 &&
    usableCount === 0
  ) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: 'No usable experience promotional visual matching the campaign context.',
      fix_hint:
        'Refresh with site:brand + attraction names, summer campaign, family lifestyle from official pages.'
    });
  }

  return findings;
}

/** Retail audit — packshot rules plus per-asset campaign subject relevance (3–5 products). */
export function deterministicFindingsFromRetailDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  campaignTerms: readonly string[],
  options?: { requireDistinctSkus?: boolean }
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const minValid = minValidProductAssets();
  const maxValid = maxValidProductAssets();
  const usableCount = countUsableProductAssets(descriptions);
  const relevantCount = countRelevantRetailProductAssets(descriptions, campaignTerms);

  for (const entry of descriptions.assets) {
    if (entry.fileType !== 'products') {
      continue;
    }
    if (isTextOnlyProductEntry(entry)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: usableCount >= minValid ? 'warn' : 'blocker',
        issue:
          'Product image is a text-only category/promo banner (no photographed product) — not usable as ad hero.',
        fix_hint:
          'Replace with official packshots or lifestyle scenes showing physical products (site:brand packshot).'
      });
      continue;
    }
    if (campaignTerms.length > 0 && !campaignTermMatchesEntry(entry, campaignTerms)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue:
          'Product image is off-topic — description and primary_product_name do not match the campaign subject.',
        fix_hint:
          'Remove and replace with on-campaign packshots or lifestyle scenes from the official reference page.'
      });
    }
  }

  const physicalCount = descriptions.assets.filter(
    (e) => e.fileType === 'products' && e.shows_physical_product === true
  ).length;

  if (productFileCount > maxValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Too many product files in products/ (maximum ${String(maxValid)}); found ${String(productFileCount)}.`,
      fix_hint: 'Prune off-topic or excess assets so only 3–5 on-campaign product images remain.'
    });
  }

  if (productFileCount > 0 && relevantCount < minValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minValid)} on-campaign product image(s); found ${String(relevantCount)} matching campaign terms (${String(usableCount)} usable, ${String(physicalCount)} with visible physical product).`,
      fix_hint:
        'Refresh products with Brave queries naming concrete on-campaign SKUs from the official site.'
    });
  } else if (productFileCount > 0 && usableCount < minValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minValid)} usable product image(s) (packshot/lifestyle/promo); found ${String(usableCount)} (${String(physicalCount)} with visible physical product).`,
      fix_hint:
        'Refresh products with Brave queries naming concrete SKUs, attractions, or lifestyle scenes from the official site.'
    });
  }

  findings.push(
    ...auditDistinctProducts(descriptions, {
      requireDistinctSkus: options?.requireDistinctSkus ?? true
    })
  );

  return findings;
}

/** Programmatic audit on structured describe fields — robust against euphemistic prose. */
export function deterministicFindingsFromAssetDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  options?: {
    profile?: CampaignAssetProfile;
    campaignTerms?: readonly string[];
    requireDistinctSkus?: boolean;
  }
): DeterministicFinding[] {
  const profile = options?.profile ?? 'retail';
  const campaignTerms = options?.campaignTerms ?? [];

  if (profile === 'entertainment') {
    return deterministicFindingsFromEntertainmentDescriptions(
      descriptions,
      productFileCount,
      campaignTerms
    );
  }
  if (profile === 'experience') {
    return deterministicFindingsFromExperienceDescriptions(
      descriptions,
      productFileCount,
      campaignTerms
    );
  }

  const retailOptions =
    options?.requireDistinctSkus !== undefined
      ? { requireDistinctSkus: options.requireDistinctSkus }
      : undefined;
  return deterministicFindingsFromRetailDescriptions(
    descriptions,
    productFileCount,
    campaignTerms,
    retailOptions
  );
}

function deterministicToReviewFindings (
  findings: DeterministicFinding[]
): AssetsReviewOutput['findings'] {
  return findings.map((f) => ({
    asset_id: f.asset_id,
    severity: f.severity,
    issue: f.issue,
    fix_hint: f.fix_hint
  }));
}

function sanitizeLlmFindings (
  findings: AssetsReviewOutput['findings'],
  profile: CampaignAssetProfile = 'retail'
): AssetsReviewOutput['findings'] {
  let filtered = findings.filter((f) => !(f.asset_id.startsWith('logos/') && f.severity === 'blocker'));
  if (profile === 'entertainment' || profile === 'experience') {
    filtered = filtered.filter((f) => {
      if (f.severity !== 'blocker') {
        return true;
      }
      const issue = f.issue.toLowerCase();
      if (
        /physical product|packshot|same sku|distinct product|ad hero|shows_physical_product|sku variety|merchandise display|identical primary_product_name|concrete sku|product-focused ad|product display standard/iu.test(
          issue
        )
      ) {
        return false;
      }
      return true;
    });
  }
  return filtered;
}

function mergeAudits (
  deterministic: DeterministicFinding[],
  llm: AssetsReviewOutput | null,
  profile: CampaignAssetProfile = 'retail'
): AssetsReviewOutput {
  const detReview = deterministicToReviewFindings(deterministic);
  const llmFindings = sanitizeLlmFindings(llm?.findings ?? [], profile);
  const seen = new Set<string>();
  const merged: AssetsReviewOutput['findings'] = [];

  for (const f of [ ...detReview, ...llmFindings ]) {
    const key = `${f.asset_id}::${f.issue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(f);
  }

  const blockers = merged.filter((f) => f.severity === 'blocker');
  const satisfied = blockers.length === 0;
  const summary =
    llm?.summary ??
    (satisfied
      ? 'Asset descriptions audit passed (deterministic).'
      : `Asset descriptions audit failed: ${String(blockers.length)} blocker(s).`);

  return {
    satisfied,
    summary,
    findings: merged,
    brave_retry_queries: llm?.brave_retry_queries ?? { logos: [], products: [] }
  };
}

export type RunAssetDescriptionsAuditOptions = {
  anthropicClient: Anthropic;
  directoryPath: string;
  descriptions: AssetDescriptionsFile;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  reviewRound: number;
  productFileCount: number;
  model?: string;
};

export async function runAssetDescriptionsAudit (
  options: RunAssetDescriptionsAuditOptions
): Promise<{ audit: AssetsReviewOutput; usage: AssetsReviewUsageTotals }> {
  const { directoryPath, descriptions, prunedStyleGuide, reviewRound, productFileCount } = options;
  const reviewDir = join(directoryPath, 'review');
  const model =
    options.model ?? process.env['CREATIVE_ASSETS_REVIEW_MODEL']?.trim() ?? DEFAULT_ASSETS_REVIEW_MODEL;

  const profile = resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: prunedStyleGuide.campaignContext ?? null,
    productName: prunedStyleGuide.productName,
    brandName: prunedStyleGuide.brandName,
    brandContext: prunedStyleGuide.brandContext,
    brandURL: prunedStyleGuide.brandURL,
    campaignAssetProfile: prunedStyleGuide.campaignAssetProfile
  }));
  console.log(`[asset-descriptions-audit] Campaign asset profile: ${profile}`);

  const matchFields: ProductMatchFields = {
    campaignContext: prunedStyleGuide.campaignContext ?? null,
    productName: prunedStyleGuide.productName,
    brandName: prunedStyleGuide.brandName,
    brandContext: prunedStyleGuide.brandContext,
    brandURL: prunedStyleGuide.brandURL,
    ...(prunedStyleGuide.campaignReferenceUrl !== undefined &&
    prunedStyleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: prunedStyleGuide.campaignReferenceUrl }
      : {})
  };
  const listingCampaign = isListingPageCampaign(matchFields);
  const heroProductCampaign = isHeroProductCampaign(matchFields);
  if (profile === 'retail') {
    console.log(
      `[asset-descriptions-audit] Retail product mode: ${listingCampaign ? 'listing (distinct SKUs)' : heroProductCampaign ? 'hero (same product, visual variety)' : 'standard'}`
    );
  }
  const campaignTerms =
    profile === 'retail'
      ? buildRetailCampaignRelevanceTerms(matchFields)
      : buildProductMatchTerms(matchFields);

  const deterministic = deterministicFindingsFromAssetDescriptions(descriptions, productFileCount, {
    profile,
    campaignTerms,
    requireDistinctSkus: profile === 'retail' ? listingCampaign : false
  });
  if (deterministic.length > 0) {
    console.log(
      `[asset-descriptions-audit] Deterministic pre-check: ${String(deterministic.length)} finding(s)`
    );
    for (const f of deterministic) {
      console.log(`[asset-descriptions-audit]   [${f.severity}] ${f.asset_id}: ${f.issue}`);
    }
  }

  const minValid = minValidProductAssets();
  const maxValid = maxValidProductAssets();

  const retailSkuRules = listingCampaign
    ? [
        '- Listing/catalog campaign: require distinct primary_product_name values across physical product assets (different SKUs from the range).',
        '- BLOCKER when 2+ physical product assets share the exact same primary_product_name (same SKU repeated). Different flavor/variant names (e.g. Litchi vs Pêche kits) are distinct — do not treat as duplicates.',
        '- BLOCKER when no distinct identifiable product names exist among physical product assets.',
        '- Never accept off-range SKUs from the same retailer (e.g. FIFA or Star Wars on a Pokémon campaign).'
      ]
    : heroProductCampaign
      ? [
          '- Hero product campaign: ACCEPT multiple assets sharing the same primary_product_name (same model/product) — lifestyle, exterior, interior, and promo angles are desired visual variety.',
          '- Do NOT require distinct SKUs or different product names when all assets depict the campaign hero product from productName.',
          '- BLOCKER only when an asset clearly depicts a different model/line than productName or campaignContext.'
        ]
      : [
          '- BLOCKER when 2+ physical product assets share the exact same primary_product_name without clear visual variety in asset_kind or layout.',
          '- BLOCKER when no distinct identifiable product names exist among physical product assets when a range is implied.'
        ];

  const retailSystemPrompt = [
    'You audit pre-generated asset descriptions (JSON) before HTML5 ad code generation.',
    'You receive NO images — only structured descriptions with shows_physical_product, asset_kind, primary_product_name, is_generic_collection.',
    'Evaluate product relevance for the campaign in the style guide.',
    'Rules:',
    '- BLOCKER for products/ where asset_kind is text_only_banner or the description is a category navigation tile.',
    `- BLOCKER when fewer than ${String(minValid)} or more than ${String(maxValid)} on-campaign product assets exist in products/.`,
    '- BLOCKER when any products/ asset is clearly off-topic (wrong franchise, sport, unrelated brand line) vs brandName, productName, campaignContext, or brandContext.',
    '- BLOCKER when primary_product_name is missing, vague, or inconsistent with the description for physical products.',
    ...retailSkuRules,
    '- Accept is_generic_collection=true only if at least one other asset has a concrete primary_product_name.',
    '- Trust deterministic subject-relevance pre-checks — do not downgrade off-topic assets to warnings.',
    '- WARN only for minor logo padding issues (logos are validated by a separate Haiku vision audit).',
    '- Accept packshots, lifestyle scenes with visible merchandise, and product group shots when on-campaign.',
    `Set satisfied to true when ${String(minValid)}–${String(maxValid)} on-campaign retail product assets exist and zero blockers.`,
    listingCampaign
      ? 'For blockers, suggest Brave product queries naming different on-campaign SKUs from the range.'
      : 'For blockers, suggest Brave product queries naming the hero product with varied scene types (exterior, lifestyle, packshot) — not different unrelated SKUs.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Asset descriptions JSON ---',
    JSON.stringify(descriptions)
  ].join('\n');

  const entertainmentSystemPrompt = [
    'You audit pre-generated asset descriptions (JSON) for a film/series entertainment campaign before HTML5 ad code generation.',
    'You receive NO images — only structured descriptions with shows_physical_product, asset_kind, primary_product_name.',
    'Evaluate promotional visual relevance for the film in the style guide — NOT retail packshot rules.',
    'Rules:',
    '- ACCEPT theatrical_poster, key_art, film_still, promotional_photo with shows_physical_product=false — this is normal for film campaigns.',
    '- ACCEPT multiple assets sharing the same primary_product_name (film title) — duplicate film titles are NOT a blocker.',
    '- Do NOT require distinct SKUs, physical merchandise, or packshot variety.',
    '- BLOCKER only for text_only_banner category navigation tiles with no film imagery.',
    '- BLOCKER when assets clearly depict the wrong film installment/franchise opus (e.g. Scary Movie 4 when campaign is Scary Movie 6 / 2026).',
    '- BLOCKER when no asset is a usable promotional visual for the campaign film (no poster, key art, or relevant still).',
    '- WARN (not blocker) when portfolio is only BTS/clapperboard with no poster — suggest poster retry queries.',
    '- WARN only for minor logo issues (logos validated separately by vision audit).',
    'Set satisfied to true when at least one promotional visual matches the campaign and zero blockers exist.',
    'For blockers, suggest Brave queries: site:imdb.com, site:allocine.fr, site:impawards.com + film title + poster/key art.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Asset descriptions JSON ---',
    JSON.stringify(descriptions)
  ].join('\n');

  const experienceSystemPrompt = [
    'You audit pre-generated asset descriptions (JSON) for a theme park / leisure / destination experience campaign before HTML5 ad code generation.',
    'You receive NO images — only structured descriptions with shows_physical_product, asset_kind, primary_product_name.',
    'Evaluate promotional visual relevance for the campaign in the style guide — NOT retail packshot or SKU rules.',
    'Rules:',
    '- ACCEPT attraction_photo, venue_lifestyle, lifestyle_scene, ticket_pass, promotional_photo with shows_physical_product=false — normal for parks and destinations.',
    '- ACCEPT ticket_pass and gift cards with shows_physical_product=true.',
    '- ACCEPT generic primary_product_name (Visite Famille, campaign season name, attraction name).',
    '- Do NOT require distinct SKUs, retail packshots, or physical merchandise variety.',
    '- WARN (not blocker) for mascot_brand assets — secondary accent only.',
    '- BLOCKER only for text_only_banner category navigation tiles with no park/attraction imagery.',
    '- BLOCKER when fewer than 2 usable experience visuals exist (attraction, lifestyle, ticket).',
    '- BLOCKER when assets clearly unrelated to the campaign park/destination in the style guide.',
    '- WARN only for minor logo issues (logos validated separately by vision audit).',
    'Set satisfied to true when at least 2 relevant experience visuals exist and zero blockers.',
    'For blockers, suggest Brave queries: site:{brandURL-host} + attraction names + summer campaign + family park.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Asset descriptions JSON ---',
    JSON.stringify(descriptions)
  ].join('\n');

  const systemPrompt =
    profile === 'entertainment'
      ? entertainmentSystemPrompt
      : profile === 'experience'
        ? experienceSystemPrompt
        : retailSystemPrompt;

  const retailUserContent =
    `Audit round ${String(reviewRound)}. Review the asset descriptions JSON for retail ad suitability. ` +
    'Reject text-only category banners and any off-topic product even if from the official retailer CDN. ' +
    `Pass only when ${String(minValid)}–${String(maxValid)} products/ assets each match the campaign subject. ` +
    (listingCampaign
      ? 'Listing campaign: require distinct SKUs — identical primary_product_name across 2+ assets is a duplicate blocker.'
      : heroProductCampaign
        ? 'Hero product campaign: same primary_product_name on all assets is OK — require visual variety (angles, lifestyle, packshot), not different SKUs. Do not invent duplicate-SKU blockers.'
        : 'Require on-campaign relevance; duplicate primary_product_name is a blocker only when assets lack visual variety.');

  const entertainmentUserContent =
    `Audit round ${String(reviewRound)}. Review asset descriptions for film promotional suitability. ` +
    'Do NOT apply retail packshot or distinct-SKU rules. ' +
    'Accept posters, key art, and film stills even when shows_physical_product=false. ' +
    'Same film title on all assets is OK. ' +
    'Block only wrong franchise opus, text-only nav tiles, or assets unrelated to the campaign film. ' +
    'Trust deterministic pre-checks — do not invent duplicate-SKU or physical-product blockers.';

  const experienceUserContent =
    `Audit round ${String(reviewRound)}. Review asset descriptions for theme park / destination campaign suitability. ` +
    'Do NOT apply retail packshot, SKU, or shows_physical_product rules for attraction/lifestyle photos. ' +
    'Accept roller coasters, family scenes, passes, and generic visit labels. ' +
    'Block only text-only nav tiles or assets unrelated to the campaign. ' +
    'Trust deterministic pre-checks — do not invent retail-product blockers.';

  const userContent =
    profile === 'entertainment'
      ? entertainmentUserContent
      : profile === 'experience'
        ? experienceUserContent
        : retailUserContent;

  console.log(`[asset-descriptions-audit] Round ${String(reviewRound)} — model ${model} (text-only)`);

  const roundStart = Date.now();
  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    `asset-descriptions-audit round ${String(reviewRound)}`,
    async () =>
      await withAnthropicRetry(`asset-descriptions-audit round ${String(reviewRound)}`, async () => {
        return await options.anthropicClient.messages.parse({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: userContent
            }
          ],
          output_config: {
            format: zodOutputFormat(assetsReviewOutputSchema)
          }
        });
      })
  );
  const stepDurationMs = Date.now() - roundStart;

  const llmParsed = msg.parsed_output;
  if (llmParsed === null) {
    throw new Error('Asset descriptions audit returned no structured output.');
  }

  const audit = mergeAudits(deterministic, llmParsed, profile);
  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0) {
    audit.satisfied = false;
  }

  const billedInput =
    msg.usage.input_tokens +
    (msg.usage.cache_creation_input_tokens ?? 0) +
    (msg.usage.cache_read_input_tokens ?? 0);
  const price_usd: PriceUsd = priceUsdFromTokens(billedInput, msg.usage.output_tokens, model);

  const usage: AssetsReviewUsageTotals = {
    api_calls: 1,
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    model,
    billed_input_tokens: billedInput,
    price_usd,
    duration_ms: stepDurationMs
  };

  console.log(
    `[asset-descriptions-audit] satisfied=${String(audit.satisfied)} blockers=${String(blockers.length)}`
  );
  logAssetsReviewAuditToConsole(audit, reviewRound);
  appendAssetsReviewLog(reviewDir, audit, reviewRound);

  const pipelineEntry = entryFromSingleUsage({
    action: 'assets_review',
    agent: 'lib/asset-descriptions-audit.mts',
    model,
    usage: msg.usage,
    review_round: reviewRound,
    duration_ms: stepDurationMs,
    api_call_timings: [
      {
        call_index: 1,
        duration_ms: apiDurationMs,
        stop_reason: msg.stop_reason,
        label: `asset-descriptions-audit round ${String(reviewRound)}`
      }
    ]
  });
  logPipelineUsageToConsole(appendPipelineUsage(directoryPath, pipelineEntry).entries.at(-1)!);

  return { audit, usage };
}

export function useDescriptionsBasedAssetsReview (): boolean {
  const mode = process.env['CREATIVE_ASSETS_REVIEW_MODE']?.trim().toLowerCase();
  return mode !== 'vision';
}

export type DescriptionsBasedReviewResult = {
  audit: AssetsReviewOutput;
  descriptions: AssetDescriptionsFile | null;
  describeUsage: DescribeApprovedAssetsResult['usage'] | null;
  auditUsage: AssetsReviewUsageTotals;
  logoVisionUsage: AssetsReviewUsageTotals | null;
};

/** Vision describe + deterministic pre-check + text-only Haiku audit (no second image pass). */
export async function runDescriptionsBasedAssetsReview (options: {
  anthropicClient: Anthropic;
  directoryPath: string;
  styleGuide: StyleGuide;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  reviewRound: number;
  productFileCount: number;
  phase?: 'style_guide' | 'creative';
}): Promise<DescriptionsBasedReviewResult> {
  const describeResult = await describeAssetsForReview({
    anthropicClient: options.anthropicClient,
    directoryPath: options.directoryPath,
    styleGuide: options.styleGuide,
    reviewRound: options.reviewRound,
    phase: options.phase ?? 'style_guide'
  });

  if (describeResult === null) {
    throw new Error('Asset describe step returned null — cannot run descriptions audit.');
  }

  const { audit, usage: auditUsage } = await runAssetDescriptionsAudit({
    anthropicClient: options.anthropicClient,
    directoryPath: options.directoryPath,
    descriptions: describeResult.file,
    prunedStyleGuide: options.prunedStyleGuide,
    reviewRound: options.reviewRound,
    productFileCount: options.productFileCount
  });

  const { audit: logoVisionAudit, usage: logoVisionUsage } = await runLogoVisionAudit({
    anthropicClient: options.anthropicClient,
    directoryPath: options.directoryPath,
    prunedStyleGuide: options.prunedStyleGuide,
    reviewRound: options.reviewRound,
    phase: options.phase ?? 'style_guide'
  });

  const mergedAudit = mergeLogoVisionIntoAudit(audit, logoVisionAudit);

  return {
    audit: mergedAudit,
    descriptions: describeResult.file,
    describeUsage: describeResult.usage,
    auditUsage,
    logoVisionUsage
  };
}

// ===== creative-bundle-integrity.mts =====
export type BundleIntegrityFinding = {
  format_id: string;
  severity: 'blocker' | 'warn';
  issue: string;
  fix_hint: string;
};

function readBundleSource (bundleDir: string): { html: string; css: string; js: string } | null {
  const indexPath = join(bundleDir, 'index.html');
  if (!existsSync(indexPath)) {
    return null;
  }
  const html = readFileSync(indexPath, { encoding: 'utf8' });
  const stylesPath = join(bundleDir, 'styles.css');
  const jsPath = join(bundleDir, 'app.js');
  return {
    html,
    css: existsSync(stylesPath) ? readFileSync(stylesPath, { encoding: 'utf8' }) : '',
    js: existsSync(jsPath) ? readFileSync(jsPath, { encoding: 'utf8' }) : ''
  };
}

function countHtmlSlides (html: string): number {
  const classMatches = html.match(/\bclass=["'][^"']*\bslide\b[^"']*["']/giu) ?? [];
  return classMatches.length;
}

function extractJsSlideCount (js: string): number | null {
  const match = js.match(/\bSLIDE_COUNT\s*=\s*(\d+)/u);
  if (match === null) {
    return null;
  }
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function jsCreatesPaginationDots (js: string): boolean {
  return /\bslide-dots\b/u.test(js) || /\bclassName\s*=\s*['"]dot['"]/u.test(js);
}

function formatIdsFromBundle (html: string, adFormats: readonly AdFormatSelection[]): string[] {
  const fromDom = adFormats
    .map((f) => f.id)
    .filter((id) => new RegExp(`\\bid=["']ad-${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']`, 'iu').test(html));
  return fromDom.length > 0 ? fromDom : adFormats.map((f) => f.id);
}

/** Deterministic bundle checks before UI vision review. */
export function auditCreativeBundleIntegrity (params: {
  bundleDir: string;
  adFormats: readonly AdFormatSelection[];
}): BundleIntegrityFinding[] {
  const source = readBundleSource(params.bundleDir);
  if (source === null) {
    return [
      {
        format_id: 'bundle',
        severity: 'blocker',
        issue: 'index.html missing from code bundle',
        fix_hint: 'Ensure codegen writes index.html into the active code version directory.'
      }
    ];
  }

  const findings: BundleIntegrityFinding[] = [];
  const formatIds = formatIdsFromBundle(source.html, params.adFormats);
  const primaryFormatId = formatIds[0] ?? 'bundle';

  const referencedNames = collectReferencedAssetFileNamesFromBundleSource(source);
  const missingInBundle: string[] = [];
  for (const refName of referencedNames) {
    if (!existsSync(join(params.bundleDir, refName))) {
      missingInBundle.push(refName);
    }
  }
  if (missingInBundle.length > 0) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: `Referenced local assets missing from bundle: ${missingInBundle.join(', ')}`,
      fix_hint:
        'Copy each missing file into the code bundle (same folder as index.html) or update HTML/CSS/JS '
        + 'to reference only assets present in the bundle. For carousels, ensure every background-image and src path resolves.'
    });
  }

  const htmlSlideCount = countHtmlSlides(source.html);
  const jsSlideCount = extractJsSlideCount(source.js);
  const hasDots = jsCreatesPaginationDots(source.js);

  if (hasDots && htmlSlideCount <= 1) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: 'Pagination dots are rendered but the HTML defines at most one carousel slide',
      fix_hint:
        'Either add multiple .slide elements with working background images, or remove slide-dots from app.js '
        + 'when slide count <= 1. Derive slide count from DOM: document.querySelectorAll(".bg-slides .slide").length.'
    });
  }

  if (hasDots && jsSlideCount !== null && htmlSlideCount > 0 && jsSlideCount !== htmlSlideCount) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: `SLIDE_COUNT (${String(jsSlideCount)}) does not match HTML slide elements (${String(htmlSlideCount)})`,
      fix_hint:
        'Set SLIDE_COUNT from the DOM slide count instead of a hardcoded number, e.g. '
        + 'var SLIDE_COUNT = document.querySelectorAll(".bg-slides .slide").length; hide dots when SLIDE_COUNT <= 1.'
    });
  }

  if (hasDots && htmlSlideCount >= 2 && missingInBundle.length > 0) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: 'Carousel pagination dots are shown but one or more slide background images are missing from the bundle',
      fix_hint:
        'Copy missing slide images into the bundle or remove pagination dots until all carousel assets load.'
    });
  }

  return findings;
}

export function mergeBundleIntegrityIntoUiAudit<T extends {
  satisfied: boolean;
  findings: Array<{ format_id: string; severity: 'blocker' | 'warn'; issue: string; fix_hint: string }>;
  regeneration_prompt: string;
}> (
  audit: T,
  integrityFindings: BundleIntegrityFinding[]
): T {
  const blockers = integrityFindings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return audit;
  }
  audit.satisfied = false;
  audit.findings = [ ...audit.findings, ...blockers ];
  if (audit.regeneration_prompt.trim().length === 0) {
    audit.regeneration_prompt = blockers.map((f) => `${f.format_id}: ${f.fix_hint}`).join('\n');
  } else {
    audit.regeneration_prompt = `${audit.regeneration_prompt}\n\n${blockers.map((f) => f.fix_hint).join('\n')}`;
  }
  return audit;
}

const KINETIC_TYPING_APP_JS_MARKERS: readonly RegExp[] = [
  /kinetic[\s_-]*headline/iu,
  /initHeadline/iu,
  /headline-letter/iu,
  /className\s*=\s*['"]char['"]/u,
  /@keyframes\s+charIn/u,
  /setTimeout\s*\(\s*tick\s*,/u,
  /letterGap/iu,
  /globalDelay/iu
];

const KINETIC_ANIMATED_FALSE_POSITIVE_ISSUE =
  /\b(?:animated(?:\s+state)?|mid-?animation)\b[\s\S]*?\b(?:truncat\w*|partial|incomplet\w*|cut\s+off|overflow)\b|\b(?:truncat\w*|partial|incomplet\w*|cut\s+off)\b[\s\S]*?\banimated(?:\s+state)?\b/iu;

/** True when bundle uses progressive headline reveal (JS tick or CSS letter stagger). */
export function detectsKineticTypingPattern (appJs: string): boolean {
  return KINETIC_TYPING_APP_JS_MARKERS.some((pattern) => pattern.test(appJs));
}

function decodeJsStringLiteral (raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`) as string;
  } catch {
    return raw.replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    );
  }
}

/** Ms from page load until kinetic headline typing/stagger is complete, or null if not detected. */
export function estimateKineticTypingCompletionMs (appJs: string): number | null {
  if (!detectsKineticTypingPattern(appJs)) {
    return null;
  }

  const textMatch = appJs.match(/\bTEXT\s*=\s*['"]([^'"]+)['"]/u);
  const tickTimeouts = [ ...appJs.matchAll(/setTimeout\s*\(\s*tick\s*,\s*(\d+)/gu) ].map((m) =>
    Number.parseInt(m[1] ?? '', 10)
  ).filter((n) => Number.isFinite(n) && n > 0);
  if (textMatch !== null && tickTimeouts.length >= 2) {
    const charCount = decodeJsStringLiteral(textMatch[1] ?? '').length;
    const intervalMs = Math.min(...tickTimeouts);
    const initialMs = Math.max(...tickTimeouts);
    if (charCount > 0) {
      return initialMs + charCount * intervalMs + 200;
    }
  }

  const letterGapMatch = appJs.match(/\bletterGap\s*=\s*([\d.]+)/u);
  const globalDelayMatch = appJs.match(/\bglobalDelay\s*=\s*([\d.]+)/u);
  const wordGapMatch = appJs.match(/\bwordGap\s*=\s*([\d.]+)/u);
  const wordsMatch = appJs.match(/\bwords\s*=\s*\[([\s\S]*?)\]/u);
  if (letterGapMatch !== null && globalDelayMatch !== null) {
    const letterGap = Number.parseFloat(letterGapMatch[1] ?? '');
    let globalDelay = Number.parseFloat(globalDelayMatch[1] ?? '');
    const wordGap = wordGapMatch !== null ? Number.parseFloat(wordGapMatch[1] ?? '') : 0;
    let charCount = 0;
    let wordCount = 0;
    if (wordsMatch !== null) {
      for (const text of (wordsMatch[1] ?? '').matchAll(/\btext:\s*['"]([^'"]+)['"]/gu)) {
        charCount += (text[1] ?? '').length;
        wordCount += 1;
      }
    }
    if (charCount > 0 && Number.isFinite(letterGap) && Number.isFinite(globalDelay)) {
      const endDelaySec = globalDelay + charCount * letterGap + Math.max(0, wordCount - 1) * wordGap;
      return Math.ceil(endDelaySec * 1000) + 300;
    }
  }

  return 2000;
}

/** Minimum extra wait (after initial screenshot) so animated capture shows full kinetic headline. */
export function estimateKineticMinAnimatedWaitMs (
  appJs: string,
  initialWaitMs: number
): number | null {
  const completionMs = estimateKineticTypingCompletionMs(appJs);
  if (completionMs === null) {
    return null;
  }
  return Math.max(0, completionMs - initialWaitMs + 200);
}

function isKineticAnimatedHeadlineFalsePositive (finding: {
  severity: string;
  issue: string;
  fix_hint: string;
}): boolean {
  if (finding.severity !== 'blocker') {
    return false;
  }
  const combined = `${finding.issue} ${finding.fix_hint}`;
  return KINETIC_ANIMATED_FALSE_POSITIVE_ISSUE.test(combined);
}

/** Downgrade Haiku blockers that mistake mid-animation kinetic headlines for truncation. */
export function suppressKineticAnimatedFalsePositives<T extends {
  satisfied: boolean;
  summary: string;
  findings: Array<{ format_id: string; severity: 'blocker' | 'warn'; issue: string; fix_hint: string }>;
  regeneration_prompt: string;
}> (audit: T, appJs: string): { suppressed: number } {
  if (!detectsKineticTypingPattern(appJs)) {
    return { suppressed: 0 };
  }

  let suppressed = 0;
  for (const finding of audit.findings) {
    if (!isKineticAnimatedHeadlineFalsePositive(finding)) {
      continue;
    }
    finding.severity = 'warn';
    finding.issue =
      `${finding.issue} (downgraded: expected partial kinetic headline on animated frame; validate full copy on settled only).`;
    suppressed += 1;
  }

  if (suppressed === 0) {
    return { suppressed: 0 };
  }

  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    audit.satisfied = true;
  }

  return { suppressed };
}

function extractHeadlineCopyFromJs (js: string): string | null {
  const textMatch = js.match(/\bTEXT\s*=\s*['"]([^'"]+)['"]/u);
  if (textMatch !== null) {
    return decodeJsStringLiteral(textMatch[1] ?? '');
  }
  const wordsMatch = js.match(/\bwords\s*=\s*\[([\s\S]*?)\]/u);
  if (wordsMatch !== null) {
    const parts = [ ...(wordsMatch[1] ?? '').matchAll(/\btext:\s*['"]([^'"]+)['"]/gu) ]
      .map((m) => m[1] ?? '');
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  return null;
}

function extractAdUnitIdsFromHtml (html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\bid=["'](ad-[^"']+)["']/giu)) {
    ids.add(`#${match[1] ?? ''}`);
  }
  return [ ...ids ];
}

function extractKeySelectorsFromBundle (html: string): string[] {
  const selectors = new Set<string>();
  const classHint =
    /^(?:headline|subhead|cta-btn|cta-label|packshot|logo|eyebrow|ad-footer|bottom-zone|packshot-img|logo-img)/iu;
  for (const match of html.matchAll(/\bclass=["']([^"']+)["']/giu)) {
    for (const cls of (match[1] ?? '').split(/\s+/u)) {
      if (classHint.test(cls)) {
        selectors.add(`.${cls}`);
      }
    }
  }
  for (const match of html.matchAll(/\bid=["']([^"']+)["']/giu)) {
    const id = match[1] ?? '';
    if (/^ad-/iu.test(id) || /headline/iu.test(id)) {
      selectors.add(`#${id}`);
    }
  }
  return [ ...selectors ].slice(0, 12);
}

function extractVisibleCopyHintsFromHtml (html: string): string[] {
  const hints: string[] = [];
  const ariaMatch = html.match(/\baria-label=["']([^"']+)["']/iu);
  if (ariaMatch !== null) {
    hints.push(`aria-label: ${ariaMatch[1] ?? ''}`);
  }
  const ctaMatch = html.match(/class=["'][^"']*cta-label[^"']*["'][^>]*>([^<]+)</iu);
  if (ctaMatch !== null) {
    hints.push(`cta_label: ${(ctaMatch[1] ?? '').trim()}`);
  }
  return hints;
}

/** Deterministic code summary for UI review (no LLM). */
export function buildUiReviewCodeAnnotations (bundleDir: string): string | null {
  const source = readBundleSource(bundleDir);
  if (source === null) {
    return null;
  }

  const kineticHeadline = detectsKineticTypingPattern(source.js);
  const kineticCompletionMs = kineticHeadline ? estimateKineticTypingCompletionMs(source.js) : null;
  const headlineCopy = extractHeadlineCopyFromJs(source.js);
  const contentGating = detectsContentGatingPattern(source.js, source.html);
  const referencedAssets = [ ...collectReferencedAssetFileNamesFromBundleSource(source) ]
    .filter((name) => !PROTECTED_BUNDLE_FILES.has(name))
    .sort();
  const adUnitIds = extractAdUnitIdsFromHtml(source.html);
  const keySelectors = extractKeySelectorsFromBundle(source.html);
  const copyHints = extractVisibleCopyHintsFromHtml(source.html);

  const lines = [
    '--- Code annotations (deterministic; use with screenshots) ---',
    `kinetic_headline: ${String(kineticHeadline)}`
  ];
  if (kineticCompletionMs !== null) {
    lines.push(`kinetic_completion_ms: ${String(kineticCompletionMs)}`);
    lines.push(
      'animated_screenshot_note: partial headline on animated frame is expected mid-type when kinetic_headline is true'
    );
  }
  if (headlineCopy !== null && headlineCopy.length > 0) {
    lines.push(`headline_copy_from_js: "${headlineCopy}"`);
  }
  lines.push(`content_gating: ${String(contentGating)}`);
  if (referencedAssets.length > 0) {
    lines.push(`referenced_assets: [${referencedAssets.join(', ')}]`);
  }
  if (adUnitIds.length > 0) {
    lines.push(`ad_unit_ids: [${adUnitIds.join(', ')}]`);
  }
  if (keySelectors.length > 0) {
    lines.push(`key_selectors: [${keySelectors.join(', ')}]`);
  }
  for (const hint of copyHints) {
    lines.push(hint);
  }

  return lines.join('\n');
}

// ===== creative-native-playwright-screenshots.mts =====
export type ScreenshotState = 'initial' | 'animated' | 'settled' | 'revealed';

export type CreativeReviewRevealResult = {
  revealed: boolean;
};

export type ScreenshotManifestEntry = {
  format_id: string;
  width: number;
  height: number;
  selector: string | null;
  error: string | null;
  shots: Array<{
    state: ScreenshotState;
    fileName: string;
    relativePath: string;
    captured_at: string;
  }>;
};

export type ScreenshotManifest = {
  captured_at: string;
  entry_html: string;
  entry_url: string;
  formats: ScreenshotManifestEntry[];
};

const INTERACTION_GATED_APP_JS_MARKERS: readonly RegExp[] = [
  /scratchCanvas/iu,
  /triggerReveal\s*\(/u,
  /Grattez pour révéler/iu,
  /tap.*reveal/iu,
  /swipe.*reveal/iu
];

const CONTENT_GATING_MARKERS: readonly RegExp[] = [
  ...INTERACTION_GATED_APP_JS_MARKERS,
  /pre-reveal-overlay/iu,
  /__CREATIVE_REVIEW__/u,
  /Appuyez pour révéler/iu
];

/** True when bundle uses legacy hide/reveal or scratch gating patterns. */
export function detectsContentGatingPattern (appJs: string, indexHtml?: string): boolean {
  if (CONTENT_GATING_MARKERS.some((pattern) => pattern.test(appJs))) {
    return true;
  }
  if (
    indexHtml !== undefined &&
    /pre-reveal-overlay|post-reveal-content|scratch-canvas|scratchCanvas/iu.test(indexHtml)
  ) {
    return true;
  }
  return false;
}

/** Blocker when new creatives use forbidden content-gating instead of motion-on-visible-content. */
export function auditContentGatingPattern (
  bundleDir: string,
  formatIds: readonly string[]
): BundleIntegrityFinding[] {
  const appJsPath = join(bundleDir, 'app.js');
  if (!existsSync(appJsPath)) {
    return [];
  }
  const appJs = readFileSync(appJsPath, 'utf8');
  const indexPath = join(bundleDir, 'index.html');
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  if (!detectsContentGatingPattern(appJs, indexHtml)) {
    return [];
  }
  const primaryFormatId = formatIds[0] ?? 'bundle';
  return [
    {
      format_id: primaryFormatId,
      severity: 'blocker',
      issue:
        'Creative uses forbidden content-gating (tap/scratch/pre-reveal overlay) that hides logo or product until interaction.',
      fix_hint:
        'Remove pre-reveal overlay and triggerReveal; keep logo and product hero visible on load. Use motion (particles, kinetic type, CTA pulse) on top of visible content instead.'
    }
  ];
}

/** Blockers when interaction-gated creatives omit the review hook or fail to produce a revealed shot. */
export function auditInteractionGatedReviewCapture (
  manifest: ScreenshotManifest,
  bundleDir: string
): BundleIntegrityFinding[] {
  const appJsPath = join(bundleDir, 'app.js');
  if (!existsSync(appJsPath)) {
    return [];
  }
  const appJs = readFileSync(appJsPath, 'utf8');
  const looksInteractionGated = INTERACTION_GATED_APP_JS_MARKERS.some((pattern) => pattern.test(appJs));
  if (!looksInteractionGated) {
    return [];
  }

  const hasReviewHook = appJs.includes('__CREATIVE_REVIEW__');
  const findings: BundleIntegrityFinding[] = [];

  for (const entry of manifest.formats) {
    if (entry.error !== null) {
      continue;
    }
    const hasRevealedShot = entry.shots.some((shot) => shot.state === 'revealed');
    if (hasRevealedShot) {
      continue;
    }
    if (!hasReviewHook) {
      findings.push({
        format_id: entry.format_id,
        severity: 'blocker',
        issue:
          'Interaction-gated ad is missing window.__CREATIVE_REVIEW__ — the revealed state could not be captured for UI review.',
        fix_hint:
          'At end of app.js add: window.__CREATIVE_REVIEW__ = { hasInteraction: true, reveal() { /* call triggerReveal or equivalent — idempotent */ } };'
      });
    } else {
      findings.push({
        format_id: entry.format_id,
        severity: 'blocker',
        issue:
          'Interaction-gated ad exposes __CREATIVE_REVIEW__ but no revealed screenshot was captured — reveal() may be missing or not idempotent.',
        fix_hint:
          'Ensure window.__CREATIVE_REVIEW__.reveal() exists, is callable, and reaches the fully revealed UI state when invoked once.'
      });
    }
  }

  return findings;
}

export type CaptureScreenshotsOptions = {
  codeDirectoryPath: string;
  adFormats: readonly AdFormatSelection[];
  outputScreensDir: string;
  /** Run root `output/<uuid>/` for pipeline-usage.json ledger. */
  directoryPath?: string;
  reviewRound?: number;
  initialWaitMs?: number;
  animatedWaitMs?: number;
  settledWaitMs?: number;
  revealedWaitMs?: number;
  viewportMarginPx?: number;
};

const SCREENSHOT_STATES: readonly ScreenshotState[] = [ 'initial', 'animated', 'settled' ];

function screenshotProfile (): string {
  return process.env['CREATIVE_SCREENSHOT_PROFILE']?.trim().toLowerCase() ?? 'fast';
}

function screenshotStatesForProfile (): readonly ScreenshotState[] {
  // Fast/dev keeps shorter waits, but still captures all states to catch transient UI overlaps.
  return SCREENSHOT_STATES;
}

function parsePositiveIntEnv (name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(n, max);
}

function sanitizeFileSegment (value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function buildSelectorCandidates (format: AdFormatSelection): string[] {
  const domId = formatIdToAdDomId(format.id);
  return [
    `#${domId}`,
    `#${domId.replace(/:/g, '\\:')}`,
    `[data-width="${String(format.width)}"][data-height="${String(format.height)}"] .ad-unit`,
    `.preview-wrapper[data-width="${String(format.width)}"][data-height="${String(format.height)}"] .ad-unit`,
    `.ad-unit[style*="width:${String(format.width)}px"][style*="height:${String(format.height)}px"]`
  ];
}

async function resolveAdUnitLocator (page: Page, format: AdFormatSelection): Promise<{ selector: string } | { error: string }> {
  for (const selector of buildSelectorCandidates(format)) {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (count > 0) {
      return { selector };
    }
  }
  return {
    error: `No DOM node found for format "${format.id}" (tried ${buildSelectorCandidates(format).join(', ')})`
  };
}

type DomElementLike = {
  style: { transform: string; transformOrigin: string; overflow: string; width: string; height: string };
  offsetWidth: number;
  offsetHeight: number;
  closest: (selector: string) => DomElementLike | null;
  scrollIntoView: (options: { block: string; inline: string }) => void;
};

async function bypassPreviewScale (page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const doc = (globalThis as { document?: { querySelector: (s: string) => DomElementLike | null } }).document;
    if (doc === undefined) {
      return;
    }
    const el = doc.querySelector(sel);
    if (el === null) {
      return;
    }
    el.style.transform = 'none';
    el.style.transformOrigin = 'top left';
    const wrapper = el.closest('.preview-wrapper');
    if (wrapper !== null) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      wrapper.style.transform = 'none';
      wrapper.style.width = `${String(w)}px`;
      wrapper.style.height = `${String(h)}px`;
      wrapper.style.overflow = 'visible';
    }
    const slot = el.closest('.ad-slot');
    if (slot !== null) {
      slot.style.overflow = 'visible';
    }
  }, selector);
}

async function scrollAdUnitIntoView (page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const doc = (globalThis as { document?: { querySelector: (s: string) => DomElementLike | null } }).document;
    if (doc === undefined) {
      return;
    }
    const el = doc.querySelector(sel);
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, selector);
}

/** Calls window.__CREATIVE_REVIEW__.reveal() when the creative exposes the review hook. */
export async function attemptCreativeReviewReveal (page: Page): Promise<CreativeReviewRevealResult> {
  return page.evaluate(() => {
    const win = globalThis as {
      __CREATIVE_REVIEW__?: { reveal?: () => void };
    };
    const reveal = win.__CREATIVE_REVIEW__?.reveal;
    if (typeof reveal !== 'function') {
      return { revealed: false };
    }
    reveal();
    return { revealed: true };
  });
}

async function captureFormatScreenshots (
  browser: Browser,
  format: AdFormatSelection,
  entryUrl: string,
  outputScreensDir: string,
  waits: { initial: number; animated: number; settled: number; revealed: number },
  viewportMarginPx: number
): Promise<ScreenshotManifestEntry> {
  const shots: ScreenshotManifestEntry['shots'] = [];
  let resolvedSelector: string | null = null;
  let resolveError: string | null = null;
  const context = await browser.newContext({
      viewport: {
        width: Math.min(format.width + viewportMarginPx * 2, 4096),
        height: Math.min(format.height + viewportMarginPx * 2, 4096)
      },
      deviceScaleFactor: 1
  });
  try {
    const page = await context.newPage();
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const resolved = await resolveAdUnitLocator(page, format);
    if ('error' in resolved) {
      resolveError = resolved.error;
      return {
        format_id: format.id,
        width: format.width,
        height: format.height,
        selector: null,
        error: resolveError,
        shots: []
      };
    }

    resolvedSelector = resolved.selector;
    const locator = page.locator(resolvedSelector).first();
    await locator.waitFor({ state: 'visible', timeout: 15_000 });

    for (const state of screenshotStatesForProfile()) {
      await bypassPreviewScale(page, resolvedSelector);
      await scrollAdUnitIntoView(page, resolvedSelector);

      if (state === 'initial') {
        if (waits.initial > 0) {
          await page.waitForTimeout(waits.initial);
        }
      } else if (state === 'animated') {
        await page.waitForTimeout(waits.animated);
      } else {
        await page.waitForTimeout(waits.settled);
      }

      await bypassPreviewScale(page, resolvedSelector);

      const fileName = `${sanitizeFileSegment(format.id)}__${state}.png`;
      const absolutePath = join(outputScreensDir, fileName);
      await locator.screenshot({ path: absolutePath, type: 'png' });
      shots.push({
        state,
        fileName,
        relativePath: fileName,
        captured_at: new Date().toISOString()
      });
    }

    const revealResult = await attemptCreativeReviewReveal(page);
    if (revealResult.revealed) {
      await bypassPreviewScale(page, resolvedSelector);
      await scrollAdUnitIntoView(page, resolvedSelector);
      if (waits.revealed > 0) {
        await page.waitForTimeout(waits.revealed);
      }
      await bypassPreviewScale(page, resolvedSelector);

      const revealedFileName = `${sanitizeFileSegment(format.id)}__revealed.png`;
      const revealedAbsolutePath = join(outputScreensDir, revealedFileName);
      await locator.screenshot({ path: revealedAbsolutePath, type: 'png' });
      shots.push({
        state: 'revealed',
        fileName: revealedFileName,
        relativePath: revealedFileName,
        captured_at: new Date().toISOString()
      });
    }
  } finally {
    await context.close();
  }

  return {
    format_id: format.id,
    width: format.width,
    height: format.height,
    selector: resolvedSelector,
    error: resolveError,
    shots
  };
}

export async function captureCreativeNativeScreenshots (
  options: CaptureScreenshotsOptions
): Promise<ScreenshotManifest> {
  const {
    codeDirectoryPath,
    adFormats,
    outputScreensDir
  } = options;

  const entryHtmlPath = join(codeDirectoryPath, 'index.html');
  if (!existsSync(entryHtmlPath)) {
    throw new Error(`Missing index.html in code directory: ${entryHtmlPath}`);
  }

  mkdirSync(outputScreensDir, { recursive: true });

  const profile = screenshotProfile();
  const devProfile = profile === 'dev' || profile === 'fast';
  const initialWaitMs =
    options.initialWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_INITIAL_WAIT_MS', devProfile ? 200 : 600, 30_000);
  let animatedWaitMs =
    options.animatedWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_ANIMATED_WAIT_MS', devProfile ? 800 : 2500, 60_000);
  if (options.animatedWaitMs === undefined) {
    const appJsPath = join(codeDirectoryPath, 'app.js');
    if (existsSync(appJsPath)) {
      const appJs = readFileSync(appJsPath, { encoding: 'utf8' });
      const kineticMinAnimated = estimateKineticMinAnimatedWaitMs(appJs, initialWaitMs);
      if (kineticMinAnimated !== null && kineticMinAnimated > animatedWaitMs) {
        console.log(
          `[screenshots] Kinetic headline detected — animated wait ${String(animatedWaitMs)}ms → ${String(kineticMinAnimated)}ms`
        );
        animatedWaitMs = kineticMinAnimated;
      }
    }
  }
  const settledWaitMs =
    options.settledWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_SETTLED_WAIT_MS', devProfile ? 1500 : 5000, 120_000);
  const revealedWaitMs =
    options.revealedWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_REVEALED_WAIT_MS', devProfile ? 800 : 2000, 30_000);
  const viewportMarginPx = options.viewportMarginPx ?? 48;

  const entryUrl = pathToFileURL(entryHtmlPath).toString();
  const waits = {
    initial: initialWaitMs,
    animated: animatedWaitMs,
    settled: settledWaitMs,
    revealed: revealedWaitMs
  };

  console.log(`[screenshots] Capturing ${String(adFormats.length)} format(s) → ${outputScreensDir}`);
  const startedAt = Date.now();

  const browser = await chromium.launch({
    headless: true,
    args: [ '--allow-file-access-from-files', '--disable-web-security' ]
  });
  let formatEntries: ScreenshotManifestEntry[];
  try {
    formatEntries = await Promise.all(
      adFormats.map((format) =>
        captureFormatScreenshots(browser, format, entryUrl, outputScreensDir, waits, viewportMarginPx)
      )
    );
  } finally {
    await browser.close();
  }

  const manifest: ScreenshotManifest = {
    captured_at: new Date().toISOString(),
    entry_html: entryHtmlPath,
    entry_url: entryUrl,
    formats: formatEntries
  };

  const manifestPath = join(outputScreensDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });
  console.log(`[screenshots] Manifest written: ${manifestPath}`);

  const pngCount = formatEntries.reduce((n, f) => n + f.shots.length, 0);
  const captureErrors = formatEntries.filter((f) => f.error !== null).length;
  const durationMs = Date.now() - startedAt;
  const ledgerDir = options.directoryPath;
  if (ledgerDir !== undefined && ledgerDir.length > 0) {
    const notes = `${String(pngCount)} PNG, ${String(adFormats.length)} format(s), ${String(captureErrors)} capture error(s), ${String(durationMs)} ms`;
    const file = appendPipelineUsage(
      ledgerDir,
      entryZeroCost({
        action: 'screenshots',
        agent: 'lib/creative-native-playwright-screenshots.mts',
        review_round: options.reviewRound ?? null,
        notes,
        duration_ms: durationMs
      })
    );
    logPipelineUsageToConsole(file.entries[file.entries.length - 1]!);
  }

  return manifest;
}

// ===== creative-native-regen-deterministic.mts =====
const CAPTURE_BLOCKER_RE =
  /\b(dom node|screenshot capture|id\s*=\s*["']ad-|#ad-|non-capturable|selector|not found for format)\b/iu;

export function isCaptureOrDomBlockerAudit (audit: UiReviewOutput): boolean {
  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return CAPTURE_BLOCKER_RE.test(audit.summary) || CAPTURE_BLOCKER_RE.test(audit.regeneration_prompt);
  }
  return blockers.every(
    (f) =>
      CAPTURE_BLOCKER_RE.test(f.issue) ||
      CAPTURE_BLOCKER_RE.test(f.fix_hint) ||
      f.format_id === 'capture'
  );
}

export type DeterministicUiFixResult = {
  applied: boolean;
  details: string[];
};

/** Patch index.html / styles.css without LLM when capture failed due to missing ad ids. */
export function tryDeterministicCaptureFixes (
  codeDirectoryPath: string,
  adFormats: readonly AdFormatSelection[]
): DeterministicUiFixResult {
  const indexPath = join(codeDirectoryPath, 'index.html');
  const stylesPath = join(codeDirectoryPath, 'styles.css');
  if (!existsSync(indexPath)) {
    return { applied: false, details: [ 'index.html missing' ] };
  }

  const details: string[] = [];
  let html = readFileSync(indexPath, { encoding: 'utf8' });
  const beforeIds = adFormats.filter((f) => htmlContainsAdDomId(html, formatIdToAdDomId(f.id))).length;

  const { html: patchedHtml, fixedFormatIds } = ensureAdFormatDomIdsInHtml(html, adFormats);
  html = patchedHtml;
  if (fixedFormatIds.length > 0) {
    details.push(`Added id on ad container for: ${fixedFormatIds.join(', ')}`);
  }

  const afterIds = adFormats.filter((f) => htmlContainsAdDomId(html, formatIdToAdDomId(f.id))).length;
  if (afterIds > beforeIds) {
    writeFileSync(indexPath, html, { encoding: 'utf8' });
  }

  if (existsSync(stylesPath)) {
    const css = readFileSync(stylesPath, { encoding: 'utf8' });
    const { css: patchedCss, appended } = appendAdFormatDimensionRules(css, adFormats);
    if (appended) {
      writeFileSync(stylesPath, patchedCss, { encoding: 'utf8' });
      details.push('Appended #ad-{formatId} dimension rules for capture');
    }
  }

  return { applied: details.length > 0, details };
}

// ===== creative-native-regen-diff.mts =====
/**
 * Optional regen diff logging / revert after UI-review regen.
 * Set CREATIVE_REGEN_DIFF_GUARD=1 to restore files that changed more than CREATIVE_REGEN_DIFF_MAX_RATIO (default 0.2).
 */



const REGEN_WATCH_FILES = [ 'index.html', 'styles.css', 'app.js' ] as const;

export type RegenDiffReport = {
  fileName: string;
  beforeLines: number;
  afterLines: number;
  changedLines: number;
  changeRatio: number;
};

export type RegenDiffSummary = {
  reports: RegenDiffReport[];
  maxChangeRatio: number;
  likelyFullRewrite: boolean;
};

function lineChangeCount (before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  const max = Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      changed += 1;
    }
  }
  return changed;
}

export function parseMaxRegenChangeRatio (): number {
  const raw = process.env['CREATIVE_REGEN_DIFF_MAX_RATIO']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 0.2;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.2;
}

/** Off by default; set CREATIVE_REGEN_DIFF_GUARD=1 to revert oversized regen files. */
export function isRegenDiffGuardEnabled (): boolean {
  return process.env['CREATIVE_REGEN_DIFF_GUARD']?.trim() === '1';
}

/** Compare code/ files before vs after regen (snapshots must exist under review/). */
export function summarizeRegenDiff (
  codeDirectoryPath: string,
  beforeSnapshots: Readonly<Record<string, string>>
): RegenDiffSummary {
  const reports: RegenDiffReport[] = [];

  for (const fileName of REGEN_WATCH_FILES) {
    const before = beforeSnapshots[fileName];
    if (before === undefined) {
      continue;
    }
    const afterPath = join(codeDirectoryPath, fileName);
    let after: string;
    try {
      after = readFileSync(afterPath, { encoding: 'utf8' });
    } catch {
      continue;
    }
    const beforeLines = before.split('\n').length;
    const afterLines = after.split('\n').length;
    const changedLines = lineChangeCount(before, after);
    const denom = Math.max(beforeLines, afterLines, 1);
    reports.push({
      fileName,
      beforeLines,
      afterLines,
      changedLines,
      changeRatio: changedLines / denom
    });
  }

  const maxChangeRatio = reports.reduce((m, r) => Math.max(m, r.changeRatio), 0);
  const threshold = parseMaxRegenChangeRatio();
  return {
    reports,
    maxChangeRatio,
    likelyFullRewrite: reports.length > 0 && maxChangeRatio > threshold
  };
}

export type RegenReconcileResult = RegenDiffSummary & {
  restoredFiles: string[];
};

/** Revert files that changed too much vs baseline (keeps surgical patches only). */
export function reconcileRegenWithBaseline (
  codeDirectoryPath: string,
  beforeSnapshots: Readonly<Record<string, string>>
): RegenReconcileResult {
  const summary = summarizeRegenDiff(codeDirectoryPath, beforeSnapshots);
  const threshold = parseMaxRegenChangeRatio();
  const restoredFiles: string[] = [];

  for (const report of summary.reports) {
    if (report.changeRatio <= threshold) {
      continue;
    }
    const before = beforeSnapshots[report.fileName];
    if (before === undefined) {
      continue;
    }
    const targetPath = join(codeDirectoryPath, report.fileName);
    if (!existsSync(targetPath)) {
      continue;
    }
    writeFileSync(targetPath, before, { encoding: 'utf8' });
    restoredFiles.push(report.fileName);
  }

  const afterRestore = summarizeRegenDiff(codeDirectoryPath, beforeSnapshots);
  return {
    ...afterRestore,
    restoredFiles
  };
}

export function writeRegenBaselineSnapshot (
  codeDirectoryPath: string,
  baselineDirectoryPath: string
): void {
  mkdirSync(baselineDirectoryPath, { recursive: true });
  const snapshot = snapshotCodeBundleForDiff(codeDirectoryPath);
  for (const [ fileName, content ] of Object.entries(snapshot)) {
    const target = join(baselineDirectoryPath, fileName);
    writeFileSync(target, content, { encoding: 'utf8' });
  }
}

export function snapshotCodeBundleForDiff (codeDirectoryPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fileName of REGEN_WATCH_FILES) {
    try {
      out[fileName] = readFileSync(join(codeDirectoryPath, fileName), { encoding: 'utf8' });
    } catch {
      // skip missing
    }
  }
  return out;
}

export function logRegenDiffSummary (summary: RegenDiffSummary): void {
  if (summary.reports.length === 0) {
    return;
  }
  for (const r of summary.reports) {
    console.log(
      `[regen-diff] ${r.fileName}: ${String(Math.round(r.changeRatio * 100))}% lines changed `
        + `(${String(r.changedLines)}/${String(Math.max(r.beforeLines, r.afterLines))})`
    );
  }
  if (summary.likelyFullRewrite) {
    console.warn(
      `[regen-diff] Likely full rewrite (max ratio ${String(Math.round(summary.maxChangeRatio * 100))}% > threshold). `
        + 'Consider CREATIVE_REGEN_MODEL=claude-sonnet-4-6 or narrower UI review fix_hints.'
    );
  }
}

// ===== creative-native-ui-review-regen.mts =====
const REDESIGN_RE =
  /\b(redesign|rebuild|replace entire|from scratch|new layout|new concept|start over|refonte complète)\b/iu;

const CAPTURE_BLOCKER_REGEN_RE =
  /\b(dom node|screenshot capture|id\s*=\s*["']ad-|#ad-|non-capturable|selector)\b/iu;

export function buildStrictMinimalRegenSuffix (): string {
  return (
    '\n\nSTRICT MINIMAL PATCH (mandatory):\n' +
    '- Change only the lines required by the blockers above (often 1–10 lines total across all files).\n' +
    '- Do NOT rewrite styles.css or restructure the layout. Keep every unrelated rule and animation.\n' +
    '- Prefer editing existing selectors over adding new sections or renaming classes.\n' +
    '- If the only issue is capture/DOM id, add id="ad-{formatId}" and width/height on that selector only.'
  );
}

export function resolveRegenModelFromUiAudit (
  audit: UiReviewOutput,
  options?: { strictMinimalRetry?: boolean }
): string {
  const forced = process.env['CREATIVE_REGEN_MODEL']?.trim();
  if (forced !== undefined && forced.length > 0) {
    return forced;
  }

  if (process.env['CREATIVE_REGEN_USE_HAIKU']?.trim() === '1') {
    return 'claude-haiku-4-5-20251001';
  }

  if (options?.strictMinimalRetry === true) {
    return 'claude-sonnet-4-6';
  }

  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  const heavyText = [
    audit.regeneration_prompt,
    ...blockers.map((f) => `${f.issue} ${f.fix_hint}`)
  ].join('\n');

  const captureLike =
    blockers.length > 0 &&
    blockers.every(
      (f) =>
        CAPTURE_BLOCKER_REGEN_RE.test(f.issue) ||
        CAPTURE_BLOCKER_REGEN_RE.test(f.fix_hint) ||
        f.format_id === 'capture'
    );

  if (captureLike || blockers.length > 2 || REDESIGN_RE.test(heavyText)) {
    return 'claude-sonnet-4-6';
  }

  return 'claude-haiku-4-5-20251001';
}

