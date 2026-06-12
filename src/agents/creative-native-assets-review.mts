import { withAnthropicRetry } from '../lib/core.mts';
import type { StyleGuide } from './gen-style-guide.mjs';
import { readLogoFileAsAnthropicImageBlock } from '../lib/core.mts';
import { readFileAsAnthropicImageBlock } from '../lib/core.mts';
import {
  appendPipelineUsage,
  entryFromSingleUsage,
  logPipelineUsageToConsole,
  priceUsdFromTokens,
  timedAnthropicCall,
  type PriceUsd
} from '../lib/core.mts';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  maxValidProductAssets,
  minValidProductAssets
} from '../lib/core.mts';
import {
  buildCollaborationLogoAuditRules,
  buildDivisionLineLogoAuditRules,
  buildIndependentSubBrandLogoAuditRules,
  isCollaborationCampaign,
  resolveBrandLogoRelationship,
  resolveLogoSearchNames
} from '../lib/core.mts';

const DEFAULT_ASSETS_REVIEW_MODEL = 'claude-haiku-4-5-20251001';

const findingSchema = z.object({
  asset_id: z.string(),
  severity: z.enum([ 'blocker', 'warn' ]),
  issue: z.string(),
  fix_hint: z.string()
});

export const assetsReviewOutputSchema = z.object({
  satisfied: z.boolean(),
  summary: z.string(),
  findings: z.array(findingSchema),
  brave_retry_queries: z.object({
    logos: z.array(z.string()),
    products: z.array(z.string())
  })
});

export type AssetsReviewOutput = z.infer<typeof assetsReviewOutputSchema>;

export function parseAssetsReviewMaxRoundsFromEnv (): number {
  const raw = process.env['CREATIVE_ASSETS_REVIEW_MAX_ROUNDS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 5;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return 5;
  }
  return Math.min(n, 10);
}

