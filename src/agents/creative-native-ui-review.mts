import { withAnthropicRetry } from '../lib/anthropic-retry.mts';
import type { StyleGuide } from './gen-style-guide.mjs';
import type { ScreenshotManifest } from '../lib/creative-native-playwright-screenshots.mts';
import {
  appendPipelineUsage,
  entryFromSingleUsage,
  logPipelineUsageToConsole,
  priceUsdFromTokens,
  timedAnthropicCall,
  type PriceUsd
} from '../lib/creative-pipeline-usage.mts';
import {
  auditCreativeBundleIntegrity,
  mergeBundleIntegrityIntoUiAudit
} from '../lib/creative-bundle-integrity.mts';
import { buildCreativeAdFormatInstructions, type AdFormatSelection } from '../lib/studio-ad-formats.mts';
import { dirname } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const DEFAULT_UI_REVIEW_MODEL = 'claude-haiku-4-5-20251001';

const findingSchema = z.object({
  format_id: z.string(),
  severity: z.enum([ 'blocker', 'warn' ]),
  issue: z.string(),
  fix_hint: z.string()
});

export const uiReviewOutputSchema = z.object({
  satisfied: z.boolean(),
  summary: z.string(),
  findings: z.array(findingSchema),
  regeneration_prompt: z
    .string()
    .describe(
      'Minimal patch instructions for the code agent: specific CSS/HTML/JS fixes only. '
      + 'Do not ask for a new layout, new concept, or rebuild from scratch. Reference selectors or #ad-{formatId} when relevant.'
    )
});

export type UiReviewOutput = z.infer<typeof uiReviewOutputSchema>;

export function buildRegenerationUserMessage (
  audit: UiReviewOutput,
  adFormats: readonly AdFormatSelection[],
  reviewRound: number
): string {
  const findingsText =
    audit.findings.length > 0
      ? audit.findings
          .map((f) => `- [${f.severity}] ${f.format_id}: ${f.issue} → ${f.fix_hint}`)
          .join('\n')
      : '(no structured findings)';

  const formatIds = adFormats.map((f) => f.id).join(', ');

  return (
    `${audit.regeneration_prompt}\n\n` +
    `Visual UI review (round ${String(reviewRound)}) — **corrective patch only**.\n` +
    `Patch the existing code bundle provided in the previous message. Fix every blocker below.\n` +
    `Do NOT redesign the creative, change the overall layout, add new variants, or rebuild from scratch.\n` +
    `Keep the same DOM structure, class names, and format wrappers unless a blocker requires a structural fix.\n` +
    `Required ad sizes (px): ${adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}.\n` +
    `Format ids: ${formatIds}. Target fixes inside #ad-{formatId} when a finding names a format.\n\n` +
    `Findings:\n${findingsText}\n\n` +
    `Summary: ${audit.summary}`
  );
}

export function parseUiReviewMaxRoundsFromEnv (): number {
  const raw = process.env['CREATIVE_UI_REVIEW_MAX_ROUNDS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 2;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return 2;
  }
  return Math.min(n, 10);
}

export type UiReviewUsageTotals = {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string;
  billed_input_tokens: number;
  price_usd: PriceUsd;
  duration_ms: number;
};

export function logUiReviewAuditToConsole (audit: UiReviewOutput, reviewRound: number): void {
  console.log(`[ui-review] === Audit round ${String(reviewRound)} ===`);
  console.log(`[ui-review] satisfied: ${String(audit.satisfied)}`);
  console.log(`[ui-review] summary: ${audit.summary}`);
  if (audit.findings.length === 0) {
    console.log('[ui-review] findings: (none)');
  } else {
    console.log(`[ui-review] findings (${String(audit.findings.length)}):`);
    for (const f of audit.findings) {
      console.log(`[ui-review]   [${f.severity}] ${f.format_id}: ${f.issue}`);
      console.log(`[ui-review]     fix: ${f.fix_hint}`);
    }
  }
  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0) {
    console.log('[ui-review] regeneration_prompt (extrait):');
    const prompt = audit.regeneration_prompt.trim();
    const lines = prompt.split('\n').slice(0, 12);
    for (const line of lines) {
      console.log(`[ui-review]   ${line}`);
    }
    if (prompt.split('\n').length > 12) {
      console.log('[ui-review]   …');
    }
  } else {
    console.log('[ui-review] regeneration_prompt: (not required — no blockers)');
  }
  console.log('');
}

