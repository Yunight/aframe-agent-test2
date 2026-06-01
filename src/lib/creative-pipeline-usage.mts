import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PipelineAction =
  | 'style_guide'
  | 'assets_review'
  | 'assets_refresh'
  | 'asset_descriptions'
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

export function appendFromCreativeNativeTokenFile (
  directoryPath: string,
  action: 'creative_generation' | 'creative_regeneration',
  reviewRound: number | null
): void {
  const tokenPath = join(directoryPath, 'creative-native-token-usage.json');
  if (!existsSync(tokenPath)) {
    return;
  }
  const raw = JSON.parse(readFileSync(tokenPath, 'utf8')) as {
    api_calls?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    model?: string;
    price_usd?: PriceUsd;
    duration_ms_total?: number;
    turn_timings?: Array<{ turn: number; duration_ms: number; stop_reason: string | null }>;
  };
  const acc: UsageAccumulator = {
    api_calls: raw.api_calls ?? 1,
    input_tokens: raw.input_tokens ?? 0,
    output_tokens: raw.output_tokens ?? 0,
    cache_creation_input_tokens: raw.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: raw.cache_read_input_tokens ?? 0
  };
  const model =
    typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : 'claude-opus-4-6';
  const apiCallTimings =
    raw.turn_timings !== undefined && raw.turn_timings.length > 0
      ? codegenTurnTimingsToApiCallTimings(raw.turn_timings)
      : undefined;
  const entry = entryFromAccumulator({
    action,
    agent: 'agents/gen-creative-code-native.mts',
    model,
    acc,
    phase: 'creative',
    review_round: reviewRound,
    ...(raw.duration_ms_total !== undefined ? { duration_ms: raw.duration_ms_total } : {}),
    ...(apiCallTimings !== undefined ? { api_call_timings: apiCallTimings } : {})
  });
  const logged = appendPipelineUsage(directoryPath, entry);
  logPipelineUsageToConsole(logged.entries[logged.entries.length - 1]!);
}
