import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PipelineAction =
  | 'style_guide'
  | 'assets_review'
  | 'assets_refresh'
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
  duration_ms?: number;
};

export type PipelineUsageFile = {
  directoryUuid: string;
  updated_at: string;
  entries: PipelineUsageEntry[];
  totals: {
    api_calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    billed_input_tokens: number;
    price_usd: PriceUsd;
  };
};

const DEFAULT_OPUS_INPUT_USD_PER_M = 5;
const DEFAULT_OPUS_OUTPUT_USD_PER_M = 25;
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

function recomputeTotals (entries: PipelineUsageEntry[]): PipelineUsageFile['totals'] {
  const totals = {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    billed_input_tokens: 0,
    price_usd: { input: 0, output: 0, total: 0 }
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
  }
  totals.price_usd.input = roundUsd6(totals.price_usd.input);
  totals.price_usd.output = roundUsd6(totals.price_usd.output);
  totals.price_usd.total = roundUsd6(totals.price_usd.total);
  return totals;
}

export function appendPipelineUsage (
  directoryPath: string,
  entry: Omit<PipelineUsageEntry, 'timestamp'> & { timestamp?: string }
): PipelineUsageFile {
  const directoryUuid = directoryPath.split(/[/\\]/).pop() ?? directoryPath;
  const path = pipelineUsagePath(directoryPath);
  let file: PipelineUsageFile;
  if (existsSync(path)) {
    file = JSON.parse(readFileSync(path, 'utf8')) as PipelineUsageFile;
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
    duration_ms?: number;
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
    ...(params.duration_ms !== undefined ? { duration_ms: params.duration_ms } : {})
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
    ...(params.notes !== undefined ? { notes: params.notes } : {})
  };
}

export function entryZeroCost (
  params: {
    action: PipelineAction;
    agent: string;
    review_round?: number | null;
    notes?: string;
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
    ...(params.notes !== undefined ? { notes: params.notes } : {})
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
    console.log(`duration : ${String(entry.duration_ms)} ms`);
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
  const file = JSON.parse(readFileSync(path, 'utf8')) as PipelineUsageFile;
  console.log('=== pipeline usage totals ===');
  console.log(`entries : ${String(file.entries.length)}`);
  console.log(`billed input tokens : ${String(file.totals.billed_input_tokens)}`);
  console.log(`output tokens : ${String(file.totals.output_tokens)}`);
  console.log(`total price (USD) : ${String(file.totals.price_usd.total)}`);
  console.log('');
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
  usage: UsageLike | null | undefined
): void {
  console.log(`call reason : ${callReason}`);
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
  const entry = entryFromAccumulator({
    action,
    agent: 'agents/gen-creative-code-native.mts',
    model,
    acc,
    review_round: reviewRound
  });
  const logged = appendPipelineUsage(directoryPath, entry);
  logPipelineUsageToConsole(logged.entries[logged.entries.length - 1]!);
}