export function appendUiReviewLog (reviewDir: string, audit: UiReviewOutput, reviewRound: number): void {
  mkdirSync(reviewDir, { recursive: true });
  const logPath = join(reviewDir, 'ui-review.log');
  const lines: string[] = [
    `=== UI review round ${String(reviewRound)} @ ${new Date().toISOString()} ===`,
    `satisfied: ${String(audit.satisfied)}`,
    `summary: ${audit.summary}`,
    ''
  ];
  if (audit.findings.length === 0) {
    lines.push('findings: (none)', '');
  } else {
    lines.push(`findings (${String(audit.findings.length)}):`);
    for (const f of audit.findings) {
      lines.push(`  [${f.severity}] ${f.format_id}`);
      lines.push(`    issue: ${f.issue}`);
      lines.push(`    fix: ${f.fix_hint}`);
    }
    lines.push('');
  }
  lines.push('regeneration_prompt:', audit.regeneration_prompt, '', '');
  appendFileSync(logPath, `${lines.join('\n')}`, { encoding: 'utf8' });
}

export type RunCreativeNativeUiReviewOptions = {
  anthropicClient: Anthropic;
  manifest: ScreenshotManifest;
  screenshotsDir: string;
  directoryPath: string;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  adFormats: readonly AdFormatSelection[];
  skillGuidance: string;
  reviewRound: number;
  model?: string;
};

function readPngAsImageBlock (absolutePath: string): Anthropic.ImageBlockParam | null {
  if (!existsSync(absolutePath)) {
    return null;
  }
  const data = readFileSync(absolutePath).toString('base64');
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data
    }
  };
}

function manifestCaptureErrors (manifest: ScreenshotManifest): string[] {
  const errors: string[] = [];
  for (const entry of manifest.formats) {
    if (entry.error !== null) {
      errors.push(`${entry.format_id}: ${entry.error}`);
    } else if (entry.shots.length === 0) {
      errors.push(`${entry.format_id}: no screenshots captured`);
    }
  }
  return errors;
}

