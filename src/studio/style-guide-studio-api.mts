import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import Express from 'express';
import { loadAdFormatPresets, normalizeApiAdFormats } from '../lib/studio-ad-formats.mts';
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

interface Job {
  id: string;
  status: JobStatus;
  lines: Array<{ source: 'stdout' | 'stderr'; text: string }>;
  exitCode: number | null;
  outputDirectoryPath: string | null;
  subscribers: Set<Express.Response>;
}

const jobs = new Map<string, Job>();
let activeJobId: string | null = null;

function createJob (): Job {
  const id = randomUUID();
  const job: Job = {
    id,
    status: 'running',
    lines: [],
    exitCode: null,
    outputDirectoryPath: null,
    subscribers: new Set()
  };
  jobs.set(id, job);
  return job;
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
}

/** Runs that have style-guide.json but no creative `code/` yet (for gen-creative-code target). */
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
    const codeDir = join(folderPath, 'code');
    if (existsSync(codeDir) && statSync(codeDir).isDirectory()) {
      continue;
    }
    entries.push({
      folderName: dirent.name,
      mtimeMs: statSync(sg).mtimeMs
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

    pushLine(job, 'stdout', `[studio] Step ${String(stepIndex)}/${String(steps.length)}: ${resolvedArgv.join(' ')}`);

    const child = spawn(process.execPath, resolvedArgv, {
      cwd: repoRoot,
      env: {
        ...process.env,
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
      const exitCode = signal !== null ? 1 : (code ?? 1);
      if (exitCode !== 0) {
        finishJob(job, exitCode);
        return;
      }
      runNextStep();
    });

    child.on('error', (err) => {
      pushLine(job, 'stderr', `[spawn error] ${err.message}`);
      finishJob(job, 1);
    });
  };

  runNextStep();
}

interface OutputIndexPreview {
  folderName: string;
  /** Path relative to `output/` (e.g. `<uuid>/code/index.html`). */
  relativePath: string;
  /** Same-origin path when UI is proxied (e.g. `/output/...`). */
  previewUrl: string;
  mtimeMs: number;
  /** Text of the first `<title>` in the HTML file (for display). */
  pageTitle: string;
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

function listOutputIndexHtmlPreviews (): OutputIndexPreview[] {
  const entries: OutputIndexPreview[] = [];
  if (!existsSync(outputDir)) {
    return entries;
  }
  for (const dirent of readdirSync(outputDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) {
      continue;
    }
    const base = join(outputDir, dirent.name);
    const codeHtml = join(base, 'code', 'index.html');
    const rootHtml = join(base, 'index.html');
    let relativePath: string | null = null;
    let abs: string | null = null;
    if (existsSync(codeHtml)) {
      relativePath = `${dirent.name}/code/index.html`;
      abs = codeHtml;
    } else if (existsSync(rootHtml)) {
      relativePath = `${dirent.name}/index.html`;
      abs = rootHtml;
    }
    if (relativePath !== null && abs !== null) {
      const fromFile = readPageTitleFromIndexHtml(abs);
      const pageTitle = fromFile ?? dirent.name;
      entries.push({
        folderName: dirent.name,
        relativePath,
        previewUrl: `/output/${relativePath}`,
        mtimeMs: statSync(abs).mtimeMs,
        pageTitle
      });
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

const app = Express();
app.use(corsMiddleware);
app.use(Express.json({ limit: `${MAX_CONTEXT_CHARS + 10_000}` }));

app.post('/api/style-guide/run', (req, res) => {
  if (activeJobId !== null) {
    res.status(429).json({ error: 'Un job studio est déjà en cours.' });
    return;
  }
  const body = req.body as {
    contextPrompt?: unknown;
    brand?: unknown;
    context?: unknown;
    assetsReviewAfterGeneration?: unknown;
  };
  const brandField = typeof body.brand === 'string' ? body.brand : '';
  const contextField = typeof body.context === 'string' ? body.context : '';
  const hasBrandOrContext = brandField.trim().length > 0 || contextField.trim().length > 0;

  let contextPrompt: string;
  if (hasBrandOrContext) {
    contextPrompt = composeStyleGuideContextFromParts(brandField, contextField);
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

  const styleScriptPath = join(agentsDir, DEFAULT_STYLE_SCRIPT);
  if (!existsSync(styleScriptPath)) {
    res.status(500).json({ error: `${DEFAULT_STYLE_SCRIPT} is missing from src/agents/.` });
    return;
  }

  const assetsReviewAfterGeneration = body.assetsReviewAfterGeneration === true;
  const assetsReviewPath = join(agentsDir, 'run-creative-native-assets-review.mts');

  const job = createJob();
  activeJobId = job.id;

  if (assetsReviewAfterGeneration) {
    if (!existsSync(assetsReviewPath)) {
      res.status(500).json({ error: 'run-creative-native-assets-review.mts is missing from src/agents/.' });
      return;
    }
    attachSpawnedNodeProcessSequence(job, [
      {
        argv: [ styleScriptPath ],
        env: { STYLE_GUIDE_CONTEXT: contextPrompt }
      },
      {
        argv: (activeJob) => {
          const folder = outputFolderNameFromDirectoryPath(activeJob.outputDirectoryPath);
          return folder !== null ? [ assetsReviewPath, folder ] : null;
        }
      }
    ]);
  } else {
    attachSpawnedNodeProcess(job, [ styleScriptPath ], {
      STYLE_GUIDE_CONTEXT: contextPrompt
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
  };
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
  const codeDir = join(outputDir, outputFolder, 'code');
  if (existsSync(codeDir) && statSync(codeDir).isDirectory()) {
    res.status(400).json({ error: 'outputFolder already has a code/ directory; creative output already exists.' });
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

  const assetsReviewRequested =
    body.assetsReviewBeforeGeneration === true && creativeScript === 'gen-creative-code-native.mts';
  const uiReviewRequested =
    body.uiReviewAfterGeneration === true && creativeScript === 'gen-creative-code-native.mts';

  const job = createJob();
  activeJobId = job.id;
  const creativePath = join(agentsDir, creativeScript);
  const assetsReviewPath = join(agentsDir, 'run-creative-native-assets-review.mts');
  const uiReviewPath = join(agentsDir, 'run-creative-native-ui-review.mts');

  const genStep = {
    argv: [ creativePath, outputFolder ],
    env: {
      CREATIVE_AD_FORMATS: adFormatsJson,
      CREATIVE_UI_REVIEW_MAX_ROUNDS: '0'
    }
  };

  const sequenceSteps: Array<{ argv: string[]; env?: Record<string, string> }> = [];

  if (assetsReviewRequested) {
    sequenceSteps.push({ argv: [ assetsReviewPath, outputFolder ] });
  }
  sequenceSteps.push(genStep);
  if (uiReviewRequested) {
    sequenceSteps.push({
      argv: [ uiReviewPath, outputFolder ],
      env: {
        CREATIVE_AD_FORMATS: adFormatsJson,
        CREATIVE_UI_REVIEW_MAX_ROUNDS: '3'
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

app.get('/api/studio/catalog', (_req, res) => {
  try {
    res.json({
      styleGuideScripts: listStyleGuideScripts(),
      creativeCodeScripts: listCreativeCodeScripts(),
      outputFoldersWithStyleGuide: listOutputFoldersWithStyleGuide()
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
