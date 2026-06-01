import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import Express from 'express';
import {
  envForCreativeCodegenPreset,
  isCreativeCodegenPresetId,
} from '../lib/creative-native-codegen-presets.mts';
import {
  appendPipelineRunSummary,
  formatDurationMinSec,
  pipelineUsagePath
} from '../lib/creative-pipeline-usage.mts';
import { loadAdFormatPresets, normalizeApiAdFormats } from '../lib/studio-ad-formats.mts';
import { preflightReferenceUrlForStudio } from '../lib/reference-url-preflight.mts';
import {
  codeVersionCount,
  listCodeVersions,
  resolveCodeDirectory
} from '../lib/creative-code-versions.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';

const repoRoot = repoRootFromModuleDir(import.meta.dirname);
loadDotenv({ path: join(repoRoot, '.env') });

const PORT = Number.parseInt(process.env['STYLE_GUIDE_STUDIO_PORT'] ?? '3001', 10);
const MAX_CONTEXT_CHARS = 32_000;

function composeStyleGuideContextFromParts (brand: string, context: string): string {
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

function parseReferenceUrlFromBody (body: {
  referenceUrl?: unknown;
  campaignReferenceUrl?: unknown;
}): { ok: true; url: string } | { ok: false; error: string } {
  const raw =
    typeof body.referenceUrl === 'string'
      ? body.referenceUrl
      : typeof body.campaignReferenceUrl === 'string'
        ? body.campaignReferenceUrl
        : '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, url: '' };
  }
  if (trimmed.length > 2048) {
    return { ok: false, error: 'referenceUrl exceeds 2048 characters.' };
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:') {
      return { ok: false, error: 'referenceUrl must use HTTPS.' };
    }
    return { ok: true, url: u.href };
  } catch {
    return { ok: false, error: 'referenceUrl is not a valid URL.' };
  }
}

function composeStyleGuideContextWithReference (
  brand: string,
  context: string,
  referenceUrl: string
): string {
  const base = composeStyleGuideContextFromParts(brand, context);
  if (referenceUrl.length === 0) {
    return base;
  }
  return (
    `Campaign reference URL (must use for brandURL and product scrape): ${referenceUrl}\n\n${base}`
  );
}

type ImageSearchProviderId = 'brave' | 'anthropic';

function parseImageSearchProviderFromBody (
  raw: unknown
): { ok: true; provider: ImageSearchProviderId } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, provider: 'brave' };
  }
  if (raw !== 'brave' && raw !== 'anthropic') {
    return { ok: false, error: 'imageSearchProvider must be "brave" or "anthropic".' };
  }
  return { ok: true, provider: raw };
}

function imageSearchProviderEnv (provider: ImageSearchProviderId): Record<string, string> {
  return { CREATIVE_IMAGE_SEARCH_PROVIDER: provider };
}

const agentsDir = join(repoRoot, 'src', 'agents');
const outputDir = join(repoRoot, 'output');
const DEFAULT_STYLE_SCRIPT = 'gen-style-guide.mts';

const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

