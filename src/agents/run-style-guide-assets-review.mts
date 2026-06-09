/**
 * Post–style-guide assets review: JSON + logo (lock after OK) + products.
 * Deterministic checks + Haiku vision describe + logo vision audit + text-only descriptions audit.
 *
 * Usage: node src/agents/run-style-guide-assets-review.mts <directory-uuid>
 */

import type { StyleGuide } from './gen-style-guide.mjs';
import {
  appendBraveExcludedUrls,
  buildLogoSearchQueriesFromFindings,
  buildProductSearchQueriesFromFindings,
  imageContextFromStyleGuide,
  loadBraveExcludedUrls,
  officialHostsFromContext,
  refreshAssetsFromQueries
} from '../lib/brave-image-assets.mts';
import {
  assertImageSearchProviderConfigured,
  imageSearchLogPrefix,
  resolveImageSearchProvider
} from '../lib/image-search.mts';
import { runDescriptionsBasedAssetsReview } from '../lib/asset-descriptions-audit.mts';
import { buildProductMatchFields, resolveCampaignAssetProfile } from '../lib/style-guide-context.mts';
import {
  logDeterministicFindings,
  pruneDeterministicBlockedProducts,
  pruneInvalidLogos,
  pruneListingIneligibleProducts,
  pruneNonWordmarkLogos,
  pruneOversizedAssets,
  pruneUndersizedAssets,
  pruneVisionBlockedLogos,
  pruneVisionBlockedProducts,
  runDeterministicAssetsCheck
} from '../lib/creative-native-assets-deterministic.mts';
import {
  appendPipelineRunSummary,
  appendPipelineUsage,
  entryZeroCost,
  formatDurationMinSec,
  logPhaseTotalsToConsole,
  logPipelineTotalsToConsole,
  pipelineUsagePath,
  recomputePhaseTotals,
  type PipelineUsageFile
} from '../lib/creative-pipeline-usage.mts';
import { assetDescriptionsPath } from '../lib/creative-asset-descriptions.mts';
import { listAssetImageFiles } from '../lib/asset-sidecar-files.mts';
import { clearLogoLock, logoLockExists, writeLogoLock } from '../lib/logo-lock.mts';
import { hasLogoBlockers, runLogoVisionAudit, useLogoVisionAudit } from '../lib/logo-vision-audit.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import {
  buildBraveRetryQueriesFromAudit,
  writeAssetsReviewRoundReport,
  type AssetsReviewOutput,
  type AssetsReviewUsageTotals
} from './creative-native-assets-review.mts';
import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';

const repoRoot = repoRootFromModuleDir(import.meta.dirname);
loadDotenv({ path: join(repoRoot, '.env'), override: false });
const scriptRunStart = Date.now();

const directoryUuidArg = process.argv[2];
if (directoryUuidArg === undefined || directoryUuidArg.startsWith('--')) {
  console.error('Usage: node src/agents/run-style-guide-assets-review.mts <directory-uuid>');
  process.exit(2);
}
const directoryUuid: string = directoryUuidArg;

