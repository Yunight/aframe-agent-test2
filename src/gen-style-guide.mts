import { join, basename, extname } from 'node:path';
import { mkdirSync, createWriteStream, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { withAnthropicRetry } from './anthropic-retry.mts';
import {
  appendPipelineUsage,
  entryFromAccumulator,
  logPipelineUsageToConsole
} from './creative-pipeline-usage.mts';

const STYLE_GUIDE_MODEL = 'claude-opus-4-7';

// --- Tokens / coût (Claude Opus 4.7 Flagship : $5/M input, $25/M output) ---
const USD_PER_MILLION_INPUT_TOKENS = 5;
const USD_PER_MILLION_OUTPUT_TOKENS = 25;

type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

type UsageAccumulator = {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

function createEmptyUsageAccumulator (): UsageAccumulator {
  return {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

function addUsageToAccumulator (
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

function billedInputTokens (acc: UsageAccumulator): number {
  return acc.input_tokens + acc.cache_creation_input_tokens + acc.cache_read_input_tokens;
}

function pricesUsdFromAccumulator (acc: UsageAccumulator): {
  billed_input_tokens: number;
  output_tokens: number;
  input_usd: number;
  output_usd: number;
  total_usd: number;
} {
  const billed_input_tokens = billedInputTokens(acc);
  const output_tokens = acc.output_tokens;
  const input_usd = (billed_input_tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS;
  const output_usd = (output_tokens / 1_000_000) * USD_PER_MILLION_OUTPUT_TOKENS;
  return {
    billed_input_tokens,
    output_tokens,
    input_usd,
    output_usd,
    total_usd: input_usd + output_usd
  };
}

function roundUsd6 (n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function logAnthropicUsageAndCost (scriptLabel: string, acc: UsageAccumulator): void {
  const p = pricesUsdFromAccumulator(acc);
  console.log(`--- ${scriptLabel} (cumulative) ---`);
  console.log(`call reason : ${acc.api_calls} réponse(s) API — Claude Opus 4.7 Flagship ($5/M input, $25/M output, cache inclus côté input)`);
  console.log(`input token : ${p.billed_input_tokens}`);
  console.log(`output token : ${p.output_tokens}`);
  console.log(`input price (USD) : ${roundUsd6(p.input_usd)}`);
  console.log(`output price (USD) : ${roundUsd6(p.output_usd)}`);
  console.log(`total price (USD) : ${roundUsd6(p.total_usd)}`);
  console.log('');
}
function billedInputFromUsage (usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function logReadableAnthropicCall (callReason: string, usage: UsageLike | null | undefined): void {
  console.log(`call reason : ${callReason}`);
  if (usage === null || usage === undefined) {
    console.log('input token : —');
    console.log('output token : —');
    console.log('');
    return;
  }
  console.log(`input token : ${billedInputFromUsage(usage)}`);
  console.log(`output token : ${usage.output_tokens}`);
  console.log('');
}

function shortenForLog (s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function pickQueryFromUnknown (input: unknown): string | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }
  const o = input as Record<string, unknown>;
  for (const key of [ 'query', 'search_query', 'q' ] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return shortenForLog(v, 160);
    }
  }
  return null;
}

function describeClientToolUse (name: string, input: unknown): string {
  switch (name) {
    case 'web_search':
      return "recherche web (pages officielles, sources, vérification d'informations)";
    case 'render_creative_png': {
      const o = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : null;
      const entry = typeof o?.['entryFile'] === 'string' ? o['entryFile'] : '(fichier non précisé)';
      const preset = typeof o?.['devicePreset'] === 'string' ? o['devicePreset'] : null;
      const wait = typeof o?.['waitMs'] === 'number' ? `attente ${o['waitMs']} ms` : null;
      const bits = [ `entrée ${entry}` ];
      if (preset !== null) {
        bits.push(`appareil ${preset}`);
      }
      if (wait !== null) {
        bits.push(wait);
      }
      return `génération de prévisualisation PNG (Puppeteer) — ${bits.join(', ')} — pour contrôler la scène avant livraison des fichiers`;
    }
    default:
      return `outil personnalisé « ${name} »`;
  }
}

function describeServerToolUse (name: Anthropic.ServerToolUseBlock['name'], input: unknown): string {
  const q = pickQueryFromUnknown(input);
  const qSuffix = q !== null ? ` — requête « ${q} »` : '';
  switch (name) {
    case 'web_search':
      return `recherche web intégrée (serveur Anthropic)${qSuffix}`;
    case 'web_fetch':
      return `récupération de page distante (web_fetch)${qSuffix}`;
    case 'code_execution':
    case 'bash_code_execution':
    case 'text_editor_code_execution':
      return `exécution / édition côté serveur (${name})`;
    case 'tool_search_tool_regex':
    case 'tool_search_tool_bm25':
      return `recherche d'outils (${name})`;
    default:
      return `outil serveur « ${name} »${qSuffix}`;
  }
}

function describeAnthropicTurnForLogs (
  stopReason: Anthropic.Message['stop_reason'],
  content: Anthropic.Message['content']
): string {
  const segments: string[] = [];

  if (stopReason !== null && stopReason !== undefined) {
    segments.push(`arrêt: ${stopReason}`);
  }

  if (content.length === 0) {
    segments.push('aucun bloc de contenu');
    return segments.join(' — ');
  }

  const actions: string[] = [];
  let hasThinking = false;
  let hasText = false;

  for (const block of content) {
    if (block.type === 'tool_use') {
      actions.push(describeClientToolUse(block.name, block.input));
    } else if (block.type === 'server_tool_use') {
      actions.push(describeServerToolUse(block.name, block.input));
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      hasThinking = true;
    } else if (block.type === 'text') {
      hasText = true;
    }
  }

  if (actions.length > 0) {
    segments.push(`objectif du tour : ${actions.join(' | ')}`);
  }

  if (stopReason === 'tool_use' && actions.length === 0) {
    segments.push('arrêt tool_use sans blocs tool_use reconnus (vérifier la réponse)');
  }

  if (stopReason !== 'tool_use') {
    if (hasText && actions.length === 0) {
      segments.push('réponse textuelle ou JSON structuré (livraison ou étape intermédiaire)');
    }
    if (hasThinking && actions.length === 0 && !hasText) {
      segments.push('réflexion interne uniquement (extended thinking), sans texte ni outil client');
    }
    if (!hasText && actions.length === 0 && stopReason === 'end_turn') {
      segments.push('fin de tour (souvent JSON de guide de style ou liste de fichiers parsée)');
    }
  }

  if (hasThinking && actions.length > 0) {
    segments.push('inclut de la réflexion étendue');
  }

  return segments.join(' — ');
}


interface BraveImageResult {
  type: 'image_result';
  title: string;
  url: string;
  source: string;
  page_fetched: string;
  thumbnail: { src: string };
  properties: {
    url: string;
    placeholder: string;
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

const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const mimeTypeToExtension: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const DEFAULT_STYLE_GUIDE_BRAND = 'Peugeot';
const DEFAULT_STYLE_GUIDE_CONTEXT = 'the new EV GTI 208 they are launching';

/** Same wording as style-guide-studio-api `composeStyleGuideContextFromParts`. */
function buildStyleGuideContextFromBrandAndContext (brand: string, context: string): string {
  const b = brand.trim();
  const c = context.trim();
  if (b.length > 0 && c.length > 0) {
    return `The brand is ${b} and the context is ${c}`;
  }
  if (b.length > 0) {
    return 'The brand is '
      + b
      + ' and the context is not specified beyond the brand; infer positioning from official sites and current campaigns.';
  }
  if (c.length > 0) {
    return 'No commercial brand was specified. The context is '
      + c
      + '. Infer visuals, tone, typography, and color direction from official trailers, key art, and distributor or studio materials only; do not invent a corporate brand beyond this title or IP.';
  }
  return '';
}

function defaultStyleGuideContextPrompt (): string {
  return buildStyleGuideContextFromBrandAndContext(DEFAULT_STYLE_GUIDE_BRAND, DEFAULT_STYLE_GUIDE_CONTEXT);
}

function resolveStyleGuideContextPrompt (fallback: string): string {
  const raw = process.env['STYLE_GUIDE_CONTEXT'];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('STYLE_GUIDE_CONTEXT is set but empty after trim.');
  }
  return trimmed;
}

const skillFiles = [
  '.claude/.skills/ui-design/commands/color-palette.md',
  '.claude/.skills/ui-design/commands/type-system.md',
  '.claude/.skills/ui-design/skills/color-system/SKILL.md',
  '.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md',
  '.claude/.skills/ui-design/skills/typography-scale/SKILL.md',
  '.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md'
] as const;

function loadSkillGuidance (): string {
  const rootDir = join(import.meta.dirname, '..');
  const loadedSkills = skillFiles
    .map((relativePath) => {
      const absolutePath = join(rootDir, relativePath);

      if (!existsSync(absolutePath)) {
        console.warn(`[skills] Missing skill file: ${relativePath}`);
        return null;
      }

      const content = readFileSync(absolutePath, 'utf8').trim();
      return `### ${relativePath}\n${content}`;
    })
    .filter((value): value is string => value !== null);

  if (loadedSkills.length === 0) {
    throw new Error('No local skill files were found in .claude/.skills.');
  }

  return loadedSkills.join('\n\n');
}

function sanitizeFilename (name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

async function downloadFileToFileSystem (url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: '*/*'
    }
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

async function resolveRemoteImageMetadata(url: string): Promise<{ mimeType: string, extension: string }> {
  const headResponse = await fetch(url, {
    method: 'HEAD',
    headers: {
      Accept: 'image/*'
    }
  });

  if (!headResponse.ok) {
    throw new Error(`Unable to validate image URL ${url}. HEAD request failed with status ${headResponse.status}`);
  }

  const contentTypeHeader = headResponse.headers.get('content-type') ?? '';
  const mimeType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!allowedImageMimeTypes.has(mimeType)) {
    throw new Error(`URL ${url} has unsupported content-type "${contentTypeHeader}"`);
  }

  const extension = mimeTypeToExtension[mimeType];
  if (extension === undefined) {
    throw new Error(`Unsupported MIME type "${mimeType}" for URL ${url}`);
  }

  return { mimeType, extension };
}

async function braveImageSearch (
  { query, num = 10 }:
  { query: string, num?: number }
): Promise<BraveImageResult[]> {
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

function pickDirectImageUrl (r: BraveImageResult): string | null {
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

async function gatherValidatedImageUrls (
  queries: readonly string[],
  options: { maxResults: number, perQuery: number }
): Promise<string[]> {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    let results: BraveImageResult[];
    try {
      results = await braveImageSearch({ query, num: options.perQuery });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Brave images] query failed "${query}": ${msg}`);
      continue;
    }
    for (const row of results) {
      const candidate = pickDirectImageUrl(row);
      if (candidate === null || seen.has(candidate)) {
        continue;
      }
      try {
        await resolveRemoteImageMetadata(candidate);
        seen.add(candidate);
        urls.push(candidate);
        if (urls.length >= options.maxResults) {
          return urls;
        }
      } catch {
        /* URL not a usable image */
      }
    }
  }
  return urls;
}

interface ImageSearchContext {
  brandName: string;
  companyName: string;
  productName: string;
}

function buildLogoSearchQueries (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const company = base.companyName.trim();
  const queries = [
    `${brand} logo PNG transparent`,
    `${brand} logo officiel`,
    `${brand} wordmark logo`
  ];
  if (company.length > 0 && company.toLowerCase() !== brand.toLowerCase()) {
    queries.push(`${company} ${brand} logo`);
  }
  return queries;
}

function buildProductSearchQueries (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const product = base.productName.trim();
  if (product.length > 0) {
    return [
      `${brand} ${product} photo produit`,
      `${product} packshot`,
      `${brand} ${product} marketing`
    ];
  }
  return [ `${brand} produit photo`, `${brand} gamme produit` ];
}

const brandStyleGuideSchema = z.object({
  companyName: z.string().describe('Company name.'),
  companyContext: z.string().describe('What does the company do?'),
  companyURL: z.url().describe('URL of company.'),
  brandName: z.string().describe('Brand name.'),
  brandContext: z.string().describe('What does the brand do?'),
  brandURL: z.url().describe('URL of brand.'),
  logoFileUrls: z.array(z.url()).describe('List of brand image logo URLs in different variants.'),
  productName: z.string().describe('Name of product if one is specified'),
  productPictureUrls: z.array(z.url()).describe('List of product pictures or packshots URLs in different variants.'),
  primaryColorPalette: z.array(z.hex()).describe('List of hexadecimal codes for the colors of primary color palette in descending order of importants.'),
  secondaryColorPalette: z.array(z.hex()).describe('List of hexadecimal codes for the colors of secondary color palette in descending order of importants.'),
  typography: z.array(
    z.object({
      fontFamily: z.string().describe('Font family name'),
      fontWeight: z.number().describe('Font weight as used in CSS'),
      fontEffect: z.array(z.enum([ 'bold', 'italic', 'underline', 'strikethrough' ])).describe('Font effects'),
      fontUses: z.string().describe('Context in which to use said font setting. i.e: brand name, heading, text body, etc.')
    })
  ),
  brandVision: z.string().describe('Direction taken by the brand.'),
  brandValues: z.string().describe('What does the brand or company stand for?')
})
  .describe('Brand style guide object')
  .strict();

export type StyleGuide = z.infer<typeof brandStyleGuideSchema>;

const brandStyleGuideModelSchema = brandStyleGuideSchema.omit({
  logoFileUrls: true,
  productPictureUrls: true
});

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });
const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const braveApiKeyConfigured = process.env['BRAVE_API_KEY']?.trim();
if (braveApiKeyConfigured === undefined || braveApiKeyConfigured.length === 0) {
  throw new Error('Missing BRAVE_API_KEY. Set it in project root .env (Brave Search API key for image search).');
}

const contextPrompt = resolveStyleGuideContextPrompt(defaultStyleGuideContextPrompt());

const anthropicClient = new Anthropic({
  apiKey: anthropicApiKey
});
const cliArguments = process.argv.slice(2);
if (cliArguments.length > 0) {
  throw new Error(`Unknown argument "${cliArguments[0]}". This script no longer supports optional asset download flags.`);
}

const messages: Anthropic.Messages.MessageParam[] = [{
  role: 'user',
  content: contextPrompt
}];
let styleGuideFromModel: z.infer<typeof brandStyleGuideModelSchema> | null = null;
const localSkillGuidance = loadSkillGuidance();

let i = 0;

const apiUsageTotals = createEmptyUsageAccumulator();

while (true) {
  i += 1;

  console.log(`Generating style guide ... (i=${i})`);

  const styleGuideResponse = await withAnthropicRetry(`style-guide turn ${String(i)}`, async () => {
    const styleGuideStream = await anthropicClient.messages.stream({
      max_tokens: 128000,
      system: `
      You are an agent that assembles brand style guides based on external information.
      The information should ideally be sourced from the brand or company's official websites.
      No information should come from the model memory. It should always be fetched remotely to ensure freshness.

      Make sure to understand who the company or brand is and what the context is.
      If a product name or category is specified analyse the problem with it in mind.

      Do not invent or guess direct image URLs for logos or product photos. Those assets are collected
      separately after your JSON using the Brave Images API from search queries derived from the brand
      and product fields you output.
      the logo should be a single light mode version, it must be the most recent one available and a transparent PNG file, check the mimetype to avoid the fake transparency.
      When specifying colors, always check that the color exists and matches the one described in the official sources.

      Use web_search for company/brand facts, official pages, typography and color references only.
      keep it simple and clean for visual direction in text (no image URLs in your output schema for assets).
      The local design skills below are mandatory constraints.
      Before returning final JSON, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep searching and refining, and do not finalize yet.
      ${localSkillGuidance}
    `.trim(),
      messages,
      model: 'claude-opus-4-7',
      thinking: {
        type: 'adaptive',
        display: 'omitted'
      },
      output_config: {
        format: zodOutputFormat(brandStyleGuideModelSchema),
        effort: 'xhigh' as 'low' | 'medium' | 'high' | 'max' | null
      },
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 25
        }
      ]
    });
    return await styleGuideStream.finalMessage();
  });
  addUsageToAccumulator(apiUsageTotals, styleGuideResponse.usage);
  logReadableAnthropicCall(
    describeAnthropicTurnForLogs(styleGuideResponse.stop_reason, styleGuideResponse.content),
    styleGuideResponse.usage ?? undefined
  );

  messages.push({ role: 'assistant', content: styleGuideResponse.content });

  console.log('[Claude]', JSON.stringify(styleGuideResponse.content).slice(0, 100), '...');

  if (styleGuideResponse.stop_reason !== 'tool_use') {
    console.log('Stop reason:', styleGuideResponse.stop_reason);
    console.log('Stop details:', styleGuideResponse.stop_details);
    console.log(styleGuideResponse.parsed_output);
    styleGuideFromModel = styleGuideResponse.parsed_output;
    break;
  }

  messages.push({
    role: 'user',
    content:
      'Continue: produce the full style guide JSON per the schema. Use web_search only for textual facts. '
      + 'Your structured output must not include logo or product image URLs (those fields are omitted from the schema). '
      + 'Complete all other fields and end the turn with valid structured output.'
  });
}

if (styleGuideFromModel === null) {
  throw new Error('Empty style guide response');
}

console.log('[Brave images] Collecting logo candidates…');
const logoFileUrls = await gatherValidatedImageUrls(buildLogoSearchQueries(styleGuideFromModel), {
  maxResults: 2,
  perQuery: 10
});
console.log('[Brave images] Collecting product photo candidates…');
const productPictureUrls = await gatherValidatedImageUrls(buildProductSearchQueries(styleGuideFromModel), {
  maxResults: 8,
  perQuery: 10
});

if (logoFileUrls.length === 0 || productPictureUrls.length === 0) {
  throw new Error(
    `Brave image search did not return enough valid image URLs (logos: ${logoFileUrls.length}, products: ${productPictureUrls.length}).`
  );
}

const finalMessageContent: StyleGuide = brandStyleGuideSchema.parse({
  ...styleGuideFromModel,
  logoFileUrls,
  productPictureUrls
});

const directoryUuid = randomUUID();
const outputDirectoryName = directoryUuid;
const directoryPath = join(import.meta.dirname, '..', 'output', outputDirectoryName);

console.log(`Output directory path: ${directoryPath}`);
console.log('Download assets: required');

mkdirSync(directoryPath);

const downloadedAssetCounts: Record<'logos' | 'products', number> = {
  logos: 0,
  products: 0
};
const failedAssetDownloads: Array<{ fileType: 'logos' | 'products'; url: string; reason: string }> = [];

for (const fileType of [ 'logos', 'products' ] as const) {
  const fileUrls = (fileType === 'logos'
    ? finalMessageContent?.logoFileUrls
    : fileType === 'products'
      ? finalMessageContent?.productPictureUrls
      : []
  ) ?? [];

  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath);

  for (const fileUrl of fileUrls) {
    const logoFileName = basename(fileUrl);
    const logoFileNameSanitized = sanitizeFilename(logoFileName);
    const originalExtension = extname(logoFileNameSanitized).toLowerCase();

    try {
      const { mimeType, extension } = await resolveRemoteImageMetadata(fileUrl);
      const resolvedFileName = originalExtension === extension
        ? logoFileNameSanitized
        : `${logoFileNameSanitized.replace(/\.[^.]+$/, '')}${extension}`;
      const filePath = join(subdirectoryPath, resolvedFileName);

      if (originalExtension !== extension) {
        console.warn(`[download] Extension mismatch for ${fileUrl}. Original "${originalExtension || 'none'}", remote "${mimeType}". Saving as ${resolvedFileName}.`);
      }

      console.log(`Downloading ${filePath} ...`);
      await downloadFileToFileSystem(fileUrl, filePath);
      downloadedAssetCounts[fileType] += 1;
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(err);
        failedAssetDownloads.push({
          fileType,
          url: fileUrl,
          reason: err.message
        });
      }
    }
  }
}

const minimumAssetsPerType = 1;
const missingTypes = (Object.entries(downloadedAssetCounts) as Array<[ 'logos' | 'products', number ]>)
  .filter(([, count]) => count < minimumAssetsPerType)
  .map(([type, count]) => `${type}: ${count}/${minimumAssetsPerType}`);

if (missingTypes.length > 0) {
  const failedList = failedAssetDownloads.length === 0
    ? 'none'
    : failedAssetDownloads
      .map((entry) => `${entry.fileType} | ${entry.url} | ${entry.reason}`)
      .join('\n');
  throw new Error(
    `Asset download requirements not met (${missingTypes.join(', ')}).\n` +
    `Downloaded counts: logos=${downloadedAssetCounts.logos}, products=${downloadedAssetCounts.products}\n` +
    `Failed downloads:\n${failedList}`
  );
}

const styleGuideFilePath = join(directoryPath, 'style-guide.json');
writeFileSync(
  styleGuideFilePath,
  `${JSON.stringify(finalMessageContent, null, 2)}\n`,
  { encoding: 'utf8' }
);

logAnthropicUsageAndCost(basename(import.meta.filename, extname(import.meta.filename)), apiUsageTotals);

const styleGuidePipelineEntry = entryFromAccumulator({
  action: 'style_guide',
  agent: 'gen-style-guide.mts',
  model: STYLE_GUIDE_MODEL,
  acc: apiUsageTotals
});
const styleGuidePipelineFile = appendPipelineUsage(directoryPath, styleGuidePipelineEntry);
logPipelineUsageToConsole(styleGuidePipelineFile.entries[styleGuidePipelineFile.entries.length - 1]!);

console.log('End.');