export async function runCreativeNativeUiReview (
  options: RunCreativeNativeUiReviewOptions
): Promise<{ audit: UiReviewOutput; usage: UiReviewUsageTotals }> {
  const {
    anthropicClient,
    manifest,
    screenshotsDir,
    directoryPath,
    prunedStyleGuide,
    adFormats,
    skillGuidance,
    reviewRound
  } = options;
  const reviewDir = join(directoryPath, 'review');

  const model = options.model ?? process.env['CREATIVE_UI_REVIEW_MODEL']?.trim() ?? DEFAULT_UI_REVIEW_MODEL;

  const captureErrors = manifestCaptureErrors(manifest);
  const compactManifest = {
    captured_at: manifest.captured_at,
    entry_url: manifest.entry_url,
    formats: manifest.formats.map((entry) => ({
      format_id: entry.format_id,
      width: entry.width,
      height: entry.height,
      selector: entry.selector,
      error: entry.error,
      shots: entry.shots.map((shot) => ({ state: shot.state, relativePath: shot.relativePath }))
    }))
  };
  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        `Review round ${String(reviewRound)}. Audit the advertisement creatives from the PNG screenshots below.\n` +
        `Each format may have multiple states: initial, animated, settled.\n` +
        `Screenshot manifest:\n${JSON.stringify(compactManifest)}\n` +
        (captureErrors.length > 0
          ? `\nScreenshot capture errors (treat as blockers):\n${captureErrors.join('\n')}\n`
          : '')
    }
  ];

  for (const formatEntry of manifest.formats) {
    for (const shot of formatEntry.shots) {
      const imagePath = join(screenshotsDir, shot.fileName);
      const block = readPngAsImageBlock(imagePath);
      userContent.push({
        type: 'text',
        text: `--- ${formatEntry.format_id} / ${shot.state} (${shot.relativePath}) ---`
      });
      if (block !== null) {
        userContent.push(block);
      } else {
        userContent.push({
          type: 'text',
          text: `(missing file: ${imagePath})`
        });
      }
    }
  }

  const systemPrompt = [
    'You are a strict UI/UX auditor for HTML5 display advertisement creatives.',
    'You receive PNG screenshots of rendered ad units plus a JSON style guide and mandatory design skills.',
    'Evaluate visual quality: logo visibility and scale, typography hierarchy, color adherence to the style guide,',
    'French copy quality, layout at exact pixel dimensions, no fake browser chrome, consistency across formats.',
    'CTA spacing: use severity "warn" only if the primary CTA looks visually flush against the bottom ad frame (no visible gap). Never use blocker for CTA spacing, estimated pixel margins, or "20px" rules. Do not request a full regen for CTA spacing alone — a small CSS padding/margin patch in fix_hint is enough.',
    'Set satisfied to true only when there are zero findings with severity "blocker".',
    'Minor polish issues must use severity "warn" only (never blocker) for polish, taste, or "could be nicer" feedback.',
    '',
    'Patch vs structural (critical for regen):',
    '- Default: corrective PATCH only — CSS tweaks, font-size, colors, copy, img src paths, logo max-height, spacing.',
    '- fix_hint and regeneration_prompt must name concrete selectors or rules (e.g. "#ad-300x600 .hero img { max-height: 180px }").',
    '- NEVER use words: redesign, rebuild, replace entire, from scratch, new layout, new concept, refonte.',
    '- BLOCKER only for: wrong IAB pixel size, missing/broken logo, unreadable text (logo, headline, CTA label, legal/tagline), style-guide color/typography violation, missing required product hero image, fake browser chrome, screenshot capture failure.',
    '- Product image quality: blocker only if no product image is visible or path is wrong; otherwise warn with a specific src/CSS fix.',
    '- Carousel/pagination BLOCKER: pagination dots (slide indicators) present while fewer than 2 distinct visible slides, broken/missing carousel background images, or dots count mismatched with slide count.',
    '- When carousel has <= 1 working slide, dots must be hidden — treat visible orphan dots as a blocker.',
    '- Other carousel/interaction issues: suggest CSS/JS timing or size fixes — not a new carousel design.',
    '',
    'regeneration_prompt: minimal ordered patch list for the code agent (no prose marketing).',
    'Each ad unit keeps id="ad-{formatId}" unless a blocker requires a one-line structural fix.',
    '',
    '--- Ad format requirements ---',
    buildCreativeAdFormatInstructions(adFormats),
    '',
    '--- Pruned style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Local design skills (mandatory) ---',
    skillGuidance
  ].join('\n');
  const systemPromptForRequest: string | Anthropic.Messages.TextBlockParam[] =
    process.env['CREATIVE_PROMPT_CACHE']?.trim() === '0'
      ? systemPrompt
      : [ { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } } ];

  console.log(`[ui-review] Round ${String(reviewRound)} — model ${model}`);

  const roundStart = Date.now();
  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    `ui-review round ${String(reviewRound)}`,
    async () =>
      await withAnthropicRetry(`ui-review round ${String(reviewRound)}`, async () => {
        return await anthropicClient.messages.parse({
          model,
          max_tokens: 8192,
          system: systemPromptForRequest,
          messages: [ { role: 'user', content: userContent } ],
          output_config: {
            format: zodOutputFormat(uiReviewOutputSchema)
          }
        });
      })
  );
  const stepDurationMs = Date.now() - roundStart;

  const parsed = msg.parsed_output;
  if (parsed === null) {
    throw new Error('UI review returned no structured output.');
  }

  const billedInput =
    msg.usage.input_tokens +
    (msg.usage.cache_creation_input_tokens ?? 0) +
    (msg.usage.cache_read_input_tokens ?? 0);
  const price_usd = priceUsdFromTokens(billedInput, msg.usage.output_tokens, model);

  const usage: UiReviewUsageTotals = {
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

  const bundleDir = dirname(manifest.entry_html);
  const integrityFindings = auditCreativeBundleIntegrity({ bundleDir, adFormats });
  if (integrityFindings.length > 0) {
    console.log(`[ui-review] bundle integrity: ${String(integrityFindings.length)} finding(s)`);
    for (const f of integrityFindings) {
      console.log(`[ui-review]   [${f.severity}] ${f.format_id}: ${f.issue}`);
    }
    mergeBundleIntegrityIntoUiAudit(parsed, integrityFindings);
  }

  if (captureErrors.length > 0 && parsed.findings.filter((f) => f.severity === 'blocker').length === 0) {
    parsed.satisfied = false;
    parsed.findings = [
      ...parsed.findings,
      ...captureErrors.map((err) => ({
        format_id: 'capture',
        severity: 'blocker' as const,
        issue: err,
        fix_hint: 'Ensure each required format has a visible element with id="ad-{formatId}" and dimensions match the spec.'
      }))
    ];
    if (parsed.regeneration_prompt.trim().length === 0) {
      parsed.regeneration_prompt =
        'Fix missing or non-capturable ad units. Each format must use id="ad-{formatId}" on the root ad container.';
    }
  }

  const finalBlockers = parsed.findings.filter((f) => f.severity === 'blocker');
  if (finalBlockers.length > 0) {
    parsed.satisfied = false;
  }

  console.log(
    `[ui-review] satisfied=${String(parsed.satisfied)} blockers=${String(finalBlockers.length)} warns=${String(parsed.findings.filter((f) => f.severity === 'warn').length)}`
  );

  logUiReviewAuditToConsole(parsed, reviewRound);
  appendUiReviewLog(reviewDir, parsed, reviewRound);

  const pipelineEntry = entryFromSingleUsage({
    action: 'ui_review',
    agent: 'agents/creative-native-ui-review.mts',
    model,
    usage: msg.usage,
    review_round: reviewRound,
    duration_ms: stepDurationMs,
    api_call_timings: [
      {
        call_index: 1,
        duration_ms: apiDurationMs,
        stop_reason: msg.stop_reason,
        label: `ui-review round ${String(reviewRound)}`
      }
    ]
  });
  const file = appendPipelineUsage(directoryPath, pipelineEntry);
  logPipelineUsageToConsole(file.entries[file.entries.length - 1]!);

  return { audit: parsed, usage };
}