const directoryPath = join(repoRoot, 'output', directoryUuid);
const reviewDirectoryPath = join(directoryPath, 'review');
const styleGuidePath = join(directoryPath, 'style-guide.json');
function parseStyleGuideReviewMaxRounds (): number {
  const raw = process.env['STYLE_GUIDE_ASSETS_REVIEW_MAX_ROUNDS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 2;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

if (!existsSync(styleGuidePath)) {
  console.error(`Missing style guide: ${styleGuidePath}`);
  process.exit(2);
}

const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY.');
}

assertImageSearchProviderConfigured();
console.log(
  `[style-guide-review] ${imageSearchLogPrefix()} provider=${resolveImageSearchProvider()}`
);

let styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
console.log(
  `[style-guide-review] Campaign asset profile: ${resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    campaignAssetProfile: styleGuide.campaignAssetProfile
  }))}`
);
const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<
StyleGuide,
'logoFileUrls' | 'productPictureUrls'
>;

const maxRounds = parseStyleGuideReviewMaxRounds();
const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
let imageContext = imageContextFromStyleGuide(styleGuide);

let reviewRound = 0;
let lastAudit: AssetsReviewOutput | null = null;
let logoLocked = false;
let excludedUrls = loadBraveExcludedUrls(reviewDirectoryPath);

if (useLogoVisionAudit() && logoLockExists(directoryPath)) {
  console.log('[style-guide-review] Clearing pre-vision logo lock — Haiku vision audit required.');
  clearLogoLock(directoryPath);
}

function countProductFiles (): number {
  return listAssetImageFiles(directoryPath, 'products').length;
}

function countLogoFiles (): number {
  return listAssetImageFiles(directoryPath, 'logos').length;
}

async function refreshProductsOnly (
  productQueries: string[],
  round: number,
  notes: string,
  refreshOptions?: { clearProductFolder?: boolean }
): Promise<void> {
  if (productQueries.length === 0) {
    return;
  }
  const refreshStartedAt = Date.now();
  const refresh = await refreshAssetsFromQueries(
    directoryPath,
    imageContext,
    { logos: [], products: productQueries },
    {
      excludeUrls: excludedUrls,
      ...(refreshOptions?.clearProductFolder !== undefined
        ? { clearProductFolder: refreshOptions.clearProductFolder }
        : {})
    }
  );
  if (refresh.rejectedUrls.length > 0) {
    excludedUrls = appendBraveExcludedUrls(
      reviewDirectoryPath,
      excludedUrls,
      refresh.rejectedUrls
    );
  }
  appendPipelineUsage(
    directoryPath,
    entryZeroCost({
      action: 'assets_refresh',
      agent: 'agents/run-style-guide-assets-review.mts',
      review_round: round,
      phase: 'style_guide',
      duration_ms: Date.now() - refreshStartedAt,
      notes
    })
  );
  styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
  imageContext = imageContextFromStyleGuide(styleGuide);
}

function lockLogoAfterVisionAudit (): void {
  if (logoLocked || countLogoFiles() < 1) {
    return;
  }
  writeLogoLock(directoryPath, {
    approved_at: new Date().toISOString(),
    source: 'logo-vision-audit'
  });
  logoLocked = true;
  console.log('[style-guide-review] Logo passed Haiku vision audit — locked.');
}

function hasProductBlockers (findings: { severity: string; asset_id: string }[]): boolean {
  return findings.some(
    (f) => f.severity === 'blocker' && f.asset_id.startsWith('products/')
  );
}

async function refreshLogosOnly (
  logoQueries: string[],
  round: number,
  notes: string
): Promise<void> {
  if (logoQueries.length === 0) {
    return;
  }
  const refreshStartedAt = Date.now();
  const refresh = await refreshAssetsFromQueries(
    directoryPath,
    imageContext,
    { logos: logoQueries, products: [] },
    { excludeUrls: excludedUrls }
  );
  if (refresh.rejectedUrls.length > 0) {
    excludedUrls = appendBraveExcludedUrls(
      reviewDirectoryPath,
      excludedUrls,
      refresh.rejectedUrls
    );
  }
  appendPipelineUsage(
    directoryPath,
    entryZeroCost({
      action: 'assets_refresh',
      agent: 'agents/run-style-guide-assets-review.mts',
      review_round: round,
      phase: 'style_guide',
      duration_ms: Date.now() - refreshStartedAt,
      notes
    })
  );
  styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
  imageContext = imageContextFromStyleGuide(styleGuide);
}

console.log(`[style-guide-review] Max rounds: ${String(maxRounds)}`);

while (reviewRound < maxRounds) {
  reviewRound += 1;
  console.log(`[style-guide-review] Round ${String(reviewRound)}/${String(maxRounds)}`);

  mkdirSync(reviewDirectoryPath, { recursive: true });
  pruneListingIneligibleProducts(directoryPath, styleGuide);
  await pruneOversizedAssets(directoryPath);
  await pruneUndersizedAssets(directoryPath);
  if (!logoLocked) {
    await pruneNonWordmarkLogos(directoryPath);
    await pruneInvalidLogos(directoryPath, officialHostsFromContext(imageContext));
  }

  const deterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
  logDeterministicFindings(deterministic.findings);

  if (!deterministic.ok) {
    if (reviewRound < maxRounds) {
      let retried = false;

      if (
        !hasLogoBlockers(deterministic.findings) &&
        listAssetImageFiles(directoryPath, 'logos').length > 0 &&
        useLogoVisionAudit()
      ) {
        console.log('[style-guide-review] Product blockers — running logo vision audit before retry…');
        const logoVision = await runLogoVisionAudit({
          anthropicClient,
          directoryPath,
          prunedStyleGuide,
          reviewRound,
          phase: 'style_guide'
        });
        const prunedLogos = pruneVisionBlockedLogos(
          directoryPath,
          logoVision.audit.findings,
          styleGuide.logoFileUrls ?? []
        );
        if (prunedLogos.excludedSourceUrls.length > 0) {
          excludedUrls = appendBraveExcludedUrls(
            reviewDirectoryPath,
            excludedUrls,
            prunedLogos.excludedSourceUrls
          );
        }
        if (prunedLogos.removed.length > 0) {
          clearLogoLock(directoryPath);
          logoLocked = false;
          const logoQueries = buildLogoSearchQueriesFromFindings(
            imageContext,
            logoVision.audit.findings,
            logoVision.audit.brave_retry_queries.logos
          );
          if (logoQueries.length > 0) {
            await refreshLogosOnly(logoQueries, reviewRound, 'pre-retry logo vision refresh');
            retried = true;
          }
        }
      }

      if (hasProductBlockers(deterministic.findings)) {
        const prunedProducts = pruneDeterministicBlockedProducts(
          directoryPath,
          deterministic.findings
        );
        if (prunedProducts.excludedSourceUrls.length > 0) {
          excludedUrls = appendBraveExcludedUrls(
            reviewDirectoryPath,
            excludedUrls,
            prunedProducts.excludedSourceUrls
          );
        }
        const productQueries = buildProductSearchQueriesFromFindings(
          imageContext,
          deterministic.findings,
          lastAudit?.brave_retry_queries.products
        );
        if (productQueries.length > 0) {
          console.log('[style-guide-review] Product blockers — Brave refresh (products)…');
          await refreshProductsOnly(productQueries, reviewRound, 'deterministic product refresh');
          retried = true;
        }
      }

      if (hasLogoBlockers(deterministic.findings)) {
        const logoQueries = buildLogoSearchQueriesFromFindings(
          imageContext,
          deterministic.findings,
          lastAudit?.brave_retry_queries.logos
        );
        if (logoQueries.length > 0) {
          console.log('[style-guide-review] Logo blockers — Brave refresh (logos)…');
          await refreshLogosOnly(logoQueries, reviewRound, 'deterministic logo refresh');
          retried = true;
        }
      }

      if (retried) {
        styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
        imageContext = imageContextFromStyleGuide(styleGuide);
        continue;
      }
    }
    break;
  }

  const productCount = countProductFiles();
  let reviewUsage: AssetsReviewUsageTotals;
  try {
    if (productCount === 0) {
      console.log('[style-guide-review] No product files — Haiku logo vision audit only…');
      const logoVision = await runLogoVisionAudit({
        anthropicClient,
        directoryPath,
        prunedStyleGuide,
        reviewRound,
        phase: 'style_guide'
      });
      lastAudit = logoVision.audit;
      reviewUsage =
        logoVision.usage ??
        ({
          api_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          model: '',
          billed_input_tokens: 0,
          price_usd: { input: 0, output: 0, total: 0 },
          duration_ms: 0
        } satisfies AssetsReviewUsageTotals);
    } else {
      console.log('[style-guide-review] Deterministic OK — Haiku describe + descriptions + logo vision audit…');
      const described = await runDescriptionsBasedAssetsReview({
        anthropicClient,
        directoryPath,
        styleGuide,
        prunedStyleGuide,
        reviewRound,
        productFileCount: productCount,
        phase: 'style_guide'
      });
      lastAudit = described.audit;
      reviewUsage = described.auditUsage;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[style-guide-review] Assets review failed: ${msg}`);
    break;
  }

  writeAssetsReviewRoundReport(reviewDirectoryPath, reviewRound, {
    audit: lastAudit,
    usage: reviewUsage,
    deterministic_ok: true
  });

  if (lastAudit.satisfied) {
    lockLogoAfterVisionAudit();
    console.log('[style-guide-review] Descriptions + logo vision audit satisfied.');
    break;
  }

  if (reviewRound >= maxRounds) {
    break;
  }

  const prunedLogos = pruneVisionBlockedLogos(
    directoryPath,
    lastAudit.findings,
    styleGuide.logoFileUrls ?? []
  );
  if (prunedLogos.excludedSourceUrls.length > 0) {
    excludedUrls = appendBraveExcludedUrls(
      reviewDirectoryPath,
      excludedUrls,
      prunedLogos.excludedSourceUrls
    );
  }
  if (prunedLogos.removed.length > 0) {
    clearLogoLock(directoryPath);
    logoLocked = false;
  }

  const pruned = pruneVisionBlockedProducts(directoryPath, lastAudit.findings);
  if (pruned.excludedSourceUrls.length > 0) {
    excludedUrls = appendBraveExcludedUrls(
      reviewDirectoryPath,
      excludedUrls,
      pruned.excludedSourceUrls
    );
  }

  const retryQueries = buildBraveRetryQueriesFromAudit(lastAudit, imageContext);
  const logoQueries = buildLogoSearchQueriesFromFindings(
    imageContext,
    lastAudit.findings,
    retryQueries.logos
  );
  const products = buildProductSearchQueriesFromFindings(
    imageContext,
    lastAudit.findings,
    retryQueries.products
  );

  let retried = false;
  if (hasLogoBlockers(lastAudit.findings) && logoQueries.length > 0) {
    console.log('[style-guide-review] Logo vision blockers — Brave refresh (logos)…');
    await refreshLogosOnly(logoQueries, reviewRound, 'post-logo-vision-audit logos refresh');
    retried = true;
  }

  if (products.length > 0) {
    console.log('[style-guide-review] Descriptions audit blockers — Brave refresh (products)…');
    await refreshProductsOnly(products, reviewRound, 'post-descriptions-audit products refresh', {
      clearProductFolder: false
    });
    retried = true;
  }

  if (retried) {
    continue;
  }
}

const finalDeterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
const satisfied =
  finalDeterministic.ok &&
  logoLocked &&
  countLogoFiles() >= 1 &&
  lastAudit?.satisfied === true;

let assetDescriptionsRel: string | null = null;
if (satisfied && existsSync(assetDescriptionsPath(directoryPath))) {
  assetDescriptionsRel = 'review/asset-descriptions.json';
} else if (satisfied && countProductFiles() > 0) {
  console.warn(
    '[style-guide-review] Satisfied but asset-descriptions.json missing — descriptions step may have been skipped.'
  );
}

writeFileSync(
  join(reviewDirectoryPath, 'assets-review-final.json'),
  `${JSON.stringify(
    {
      review_phase: 'style_guide',
      assets_review_rounds_run: reviewRound,
      max_assets_review_rounds: maxRounds,
      satisfied,
      logo_locked: logoLocked,
      summary: lastAudit?.summary ?? null,
      findings: lastAudit?.findings ?? finalDeterministic.findings,
      asset_descriptions_path: assetDescriptionsRel,
      pipeline_usage_path: pipelineUsagePath(directoryPath)
    },
    null,
    2
  )}\n`,
  { encoding: 'utf8' }
);

const scriptTotalMs = Date.now() - scriptRunStart;
console.log(`[style-guide-review] Script total : ${formatDurationMinSec(scriptTotalMs)}`);
appendPipelineRunSummary(directoryPath, { wall_clock_ms: scriptTotalMs });
logPipelineTotalsToConsole(directoryPath);
if (existsSync(pipelineUsagePath(directoryPath))) {
  const phaseFile = JSON.parse(readFileSync(pipelineUsagePath(directoryPath), 'utf8')) as PipelineUsageFile;
  logPhaseTotalsToConsole(recomputePhaseTotals(phaseFile.entries));
}
console.log(`Output directory path: ${directoryPath}`);

if (!satisfied) {
  console.error('[style-guide-review] Assets not approved for style guide phase.');
  process.exit(1);
}
