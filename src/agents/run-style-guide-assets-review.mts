/**
 * Post–style-guide assets review: JSON + logo (lock after OK) + products.
 * Lightweight: max 2 deterministic rounds, Haiku only if products still blocked.
 *
 * Usage: node src/agents/run-style-guide-assets-review.mts <directory-uuid>
 */

import type { StyleGuide } from './gen-style-guide.mjs';
import {
  buildLogoSearchQueries,
  buildProductSearchQueriesFromFindings,
  imageContextFromStyleGuide,
  refreshAssetsFromQueries
} from '../lib/brave-image-assets.mts';
import {
  assertImageSearchProviderConfigured,
  imageSearchLogPrefix,
  resolveImageSearchProvider
} from '../lib/image-search.mts';
import {
  logDeterministicFindings,
  pruneInvalidLogos,
  pruneListingIneligibleProducts,
  pruneNonWordmarkLogos,
  pruneUndersizedAssets,
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
import {
  assetDescriptionsPath,
  describeApprovedAssets
} from '../lib/creative-asset-descriptions.mts';
import { listAssetImageFiles } from '../lib/asset-sidecar-files.mts';
import { logoLockExists, writeLogoLock } from '../lib/logo-lock.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import {
  buildBraveRetryQueriesFromAudit,
  runCreativeNativeAssetsReview,
  writeAssetsReviewRoundReport,
  type AssetsReviewOutput
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
const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<
StyleGuide,
'logoFileUrls' | 'productPictureUrls'
>;

const maxRounds = parseStyleGuideReviewMaxRounds();
const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
let imageContext = imageContextFromStyleGuide(styleGuide);

let reviewRound = 0;
let lastAudit: AssetsReviewOutput | null = null;
let logoLocked = logoLockExists(directoryPath);

function countProductFiles (): number {
  return listAssetImageFiles(directoryPath, 'products').length;
}

function countLogoFiles (): number {
  return listAssetImageFiles(directoryPath, 'logos').length;
}

async function refreshProductsOnly (
  productQueries: string[],
  round: number,
  notes: string
): Promise<void> {
  if (productQueries.length === 0) {
    return;
  }
  const refreshStartedAt = Date.now();
  await refreshAssetsFromQueries(directoryPath, imageContext, { logos: [], products: productQueries }, {});
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

async function tryApproveAndLockLogo (): Promise<boolean> {
  if (logoLocked) {
    return true;
  }
  const det = await runDeterministicAssetsCheck(directoryPath, styleGuide);
  const logoBlockers = det.findings.filter(
    (f) =>
      f.severity === 'blocker' &&
      (f.asset_id.startsWith('logos/') || f.asset_id === 'logos')
  );
  if (logoBlockers.length === 0 && countLogoFiles() >= 1) {
    writeLogoLock(directoryPath, {
      approved_at: new Date().toISOString(),
      source: 'deterministic'
    });
    logoLocked = true;
    console.log('[style-guide-review] Logo approved and locked.');
    return true;
  }
  if (logoBlockers.length > 0) {
    logDeterministicFindings(logoBlockers);
  }
  return false;
}

function productOnlyBlockers (findings: { severity: string; asset_id: string }[]): boolean {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return false;
  }
  return blockers.every((f) => f.asset_id.startsWith('products/'));
}

console.log(`[style-guide-review] Max rounds: ${String(maxRounds)}`);

if (logoLocked) {
  console.log('[style-guide-review] Logo already approved — skipping logo refresh.');
} else {
  await tryApproveAndLockLogo();
}

while (reviewRound < maxRounds) {
  reviewRound += 1;
  console.log(`[style-guide-review] Round ${String(reviewRound)}/${String(maxRounds)}`);

  mkdirSync(reviewDirectoryPath, { recursive: true });
  pruneListingIneligibleProducts(directoryPath, styleGuide);
  await pruneUndersizedAssets(directoryPath);
  if (!logoLocked) {
    await pruneNonWordmarkLogos(directoryPath);
    await pruneInvalidLogos(directoryPath);
  }

  if (!logoLocked) {
    const logoOk = await tryApproveAndLockLogo();
    if (!logoOk && reviewRound < maxRounds) {
      console.log('[style-guide-review] Logo refresh (once)…');
      const refreshStartedAt = Date.now();
      await refreshAssetsFromQueries(
        directoryPath,
        imageContext,
        { logos: buildLogoSearchQueries(imageContext), products: [] },
        {}
      );
      appendPipelineUsage(
        directoryPath,
        entryZeroCost({
          action: 'assets_refresh',
          agent: 'agents/run-style-guide-assets-review.mts',
          review_round: reviewRound,
          phase: 'style_guide',
          duration_ms: Date.now() - refreshStartedAt,
          notes: 'logo-only refresh'
        })
      );
      styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
      imageContext = imageContextFromStyleGuide(styleGuide);
      continue;
    }
  }

  const deterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
  logDeterministicFindings(deterministic.findings);

  if (deterministic.ok) {
    console.log('[style-guide-review] Deterministic checks passed.');
    lastAudit = {
      satisfied: true,
      summary: 'Deterministic OK',
      findings: [],
      brave_retry_queries: { logos: [], products: [] }
    };
    break;
  }

  if (productOnlyBlockers(deterministic.findings) && reviewRound < maxRounds) {
    const productQueries = buildProductSearchQueriesFromFindings(
      imageContext,
      deterministic.findings,
      lastAudit?.brave_retry_queries.products
    );
    console.log('[style-guide-review] Product blockers — Brave refresh (products only)…');
    await refreshProductsOnly(productQueries, reviewRound, 'products-only refresh');
    continue;
  }

  if (reviewRound >= maxRounds) {
    break;
  }

  const hasProductBlockers = deterministic.findings.some(
    (f) => f.severity === 'blocker' && f.asset_id.startsWith('products/')
  );
  if (!hasProductBlockers) {
    break;
  }

  console.log('[style-guide-review] Product blockers — Haiku vision (single pass)…');
  const { audit, usage } = await runCreativeNativeAssetsReview({
    anthropicClient,
    directoryPath,
    prunedStyleGuide,
    reviewRound
  });
  lastAudit = audit;
  writeAssetsReviewRoundReport(reviewDirectoryPath, reviewRound, {
    audit,
    usage,
    deterministic_ok: deterministic.ok
  });

  if (audit.satisfied) {
    break;
  }

  const retryQueries = buildBraveRetryQueriesFromAudit(audit, imageContext);
  const products = buildProductSearchQueriesFromFindings(
    imageContext,
    audit.findings,
    retryQueries.products
  );
  if (products.length > 0) {
    await refreshProductsOnly(products, reviewRound, 'post-haiku products refresh');
  }
}

const finalDeterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
const satisfied =
  finalDeterministic.ok &&
  (logoLocked || countLogoFiles() >= 1) &&
  (lastAudit?.satisfied ?? finalDeterministic.ok);

let assetDescriptionsRel: string | null = null;
if (satisfied) {
  const productCount = countProductFiles();
  const skipDescribe = process.env['STYLE_GUIDE_SKIP_ASSET_DESCRIPTIONS']?.trim() === '1';
  try {
    const describeResult = await describeApprovedAssets({
      anthropicClient,
      directoryPath,
      styleGuide
    });
    if (existsSync(assetDescriptionsPath(directoryPath))) {
      assetDescriptionsRel = 'review/asset-descriptions.json';
    }
    if (productCount > 0 && describeResult === null && !skipDescribe) {
      throw new Error(
        'Product images present but asset-descriptions.json was not written. Re-run review or fix describe step.'
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (productCount > 0 && !skipDescribe) {
      console.error(`[style-guide-review] Asset descriptions failed: ${msg}`);
      process.exit(1);
    }
    console.warn(`[style-guide-review] Asset descriptions skipped or failed: ${msg}`);
  }
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
