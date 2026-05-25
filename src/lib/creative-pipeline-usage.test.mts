import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDurationMinSec,
  recomputeTotals,
  sumApiCallDurationMs,
  type PipelineUsageEntry
} from './creative-pipeline-usage.mts';

const baseEntry = (overrides: Partial<PipelineUsageEntry>): PipelineUsageEntry => ({
  action: 'style_guide',
  agent: 'test',
  model: 'claude-haiku-4-5-20251001',
  timestamp: '2026-01-01T10:00:00.000Z',
  review_round: null,
  api_calls: 1,
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  billed_input_tokens: 100,
  price_usd: { input: 0.001, output: 0.0005, total: 0.0015 },
  ...overrides
});

test('formatDurationMinSec', () => {
  assert.equal(formatDurationMinSec(0), '—');
  assert.equal(formatDurationMinSec(37_000), '0:37');
  assert.equal(formatDurationMinSec(411_000), '6:51');
  assert.equal(formatDurationMinSec(90 * 60 * 1000 + 30_000), '90:30');
});

test('recomputeTotals sums duration_ms and claude_api_duration_ms', () => {
  const entries: PipelineUsageEntry[] = [
    baseEntry({
      duration_ms: 10_000,
      api_call_timings: [ { call_index: 1, duration_ms: 8000, label: 'turn 1' } ]
    }),
    baseEntry({
      action: 'ui_review',
      duration_ms: 3000,
      api_call_timings: [
        { call_index: 1, duration_ms: 1200, label: 'round 1' },
        { call_index: 2, duration_ms: 900, label: 'round 2' }
      ]
    })
  ];
  const totals = recomputeTotals(entries);
  assert.equal(totals.duration_ms, 13_000);
  assert.equal(totals.claude_api_duration_ms, 10_100);
  assert.equal(sumApiCallDurationMs(entries[0]?.api_call_timings), 8000);
});

test('recomputeTotals wall_clock_ms from entry timestamps', () => {
  const entries: PipelineUsageEntry[] = [
    baseEntry({ timestamp: '2026-01-01T10:00:00.000Z' }),
    baseEntry({ timestamp: '2026-01-01T10:05:30.000Z', action: 'creative_generation' })
  ];
  const totals = recomputeTotals(entries);
  assert.equal(totals.wall_clock_ms, 330_000);
});
