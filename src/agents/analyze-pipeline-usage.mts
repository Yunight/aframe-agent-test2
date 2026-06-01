import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';

type UsageEntry = {
  action?: string;
  duration_ms?: number;
  price_usd?: { total?: number };
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type UsageFile = {
  entries?: UsageEntry[];
  totals?: {
    duration_ms?: number;
    price_usd?: { total?: number };
  };
};

type RunSummary = {
  folder: string;
  mtimeMs: number;
  totalDurationMs: number;
  totalPriceUsd: number;
  uiReviewInputTokens: number;
  uiReviewOutputTokens: number;
  creativeDurationMs: number;
};

const repoRoot = repoRootFromModuleDir(import.meta.dirname);
const outputRoot = join(repoRoot, 'output');

const latestN = Number.parseInt(process.env['PIPELINE_BASELINE_LATEST_N']?.trim() ?? '5', 10);
const outPath = process.env['PIPELINE_BASELINE_OUT']?.trim() || join(repoRoot, 'reports', 'pipeline-baseline-latest.json');

if (!existsSync(outputRoot)) {
  throw new Error(`Missing output directory: ${outputRoot}`);
}

const folders = readdirSync(outputRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .map((folder) => {
    const usagePath = join(outputRoot, folder, 'pipeline-usage.json');
    if (!existsSync(usagePath)) {
      return null;
    }
    return { folder, usagePath, mtimeMs: statSync(usagePath).mtimeMs };
  })
  .filter((v): v is { folder: string; usagePath: string; mtimeMs: number } => v !== null)
  .sort((a, b) => b.mtimeMs - a.mtimeMs)
  .slice(0, Number.isFinite(latestN) && latestN > 0 ? latestN : 5);

if (folders.length === 0) {
  throw new Error('No pipeline-usage.json found under output/.');
}

const runs: RunSummary[] = folders.map(({ folder, usagePath, mtimeMs }) => {
  const parsed = JSON.parse(readFileSync(usagePath, 'utf8')) as UsageFile;
  const entries = parsed.entries ?? [];
  const uiReviewEntries = entries.filter((e) => e.action === 'ui_review');
  const creativeEntries = entries.filter((e) => e.action === 'creative_generation' || e.action === 'creative_regeneration');
  return {
    folder,
    mtimeMs,
    totalDurationMs: parsed.totals?.duration_ms ?? 0,
    totalPriceUsd: parsed.totals?.price_usd?.total ?? 0,
    uiReviewInputTokens: uiReviewEntries.reduce(
      (sum, e) => sum + (e.input_tokens ?? 0) + (e.cache_creation_input_tokens ?? 0) + (e.cache_read_input_tokens ?? 0),
      0
    ),
    uiReviewOutputTokens: uiReviewEntries.reduce((sum, e) => sum + (e.output_tokens ?? 0), 0),
    creativeDurationMs: creativeEntries.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0)
  };
});

const totals = runs.reduce(
  (acc, run) => {
    acc.totalDurationMs += run.totalDurationMs;
    acc.totalPriceUsd += run.totalPriceUsd;
    acc.uiReviewInputTokens += run.uiReviewInputTokens;
    acc.uiReviewOutputTokens += run.uiReviewOutputTokens;
    acc.creativeDurationMs += run.creativeDurationMs;
    return acc;
  },
  {
    totalDurationMs: 0,
    totalPriceUsd: 0,
    uiReviewInputTokens: 0,
    uiReviewOutputTokens: 0,
    creativeDurationMs: 0
  }
);

const n = runs.length;
const report = {
  generatedAt: new Date().toISOString(),
  sampleSize: n,
  latestN: Number.isFinite(latestN) && latestN > 0 ? latestN : 5,
  averages: {
    totalDurationMs: Math.round(totals.totalDurationMs / n),
    totalPriceUsd: Number((totals.totalPriceUsd / n).toFixed(6)),
    uiReviewInputTokens: Math.round(totals.uiReviewInputTokens / n),
    uiReviewOutputTokens: Math.round(totals.uiReviewOutputTokens / n),
    creativeDurationMs: Math.round(totals.creativeDurationMs / n)
  },
  runs
};

mkdirSync(join(repoRoot, 'reports'), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`[baseline] wrote ${outPath}`);
