import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { withAnthropicRetry } from './anthropic-retry.mts';
import {
  appendPipelineUsage,
  entryFromSingleUsage,
  logPipelineUsageToConsole,
  priceUsdFromTokens,
  timedAnthropicCall,
  type PriceUsd
} from './creative-pipeline-usage.mts';
import {
  assetsReviewOutputSchema,
  logAssetsReviewAuditToConsole,
  type AssetsReviewOutput,
  type AssetsReviewUsageTotals
} from '../agents/creative-native-assets-review.mts';
import { listAssetImageFiles } from './asset-sidecar-files.mts';
import { readLogoFileAsAnthropicImageBlock } from './logo-rasterize.mts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

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
  const subBrand = brandName.length > 0 && companyName.length > 0 &&
    brandName.toLowerCase() !== companyName.toLowerCase();

  const systemPrompt = [
    'You are a strict brand logo auditor before HTML5 ad code generation.',
    'You receive PNG screenshots of logo files plus a JSON style guide.',
    'Evaluate whether each logos/ file is the SAME brand lockup as the official header on brandURL (campaign brand), not merely the parent retailer.',
    'Rules:',
    ...(subBrand
      ? [
          `- SUB-BRAND CAMPAIGN: brandName is "${brandName}" but companyName is "${companyName}".`,
          `  * BLOCKER if the logo shows only the parent company lockup (e.g. "${companyName}" wordmark) without "${brandName}".`,
          `  * Accept only logos that display "${brandName}" or its official sub-brand wordmark/icon from brandURL.`
        ]
      : []),
    '- BLOCKER if the logo is a different brand, homonym, or unrelated acronym (e.g. "NET" TV network vs "Matériel.net" retailer).',
    '- BLOCKER if the logo does not display brandName or its recognizable official icon+wordmark.',
    '- BLOCKER if colors/shape clearly contradict the style guide palette and known brand identity.',
    '- BLOCKER if the file is a product packshot, generic homonym wordmark, or third-party scraper asset.',
    '- BLOCKER if filename suggests wrong brand (e.g. NET_Logo_1970.svg for Matériel.net).',
    '- Accept official wordmarks on opaque dark/light backgrounds (Tier B PNG) when brand text/icon is clearly correct.',
    '- WARN only for minor padding/contrast issues when the brand identity is clearly correct.',
    'Set satisfied to true only when there are zero blocker findings.',
    'For each blocker, suggest concrete logo search queries in brave_retry_queries.logos (site:official_host preferred; include the current calendar year in some queries to find the latest logo).',
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