export function writeUiReviewRoundReport (
  reviewDir: string,
  reviewRound: number,
  payload: {
    audit: UiReviewOutput;
    usage: UiReviewUsageTotals;
    manifestPath: string;
  }
): string {
  const reportPath = join(reviewDir, `ui-review-round-${String(reviewRound)}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        review_round: reviewRound,
        captured_at: new Date().toISOString(),
        manifest_path: payload.manifestPath,
        audit: payload.audit,
        usage: payload.usage
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8' }
  );
  return reportPath;
}

export function writeUiReviewTokenUsage (
  reviewDir: string,
  rounds: UiReviewUsageTotals[]
): void {
  const totals = rounds.reduce(
    (acc, row) => {
      acc.api_calls += row.api_calls;
      acc.input_tokens += row.input_tokens;
      acc.output_tokens += row.output_tokens;
      acc.cache_creation_input_tokens += row.cache_creation_input_tokens;
      acc.cache_read_input_tokens += row.cache_read_input_tokens;
      acc.billed_input_tokens += row.billed_input_tokens;
      acc.price_usd.input += row.price_usd.input;
      acc.price_usd.output += row.price_usd.output;
      acc.price_usd.total += row.price_usd.total;
      acc.duration_ms += row.duration_ms;
      return acc;
    },
    {
      api_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      billed_input_tokens: 0,
      price_usd: { input: 0, output: 0, total: 0 },
      duration_ms: 0
    }
  );
  totals.price_usd.input = Math.round(totals.price_usd.input * 1_000_000) / 1_000_000;
  totals.price_usd.output = Math.round(totals.price_usd.output * 1_000_000) / 1_000_000;
  totals.price_usd.total = Math.round(totals.price_usd.total * 1_000_000) / 1_000_000;

  writeFileSync(
    join(reviewDir, 'ui-review-token-usage.json'),
    `${JSON.stringify({ rounds, totals }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
}