export type AssetsReviewUsageTotals = {
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

export function logAssetsReviewAuditToConsole (audit: AssetsReviewOutput, reviewRound: number): void {
  console.log(`[assets-review] === Audit round ${String(reviewRound)} ===`);
  console.log(`[assets-review] satisfied: ${String(audit.satisfied)}`);
  console.log(`[assets-review] summary: ${audit.summary}`);
  if (audit.findings.length === 0) {
    console.log('[assets-review] findings: (none)');
  } else {
    console.log(`[assets-review] findings (${String(audit.findings.length)}):`);
    for (const f of audit.findings) {
      console.log(`[assets-review]   [${f.severity}] ${f.asset_id}: ${f.issue}`);
      console.log(`[assets-review]     fix: ${f.fix_hint}`);
    }
  }
  const logoQueries = audit.brave_retry_queries.logos;
  const productQueries = audit.brave_retry_queries.products;
  if (logoQueries.length > 0 || productQueries.length > 0) {
    console.log('[assets-review] brave_retry_queries:');
    for (const q of logoQueries) {
      console.log(`[assets-review]   logo: ${q}`);
    }
    for (const q of productQueries) {
      console.log(`[assets-review]   product: ${q}`);
    }
  }
  console.log('');
}

export function appendAssetsReviewLog (
  reviewDir: string,
  audit: AssetsReviewOutput,
  reviewRound: number
): void {
  mkdirSync(reviewDir, { recursive: true });
  const logPath = join(reviewDir, 'assets-review.log');
  const lines: string[] = [
    `=== Assets review round ${String(reviewRound)} @ ${new Date().toISOString()} ===`,
    `satisfied: ${String(audit.satisfied)}`,
    `summary: ${audit.summary}`,
    ''
  ];
  if (audit.findings.length === 0) {
    lines.push('findings: (none)', '');
  } else {
    lines.push(`findings (${String(audit.findings.length)}):`);
    for (const f of audit.findings) {
      lines.push(`  [${f.severity}] ${f.asset_id}`);
      lines.push(`    issue: ${f.issue}`);
      lines.push(`    fix: ${f.fix_hint}`);
    }
    lines.push('');
  }
  lines.push(
    'brave_retry_queries:',
    `  logos: ${JSON.stringify(audit.brave_retry_queries.logos)}`,
    `  products: ${JSON.stringify(audit.brave_retry_queries.products)}`,
    '',
    ''
  );
  appendFileSync(logPath, `${lines.join('\n')}`, { encoding: 'utf8' });
}

function listAssetFiles (directoryPath: string, fileType: 'logos' | 'products'): string[] {
  const subdirectoryPath = join(directoryPath, fileType);
  if (!existsSync(subdirectoryPath)) {
    return [];
  }
  return readdirSync(subdirectoryPath).filter((name) => !name.startsWith('.'));
}

export type RunCreativeNativeAssetsReviewOptions = {
  anthropicClient: Anthropic;
  directoryPath: string;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  reviewRound: number;
  deterministicFindingsSummary?: string;
  model?: string;
};

export async function runCreativeNativeAssetsReview (
  options: RunCreativeNativeAssetsReviewOptions
): Promise<{ audit: AssetsReviewOutput; usage: AssetsReviewUsageTotals }> {
  const { anthropicClient, directoryPath, prunedStyleGuide, reviewRound } = options;
  const reviewDir = join(directoryPath, 'review');

  const model =
    options.model ?? process.env['CREATIVE_ASSETS_REVIEW_MODEL']?.trim() ?? DEFAULT_ASSETS_REVIEW_MODEL;

  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        `Assets review round ${String(reviewRound)}. Audit the brand style guide JSON and the logo/product image files below.\n` +
        `These assets will be used to generate HTML5 display ads — reject assets that would break small banner layouts.\n` +
        `The style guide includes logoImageSearchQueries and productImageSearchQueries used for Brave collection — prefer assets consistent with those official-site targets.\n` +
        (options.deterministicFindingsSummary !== undefined &&
        options.deterministicFindingsSummary.length > 0
          ? `\nDeterministic pre-check notes:\n${options.deterministicFindingsSummary}\n`
          : '')
    }
  ];

  for (const fileType of [ 'logos', 'products' ] as const) {
    const files = listAssetFiles(directoryPath, fileType);
    userContent.push({
      type: 'text',
      text: `--- ${fileType} (${String(files.length)} file(s)) ---`
    });
    for (const fileName of files) {
      const filePath = join(directoryPath, fileType, fileName);
      userContent.push({
        type: 'text',
        text: `Asset: ${fileType}/${fileName}`
      });
      if (!existsSync(filePath)) {
        userContent.push({
          type: 'text',
          text: `(missing file: ${filePath})`
        });
        continue;
      }
      const block =
        fileType === 'logos'
          ? await readLogoFileAsAnthropicImageBlock(filePath)
          : readFileAsAnthropicImageBlock(filePath);
      if (block !== null) {
        userContent.push(block);
      } else {
        userContent.push({
          type: 'text',
          text: `(unreadable or missing: ${filePath})`
        });
      }
    }
  }

  const brandName = prunedStyleGuide.brandName?.trim() ?? '';
  const companyName = prunedStyleGuide.companyName?.trim() ?? '';
  const brandContext = prunedStyleGuide.brandContext?.trim() ?? '';
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

  const systemPrompt = [
    'You are a strict brand asset auditor before HTML5 ad code generation.',
    'You receive a JSON style guide (text) and logo/product image files (raster and possibly SVG logos).',
    'Evaluate:',
    '- logos/ folder must contain ONLY brand wordmark lockups (SVG or PNG), never product packshots or catalog photos.',
    '  * BLOCKER if any file in logos/ looks like a product SKU/packshot (e.g. A04P501D.jpg) — those belong in products/ only.',
    '  * Do NOT accept a product JPEG as a "secondary logo" or alternate brand asset.',
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
    '- Logo (STRICT on source and brand): must match brandName/companyName (reject wrong brands, e.g. homonyms).',
    ...(collaborationCampaign
      ? [
          '  * For collaboration campaigns, brandName names the partnership — do NOT require a single file showing the full composite brandName string.',
          '  * BLOCKER only when a logos/ file is the wrong brand, a composite multi-brand lockup, or fails source checks below.'
        ]
      : divisionLineBrand
        ? [
            `  * ACCEPT the official "${companyName}" wordmark from brandURL/companyURL — do NOT require "${brandName}" regional suffix in the logo file.`
          ]
        : [
            '  * BLOCKER if the logo in logos/ is NOT the same lockup as the brand homepage header (e.g. div.primary-logo / img.logo-simple on brandURL) — wrong file from Brave/generic search.'
          ]),
    '  * BLOCKER if the logo clearly comes from a third-party scraper (KindPNG, PNGaaaa, Pinterest, random blogs) while companyURL/brandURL host an official header lockup.',
    '  * BLOCKER if hostname of the image URL does not match companyURL/brandURL (or their parent domain) unless it is a known official CDN/subdomain of that brand.',
    '  * Accept transparent PNG, opaque PNG/JPEG on brand background, and official SVG wordmarks.',
    '  * Warn (not blocker) for low padding or baked checkerboard; suggest site:official_host queries in brave_retry_queries.',
    collaborationCampaign
      ? '  * brave_retry_queries.logos: one query per missing collaboration party name only — never combined co-branded lockup strings.'
      : '  * brave_retry_queries.logos must use ONLY brand/company names (never productName, campaignContext, partners, countries, or campaign URL slugs).',
    '  * Readable at small banner sizes (min ~120×40px for raster); SVG logos are rasterized to PNG for vision review.',
    `- Product images (products/): need ${String(minValidProductAssets())}–${String(maxValidProductAssets())} files; each must match the campaign subject (brandName, productName, campaignContext, brandContext).`,
    '  * BLOCKER for any off-topic product (wrong franchise, sport, or unrelated brand line) even from the official retailer CDN.',
    '  * BLOCKER when fewer than 3 or more than 5 on-campaign product images remain in products/.',
    '  * Product images must match STYLE_GUIDE_CONTEXT / campaignContext and productName (exact hero model); reject other models from the same brand line-up.',
    '  * BLOCKER for watermarked press blogs, unrelated stock, meme images, or obvious thumbnails/wallpapers when official packshots exist.',
    '  * brave_retry_queries must prioritize site:hostname from brandURL/companyURL and concrete product names — never generic "product photo" alone.',
    '- Style guide: primary colors and typography are plausible and internally consistent; flag empty or generic placeholders.',
    'Set satisfied to true only when there are zero findings with severity "blocker".',
    'For each blocker, suggest concrete Brave image search queries in brave_retry_queries (French or English). Logo queries: brand/company name only; product queries: use productName and campaign context.',
    'Provide at least one logo query and one product query when blockers exist; empty arrays only if satisfied.',
    '',
    '--- Pruned style guide JSON ---',
    JSON.stringify(prunedStyleGuide)
  ].join('\n');

  console.log(`[assets-review] Round ${String(reviewRound)} — model ${model}`);

  const roundStart = Date.now();
  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    `assets-review round ${String(reviewRound)}`,
    async () =>
      await withAnthropicRetry(`assets-review round ${String(reviewRound)}`, async () => {
        return await anthropicClient.messages.parse({
          model,
          max_tokens: 8192,
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
    throw new Error('Assets review returned no structured output.');
  }

  const billedInput =
    msg.usage.input_tokens +
    (msg.usage.cache_creation_input_tokens ?? 0) +
    (msg.usage.cache_read_input_tokens ?? 0);
  const price_usd = priceUsdFromTokens(billedInput, msg.usage.output_tokens, model);

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

  const blockers = parsed.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0) {
    parsed.satisfied = false;
  }

  console.log(
    `[assets-review] satisfied=${String(parsed.satisfied)} blockers=${String(blockers.length)} warns=${String(parsed.findings.filter((f) => f.severity === 'warn').length)}`
  );

  logAssetsReviewAuditToConsole(parsed, reviewRound);
  appendAssetsReviewLog(reviewDir, parsed, reviewRound);

  const pipelineEntry = entryFromSingleUsage({
    action: 'assets_review',
    agent: 'agents/creative-native-assets-review.mts',
    model,
    usage: msg.usage,
    review_round: reviewRound,
    duration_ms: stepDurationMs,
    api_call_timings: [
      {
        call_index: 1,
        duration_ms: apiDurationMs,
        stop_reason: msg.stop_reason,
        label: `assets-review round ${String(reviewRound)}`
      }
    ]
  });
  const file = appendPipelineUsage(directoryPath, pipelineEntry);
  logPipelineUsageToConsole(file.entries[file.entries.length - 1]!);

  return { audit: parsed, usage };
}

export function writeAssetsReviewRoundReport (
  reviewDir: string,
  reviewRound: number,
  payload: {
    audit: AssetsReviewOutput;
    usage: AssetsReviewUsageTotals;
    deterministic_ok: boolean;
  }
): string {
  const reportPath = join(reviewDir, `assets-review-round-${String(reviewRound)}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        review_round: reviewRound,
        captured_at: new Date().toISOString(),
        deterministic_ok: payload.deterministic_ok,
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

export function writeAssetsReviewTokenUsage (
  reviewDir: string,
  rounds: AssetsReviewUsageTotals[]
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
    join(reviewDir, 'assets-review-token-usage.json'),
    `${JSON.stringify({ rounds, totals }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
}

export function buildBraveRetryQueriesFromAudit (
  audit: AssetsReviewOutput,
  context: {
    brandName: string;
    companyName: string;
    productName: string;
    brandURL?: string;
    companyURL?: string;
    logoImageSearchQueries?: string[];
    productImageSearchQueries?: string[];
  }
): { logos: string[]; products: string[] } {
  const brand = context.brandName.trim();
  const product = context.productName.trim();
  const logoNames = resolveLogoSearchNames({
    brandName: context.brandName,
    companyName: context.companyName,
    productName: context.productName
  });
  const primaryLogoName = logoNames[0] ?? context.brandName.trim();
  const logos = [ ...audit.brave_retry_queries.logos, ...(context.logoImageSearchQueries ?? []) ];
  const products = [
    ...audit.brave_retry_queries.products,
    ...(context.productImageSearchQueries ?? [])
  ];

  if (logos.length === 0) {
    const blockers = audit.findings.filter((f) => f.severity === 'blocker' && f.asset_id.startsWith('logos'));
    if (blockers.length > 0) {
      for (const rawUrl of [ context.brandURL, context.companyURL ]) {
        if (rawUrl === undefined || rawUrl.trim().length === 0) {
          continue;
        }
        try {
          const site = new URL(rawUrl.trim()).hostname;
          if (site.length > 0) {
            for (const name of logoNames.length > 0 ? logoNames : [ primaryLogoName ]) {
              logos.push(`${name} logo site:${site}`);
              logos.push(`${name} logo SVG site:${site}`);
            }
          }
        } catch {
          /* ignore invalid URL */
        }
      }
      for (const name of logoNames.length > 0 ? logoNames : [ primaryLogoName ]) {
        logos.push(`${name} official logo SVG`, `${name} logo officiel site officiel`);
      }
    }
  }
  if (products.length === 0) {
    const blockers = audit.findings.filter(
      (f) => f.severity === 'blocker' && f.asset_id.startsWith('products')
    );
    if (blockers.length > 0) {
      if (product.length > 0) {
        products.push(`${brand} ${product} packshot fond blanc`);
      } else {
        products.push(`${brand} produit packshot marketing`);
      }
    }
  }

  return { logos, products };
}