function corsMiddleware (
  req: Express.Request,
  res: Express.Response,
  next: Express.NextFunction
): void {
  const origin = req.headers.origin;
  if (origin !== undefined && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

function sseWrite (res: Express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type JobStatus = 'running' | 'done' | 'error';

type StudioJobKind = 'style_guide' | 'creative';

interface Job {
  id: string;
  status: JobStatus;
  startedAt: number;
  jobKind: StudioJobKind;
  stepTimings: Array<{ label: string; duration_ms: number }>;
  lines: Array<{ source: 'stdout' | 'stderr'; text: string }>;
  exitCode: number | null;
  outputDirectoryPath: string | null;
  subscribers: Set<Express.Response>;
  /** Propagated to every spawned agent via CREATIVE_IMAGE_SEARCH_PROVIDER. */
  imageSearchProvider: ImageSearchProviderId;
}

const jobs = new Map<string, Job>();
let activeJobId: string | null = null;

function createJob (imageSearchProvider: ImageSearchProviderId, jobKind: StudioJobKind): Job {
  const id = randomUUID();
  const job: Job = {
    id,
    status: 'running',
    startedAt: Date.now(),
    jobKind,
    stepTimings: [],
    lines: [],
    exitCode: null,
    outputDirectoryPath: null,
    subscribers: new Set(),
    imageSearchProvider
  };
  jobs.set(id, job);
  return job;
}

function studioJobKindLabel (kind: StudioJobKind): string {
  return kind === 'style_guide' ? 'style guide' : 'format de pub';
}

function broadcast (job: Job, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.subscribers) {
    res.write(payload);
  }
}

function attachSubscriber (job: Job, res: Express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  job.subscribers.add(res);
  for (const line of job.lines) {
    sseWrite(res, 'log', line);
  }
  if (job.status !== 'running') {
    if (job.status === 'done') {
      sseWrite(res, 'done', {
        exitCode: job.exitCode,
        outputDirectoryPath: job.outputDirectoryPath
      });
    } else {
      sseWrite(res, 'failed', {
        exitCode: job.exitCode,
        outputDirectoryPath: job.outputDirectoryPath,
        message: job.exitCode !== 0 ? `Process exited with code ${String(job.exitCode)}` : 'Unknown error'
      });
    }
    job.subscribers.delete(res);
    res.end();
    return;
  }
  res.on('close', () => {
    job.subscribers.delete(res);
  });
}

function pushLine (job: Job, source: 'stdout' | 'stderr', text: string): void {
  const entry = { source, text };
  job.lines.push(entry);
  if (source === 'stderr') {
    console.error(`[job ${job.id}] ${text}`);
  } else {
    console.log(`[job ${job.id}] ${text}`);
  }
  const m = /^Output directory path:\s*(.+)$/u.exec(text.trim());
  if (m !== null) {
    job.outputDirectoryPath = m[1]?.trim() ?? null;
  }
  broadcast(job, 'log', entry);
}

function finishJob (job: Job, exitCode: number | null): void {
  job.exitCode = exitCode;
  job.status = exitCode === 0 ? 'done' : 'error';
  const jobWallMs = Date.now() - job.startedAt;
  if (exitCode === 0) {
    pushLine(
      job,
      'stdout',
      `[studio] Job ${studioJobKindLabel(job.jobKind)} total : ${formatDurationMinSec(jobWallMs)}`
    );
  }
  if (job.outputDirectoryPath !== null && job.outputDirectoryPath.length > 0) {
    appendPipelineRunSummary(job.outputDirectoryPath, {
      wall_clock_ms: jobWallMs,
      studio_job_id: job.id
    });
  }
  broadcast(job, job.status === 'done' ? 'done' : 'failed', {
    exitCode,
    outputDirectoryPath: job.outputDirectoryPath
  });
  for (const res of job.subscribers) {
    res.end();
  }
  job.subscribers.clear();
  if (activeJobId === job.id) {
    activeJobId = null;
  }
}

function createLineReader (onLine: (line: string) => void): {
  push: (chunk: Buffer) => void;
  end: () => void;
} {
  let carry = '';
  return {
    push (chunk: Buffer) {
      carry += chunk.toString('utf8');
      const parts = carry.split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        onLine(line);
      }
    },
    end () {
      if (carry.length > 0) {
        onLine(carry);
        carry = '';
      }
    }
  };
}

function listStyleGuideScripts (): string[] {
  const name = 'gen-style-guide.mts';
  if (!existsSync(agentsDir)) {
    return [];
  }
  return existsSync(join(agentsDir, name)) ? [ name ] : [];
}

function listCreativeCodeScripts (): string[] {
  if (!existsSync(agentsDir)) {
    return [];
  }
  return readdirSync(agentsDir)
    .filter((n) => n.startsWith('gen-creative-code') && n.endsWith('.mts'))
    .sort((a, b) => a.localeCompare(b));
}

interface OutputStyleFolder {
  folderName: string;
  mtimeMs: number;
  /** Number of creative bundles (code/Vn or legacy flat layout). */
  codeVersionCount: number;
}

/** Runs that have style-guide.json (creative generation allowed even if code/ exists). */
function listOutputFoldersWithStyleGuide (): OutputStyleFolder[] {
  const entries: OutputStyleFolder[] = [];
  if (!existsSync(outputDir)) {
    return entries;
  }
  for (const dirent of readdirSync(outputDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
      continue;
    }
    const folderPath = join(outputDir, dirent.name);
    const sg = join(folderPath, 'style-guide.json');
    if (!existsSync(sg)) {
      continue;
    }
    entries.push({
      folderName: dirent.name,
      mtimeMs: statSync(sg).mtimeMs,
      codeVersionCount: codeVersionCount(folderPath)
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

function isSafeOutputFolderSegment (name: string): boolean {
  if (name.length === 0 || name.length > 240) {
    return false;
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return false;
  }
  return /^[\w.-]+$/.test(name);
}

/** Folder segment under `output/` from `Output directory path:` log line. */
function outputFolderNameFromDirectoryPath (dirPath: string | null): string | null {
  if (dirPath === null || dirPath.trim().length === 0) {
    return null;
  }
  const name = basename(dirPath.trim());
  return isSafeOutputFolderSegment(name) ? name : null;
}

type StudioJobStep = {
  argv: string[] | ((job: Job) => string[] | null);
  env?: Record<string, string | undefined>;
};

function attachSpawnedNodeProcess (job: Job, argv: string[], extraEnv: Record<string, string | undefined>): void {
  attachSpawnedNodeProcessSequence(job, [ { argv, env: extraEnv } ]);
}

function attachSpawnedNodeProcessSequence (
  job: Job,
  steps: StudioJobStep[]
): void {
  let stepIndex = 0;

  const runNextStep = (): void => {
    const step = steps[stepIndex];
    if (step === undefined) {
      finishJob(job, 0);
      return;
    }

    stepIndex += 1;
    const resolvedArgv = typeof step.argv === 'function' ? step.argv(job) : step.argv;
    if (resolvedArgv === null) {
      pushLine(
        job,
        'stderr',
        '[studio] Cannot resolve step argv (missing or invalid output directory from previous step).'
      );
      finishJob(job, 1);
      return;
    }

    const stepScriptLabel = basename(resolvedArgv[0] ?? 'script');
    const stepLabel =
      stepScriptLabel === 'run-style-guide-assets-review.mts'
        ? `[studio] Step ${String(stepIndex)}/${String(steps.length)} — review assets style guide (produits): ${resolvedArgv.join(' ')}`
        : stepScriptLabel === 'run-creative-native-ui-review.mts'
          ? `[studio] Step ${String(stepIndex)}/${String(steps.length)} — review UI créative: ${resolvedArgv.join(' ')}`
          : `[studio] Step ${String(stepIndex)}/${String(steps.length)}: ${resolvedArgv.join(' ')}`;
    pushLine(job, 'stdout', stepLabel);
    if (stepIndex === 1) {
      pushLine(
        job,
        'stdout',
        `[studio] Image search provider for this job: ${job.imageSearchProvider} (CREATIVE_IMAGE_SEARCH_PROVIDER)`
      );
      pushLine(
        job,
        'stdout',
        `[studio] Phase pipeline : ${job.jobKind} (PIPELINE_PHASE)`
      );
    }

    const stepStartedAt = Date.now();
    const child = spawn(process.execPath, resolvedArgv, {
      cwd: repoRoot,
      env: {
        ...process.env,
        CREATIVE_IMAGE_SEARCH_PROVIDER: job.imageSearchProvider,
        PIPELINE_PHASE: job.jobKind,
        ...step.env
      },
      stdio: [ 'ignore', 'pipe', 'pipe' ]
    });

    const stdoutReader = createLineReader((line) => {
      pushLine(job, 'stdout', line);
    });
    const stderrReader = createLineReader((line) => {
      pushLine(job, 'stderr', line);
    });

    child.stdout?.on('data', (buf: Buffer) => {
      stdoutReader.push(buf);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderrReader.push(buf);
    });

    child.on('close', (code, signal) => {
      stdoutReader.end();
      stderrReader.end();
      const stepDurationMs = Date.now() - stepStartedAt;
      job.stepTimings.push({ label: stepScriptLabel, duration_ms: stepDurationMs });
      const exitCode = signal !== null ? 1 : (code ?? 1);
      if (exitCode !== 0) {
        pushLine(
          job,
          'stderr',
          `[studio] Step ${String(stepIndex)}/${String(steps.length)} échoué après ${formatDurationMinSec(stepDurationMs)} (${stepScriptLabel})`
        );
        finishJob(job, exitCode);
        return;
      }
      pushLine(
        job,
        'stdout',
        `[studio] Step ${String(stepIndex)}/${String(steps.length)} terminé en ${formatDurationMinSec(stepDurationMs)} (${stepScriptLabel})`
      );
      runNextStep();
    });

    child.on('error', (err) => {
      pushLine(job, 'stderr', `[spawn error] ${err.message}`);
      finishJob(job, 1);
    });
  };

  runNextStep();
}

interface OutputPreviewVersion {
  versionId: string;
  versionLabel: string;
  /** Path relative to `output/` (e.g. `<uuid>/code/V2/index.html`). */
  relativePath: string;
  previewUrl: string;
  mtimeMs: number;
  pageTitle: string;
}

interface OutputFolderPreview {
  folderName: string;
  pageTitle: string;
  versionCount: number;
  versions: OutputPreviewVersion[];
  mtimeMs: number;
}

const TITLE_SNIFF_MAX_BYTES = 65_536;

function readPageTitleFromIndexHtml (absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    const slice = buf.subarray(0, Math.min(buf.length, TITLE_SNIFF_MAX_BYTES));
    const html = slice.toString('utf8');
    const m = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
    if (m === null || m[1] === undefined) {
      return null;
    }
    const text = m[1].replace(/\s+/gu, ' ').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function listOutputIndexHtmlPreviews (): OutputFolderPreview[] {
  const entries: OutputFolderPreview[] = [];
  if (!existsSync(outputDir)) {
    return entries;
  }
  for (const dirent of readdirSync(outputDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
      continue;
    }
    const base = join(outputDir, dirent.name);
    const codeVersions = listCodeVersions(base);
    const versions: OutputPreviewVersion[] = codeVersions.map((v) => {
      const relativePath = relative(outputDir, v.indexHtmlPath).replace(/\\/gu, '/');
      const fromFile = readPageTitleFromIndexHtml(v.indexHtmlPath);
      return {
        versionId: v.versionId,
        versionLabel: v.versionLabel,
        relativePath,
        previewUrl: `/output/${relativePath}`,
        mtimeMs: v.mtimeMs,
        pageTitle: fromFile ?? dirent.name
      };
    });
    if (versions.length === 0) {
      const rootHtml = join(base, 'index.html');
      if (existsSync(rootHtml)) {
        const relativePath = `${dirent.name}/index.html`;
        const fromFile = readPageTitleFromIndexHtml(rootHtml);
        versions.push({
          versionId: 'V1',
          versionLabel: 'Version 1',
          relativePath,
          previewUrl: `/output/${relativePath}`,
          mtimeMs: statSync(rootHtml).mtimeMs,
          pageTitle: fromFile ?? dirent.name
        });
      }
    }
    if (versions.length === 0) {
      continue;
    }
    const latest = versions[versions.length - 1]!;
    entries.push({
      folderName: dirent.name,
      pageTitle: latest.pageTitle,
      versionCount: versions.length,
      versions,
      mtimeMs: latest.mtimeMs
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

const app = Express();
app.use(corsMiddleware);
app.use(Express.json({ limit: `${MAX_CONTEXT_CHARS + 10_000}` }));

app.post('/api/style-guide/preflight-reference-url', async (req, res) => {
  const referenceParsed = parseReferenceUrlFromBody(req.body as {
    referenceUrl?: unknown;
    campaignReferenceUrl?: unknown;
  });
  if (!referenceParsed.ok) {
    res.status(400).json({ error: referenceParsed.error });
    return;
  }
  if (referenceParsed.url.length === 0) {
    res.status(400).json({ error: 'referenceUrl is required.' });
    return;
  }
  try {
    const result = await preflightReferenceUrlForStudio(referenceParsed.url);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post('/api/style-guide/run', async (req, res) => {
  if (activeJobId !== null) {
    res.status(429).json({ error: 'Un job studio est déjà en cours.' });
    return;
  }
  const body = req.body as {
    contextPrompt?: unknown;
    brand?: unknown;
    context?: unknown;
    referenceUrl?: unknown;
    campaignReferenceUrl?: unknown;
    assetsReviewAfterGeneration?: unknown;
    imageSearchProvider?: unknown;
  };
  const imageProviderParsed = parseImageSearchProviderFromBody(body.imageSearchProvider);
  if (!imageProviderParsed.ok) {
    res.status(400).json({ error: imageProviderParsed.error });
    return;
  }
  const imageEnv = imageSearchProviderEnv(imageProviderParsed.provider);
  const referenceParsed = parseReferenceUrlFromBody(body);
  if (!referenceParsed.ok) {
    res.status(400).json({ error: referenceParsed.error });
    return;
  }
  const referenceUrl = referenceParsed.url;

  const brandField = typeof body.brand === 'string' ? body.brand : '';
  const contextField = typeof body.context === 'string' ? body.context : '';
  const hasBrandOrContext =
    brandField.trim().length > 0 || contextField.trim().length > 0 || referenceUrl.length > 0;

  let contextPrompt: string;
  if (hasBrandOrContext) {
    contextPrompt = composeStyleGuideContextWithReference(brandField, contextField, referenceUrl);
  } else if (typeof body.contextPrompt === 'string') {
    contextPrompt = body.contextPrompt.trim();
    if (contextPrompt.length === 0) {
      res.status(400).json({ error: 'contextPrompt must not be empty.' });
      return;
    }
  } else {
    res.status(400).json({
      error:
        'Expected JSON body { "brand"?: string, "context"?: string } with at least one non-empty after trim, or legacy { "contextPrompt": string }.'
    });
    return;
  }
  if (contextPrompt.length === 0) {
    res.status(400).json({
      error: 'Provide a non-empty "brand" and/or "context", or legacy "contextPrompt".'
    });
    return;
  }
  if (contextPrompt.length > MAX_CONTEXT_CHARS) {
    res.status(400).json({ error: `Resolved context exceeds ${String(MAX_CONTEXT_CHARS)} characters.` });
    return;
  }

  if (referenceUrl.length > 0) {
    try {
      const preflight = await preflightReferenceUrlForStudio(referenceUrl);
      if (preflight.status === 'blocked' || preflight.status === 'unreachable') {
        res.status(422).json({ error: preflight.message, preflight });
        return;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Preflight reference URL failed: ${message}` });
      return;
    }
  }

  const styleScriptPath = join(agentsDir, DEFAULT_STYLE_SCRIPT);
  if (!existsSync(styleScriptPath)) {
    res.status(500).json({ error: `${DEFAULT_STYLE_SCRIPT} is missing from src/agents/.` });
    return;
  }

  const assetsReviewAfterGeneration = body.assetsReviewAfterGeneration === true;
  const styleGuideAssetsReviewPath = join(agentsDir, 'run-style-guide-assets-review.mts');

  const job = createJob(imageProviderParsed.provider, 'style_guide');
  activeJobId = job.id;

  if (assetsReviewAfterGeneration) {
    if (!existsSync(styleGuideAssetsReviewPath)) {
      res.status(500).json({ error: 'run-style-guide-assets-review.mts is missing from src/agents/.' });
      return;
    }
    attachSpawnedNodeProcessSequence(job, [
      {
        argv: [ styleScriptPath ],
        env: {
          STYLE_GUIDE_CONTEXT: contextPrompt,
          ...(referenceUrl.length > 0 ? { STYLE_GUIDE_REFERENCE_URL: referenceUrl } : {}),
          ...imageEnv
        }
      },
      {
        argv: (activeJob) => {
          const folder = outputFolderNameFromDirectoryPath(activeJob.outputDirectoryPath);
          return folder !== null ? [ styleGuideAssetsReviewPath, folder ] : null;
        },
        env: { ...imageEnv }
      }
    ]);
  } else {
    attachSpawnedNodeProcess(job, [ styleScriptPath ], {
      STYLE_GUIDE_CONTEXT: contextPrompt,
      ...(referenceUrl.length > 0 ? { STYLE_GUIDE_REFERENCE_URL: referenceUrl } : {}),
      ...imageEnv
    });
  }

  res.status(202).json({ jobId: job.id });
});

app.post('/api/creative-code/run', (req, res) => {
  if (activeJobId !== null) {
    res.status(429).json({ error: 'Un job studio est déjà en cours.' });
    return;
  }
  const body = req.body as {
    creativeScript?: unknown;
    outputFolder?: unknown;
    adFormats?: unknown;
    assetsReviewBeforeGeneration?: unknown;
    uiReviewAfterGeneration?: unknown;
    creativeCodegenPreset?: unknown;
    imageSearchProvider?: unknown;
  };
  const imageProviderParsed = parseImageSearchProviderFromBody(body.imageSearchProvider);
  if (!imageProviderParsed.ok) {
    res.status(400).json({ error: imageProviderParsed.error });
    return;
  }
  if (typeof body.creativeScript !== 'string' || body.creativeScript.trim().length === 0) {
    res.status(400).json({
      error:
        'Expected JSON body { "creativeScript": string, "outputFolder": string, "adFormats"?: array, "assetsReviewBeforeGeneration"?: boolean, "uiReviewAfterGeneration"?: boolean }.'
    });
    return;
  }
  if (typeof body.outputFolder !== 'string' || body.outputFolder.trim().length === 0) {
    res.status(400).json({ error: 'outputFolder must be a non-empty string.' });
    return;
  }
  const creativeScript = body.creativeScript.trim();
  const outputFolder = body.outputFolder.trim();
  const allowedCreative = new Set(listCreativeCodeScripts());
  if (!allowedCreative.has(creativeScript)) {
    res.status(400).json({ error: 'creativeScript is not an allowed file in src/agents/.' });
    return;
  }
  if (!isSafeOutputFolderSegment(outputFolder)) {
    res.status(400).json({ error: 'Invalid outputFolder name.' });
    return;
  }
  const styleGuideJson = join(outputDir, outputFolder, 'style-guide.json');
  if (!existsSync(styleGuideJson)) {
    res.status(400).json({ error: 'outputFolder must exist under output/ and contain style-guide.json.' });
    return;
  }
  const assetsReviewFinalPath = join(outputDir, outputFolder, 'review', 'assets-review-final.json');
  let assetsReviewSatisfied = false;
  if (existsSync(assetsReviewFinalPath)) {
    try {
      const finalRaw = JSON.parse(readFileSync(assetsReviewFinalPath, 'utf8')) as { satisfied?: boolean };
      assetsReviewSatisfied = finalRaw.satisfied === true;
    } catch {
      assetsReviewSatisfied = false;
    }
  }
  if (!assetsReviewSatisfied) {
    res.status(400).json({
      error:
        'Assets must be reviewed before creative generation. Run the style guide job with "Review assets après génération" ' +
        `(produces ${assetsReviewFinalPath}), or run node src/agents/run-style-guide-assets-review.mts ${outputFolder}.`
    });
    return;
  }

  const presetList = loadAdFormatPresets(repoRoot);
  let adFormatsJson: string;
  if (body.adFormats === undefined) {
    const first = presetList[0];
    if (first === undefined) {
      res.status(500).json({ error: 'No ad format presets configured.' });
      return;
    }
    adFormatsJson = JSON.stringify([ { id: first.id, width: first.width, height: first.height } ]);
  } else {
    const normalized = normalizeApiAdFormats(body.adFormats, presetList);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    adFormatsJson = JSON.stringify(normalized.formats);
  }

  const assetsReviewLegacyRequested =
    body.assetsReviewBeforeGeneration === true && creativeScript === 'gen-creative-code-native.mts';
  const uiReviewRequested =
    body.uiReviewAfterGeneration === true && creativeScript === 'gen-creative-code-native.mts';

  let codegenPresetEnv: Record<string, string> = envForCreativeCodegenPreset('fast');
  if (typeof body.creativeCodegenPreset === 'string' && body.creativeCodegenPreset.trim().length > 0) {
    const presetRaw = body.creativeCodegenPreset.trim();
    if (!isCreativeCodegenPresetId(presetRaw)) {
      res.status(400).json({ error: 'creativeCodegenPreset must be fast, balanced, or quality.' });
      return;
    }
    codegenPresetEnv = envForCreativeCodegenPreset(presetRaw);
  }

  const job = createJob(imageProviderParsed.provider, 'creative');
  activeJobId = job.id;
  job.outputDirectoryPath = join(outputDir, outputFolder);
  const creativePath = join(agentsDir, creativeScript);
  const uiReviewPath = join(agentsDir, 'run-creative-native-ui-review.mts');

  const genStep = {
    argv: [ creativePath, outputFolder ],
    env: {
      ...codegenPresetEnv,
      PIPELINE_PHASE: 'creative',
      CREATIVE_AD_FORMATS: adFormatsJson,
      CREATIVE_UI_REVIEW_MAX_ROUNDS: '0'
    }
  };

  const sequenceSteps: Array<{ argv: string[]; env?: Record<string, string> }> = [];

  if (assetsReviewLegacyRequested) {
    console.warn(
      '[studio] assetsReviewBeforeGeneration is deprecated: assets are reviewed during the style guide job. Skipping run-creative-native-assets-review.'
    );
  }
  sequenceSteps.push(genStep);
  if (uiReviewRequested) {
    sequenceSteps.push({
      argv: [ uiReviewPath, outputFolder ],
      env: {
        CREATIVE_AD_FORMATS: adFormatsJson,
        CREATIVE_UI_REVIEW_MAX_ROUNDS: '2',
        CREATIVE_SCREENSHOT_PROFILE: 'fast'
      }
    });
  }

  if (sequenceSteps.length > 1) {
    attachSpawnedNodeProcessSequence(job, sequenceSteps);
  } else {
    attachSpawnedNodeProcess(job, genStep.argv, genStep.env);
  }

  res.status(202).json({ jobId: job.id });
});

function parseOutputFolderBody (body: { outputFolder?: unknown }): { ok: true; folder: string } | { ok: false; error: string } {
  if (typeof body.outputFolder !== 'string' || body.outputFolder.trim().length === 0) {
    return { ok: false, error: 'outputFolder must be a non-empty string.' };
  }
  const folder = body.outputFolder.trim();
  if (!isSafeOutputFolderSegment(folder)) {
    return { ok: false, error: 'Invalid outputFolder name.' };
  }
  const folderPath = join(outputDir, folder);
  if (!existsSync(folderPath)) {
    return { ok: false, error: `output/${folder} does not exist.` };
  }
  return { ok: true, folder };
}

app.post('/api/style-guide/review-assets', (req, res) => {
  if (activeJobId !== null) {
    res.status(429).json({ error: 'Un job studio est déjà en cours.' });
    return;
  }
  const imageProviderParsed = parseImageSearchProviderFromBody(
    (req.body as { imageSearchProvider?: unknown }).imageSearchProvider
  );
  if (!imageProviderParsed.ok) {
    res.status(400).json({ error: imageProviderParsed.error });
    return;
  }
  const folderParsed = parseOutputFolderBody(req.body as { outputFolder?: unknown });
  if (!folderParsed.ok) {
    res.status(400).json({ error: folderParsed.error });
    return;
  }
  const styleGuideJson = join(outputDir, folderParsed.folder, 'style-guide.json');
  if (!existsSync(styleGuideJson)) {
    res.status(400).json({ error: 'outputFolder must contain style-guide.json.' });
    return;
  }
  const assetsReviewPath = join(agentsDir, 'run-style-guide-assets-review.mts');
  if (!existsSync(assetsReviewPath)) {
    res.status(500).json({ error: 'run-style-guide-assets-review.mts is missing from src/agents/.' });
    return;
  }

  const job = createJob(imageProviderParsed.provider, 'style_guide');
  activeJobId = job.id;
  job.outputDirectoryPath = join(outputDir, folderParsed.folder);
  attachSpawnedNodeProcess(job, [ assetsReviewPath, folderParsed.folder ], {
    ...imageSearchProviderEnv(imageProviderParsed.provider),
    PIPELINE_PHASE: 'style_guide'
  });
  res.status(202).json({ jobId: job.id });
});

app.post('/api/creative-code/review-ui', (req, res) => {
  if (activeJobId !== null) {
    res.status(429).json({ error: 'Un job studio est déjà en cours.' });
    return;
  }
  const body = req.body as {
    outputFolder?: unknown;
    adFormats?: unknown;
    imageSearchProvider?: unknown;
  };
  const imageProviderParsed = parseImageSearchProviderFromBody(body.imageSearchProvider);
  if (!imageProviderParsed.ok) {
    res.status(400).json({ error: imageProviderParsed.error });
    return;
  }
  const folderParsed = parseOutputFolderBody(body);
  if (!folderParsed.ok) {
    res.status(400).json({ error: folderParsed.error });
    return;
  }
  const styleGuideJson = join(outputDir, folderParsed.folder, 'style-guide.json');
  if (!existsSync(styleGuideJson)) {
    res.status(400).json({ error: 'outputFolder must contain style-guide.json.' });
    return;
  }
  const codeDir = resolveCodeDirectory(join(outputDir, folderParsed.folder));
  if (codeDir === null || !existsSync(join(codeDir, 'index.html'))) {
    res.status(400).json({
      error: 'outputFolder must contain at least one creative code version (run creative generation first).'
    });
    return;
  }

  const presetList = loadAdFormatPresets(repoRoot);
  const adFormatsPath = join(outputDir, folderParsed.folder, 'creative-native-ad-formats.json');
  let adFormatsJson: string;
  if (body.adFormats !== undefined) {
    const normalized = normalizeApiAdFormats(body.adFormats, presetList);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    adFormatsJson = JSON.stringify(normalized.formats);
  } else if (existsSync(adFormatsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(adFormatsPath, 'utf8')) as { adFormats?: unknown };
      if (!Array.isArray(parsed.adFormats)) {
        res.status(400).json({ error: 'creative-native-ad-formats.json is invalid.' });
        return;
      }
      const normalized = normalizeApiAdFormats(parsed.adFormats, presetList);
      if (!normalized.ok) {
        res.status(400).json({ error: normalized.error });
        return;
      }
      adFormatsJson = JSON.stringify(normalized.formats);
    } catch {
      res.status(400).json({ error: 'creative-native-ad-formats.json is not valid JSON.' });
      return;
    }
  } else {
    const first = presetList[0];
    if (first === undefined) {
      res.status(500).json({ error: 'No ad format presets configured.' });
      return;
    }
    adFormatsJson = JSON.stringify([ { id: first.id, width: first.width, height: first.height } ]);
  }

  const uiReviewPath = join(agentsDir, 'run-creative-native-ui-review.mts');
  if (!existsSync(uiReviewPath)) {
    res.status(500).json({ error: 'run-creative-native-ui-review.mts is missing from src/agents/.' });
    return;
  }

  const job = createJob(imageProviderParsed.provider, 'creative');
  activeJobId = job.id;
  job.outputDirectoryPath = join(outputDir, folderParsed.folder);
  attachSpawnedNodeProcess(job, [ uiReviewPath, folderParsed.folder ], {
    ...imageSearchProviderEnv(imageProviderParsed.provider),
    PIPELINE_PHASE: 'creative',
    CREATIVE_AD_FORMATS: adFormatsJson,
    CREATIVE_UI_REVIEW_MAX_ROUNDS: '2',
    CREATIVE_SCREENSHOT_PROFILE: 'fast'
  });
  res.status(202).json({ jobId: job.id });
});

app.get('/api/studio/catalog', (_req, res) => {
  try {
    res.json({
      styleGuideScripts: listStyleGuideScripts(),
      creativeCodeScripts: listCreativeCodeScripts(),
      outputFoldersWithStyleGuide: listOutputFoldersWithStyleGuide(),
      capabilities: {
        preflightReferenceUrl: true
      }
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/style-guide/stream/:jobId', (req, res) => {
  const jobId = req.params['jobId'];
  if (jobId === undefined || jobId.length === 0) {
    res.status(400).end();
    return;
  }
  const job = jobs.get(jobId);
  if (job === undefined) {
    res.status(404).json({ error: 'Unknown jobId.' });
    return;
  }
  attachSubscriber(job, res);
});

app.get('/api/output/:folderName/pipeline-usage', (req, res) => {
  const folderName = req.params['folderName'];
  if (folderName === undefined || !isSafeOutputFolderSegment(folderName)) {
    res.status(400).json({ error: 'Invalid folder name.' });
    return;
  }
  const usagePath = pipelineUsagePath(join(outputDir, folderName));
  if (!existsSync(usagePath)) {
    res.status(404).json({ error: 'pipeline-usage.json not found for this output folder.' });
    return;
  }
  try {
    res.json(JSON.parse(readFileSync(usagePath, 'utf8')) as unknown);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/output/index-html-previews', (_req, res) => {
  try {
    res.json({ previews: listOutputIndexHtmlPreviews() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.use('/output', Express.static(outputDir));

app.listen(PORT, (err: Error | undefined) => {
  if (err !== undefined) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Style guide studio API listening on http://localhost:${String(PORT)}`);
});
