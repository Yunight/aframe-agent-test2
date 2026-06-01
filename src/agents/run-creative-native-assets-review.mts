/**
 * Pre-flight review: style guide + logos/products before creative generation.
 * Deterministic checks + Haiku vision; Brave refresh on blockers.
 *
 * Usage: node src/agents/run-creative-native-assets-review.mts <directory-uuid>
 */

import type { StyleGuide } from './gen-style-guide.mjs';
import {
  appendBraveExcludedUrls,
  buildLogoSearchQueriesFromFindings,
  buildProductSearchQueriesFromFindings,
  imageContextFromStyleGuide,
  loadBraveExcludedUrls,
  mergeRefreshIntoStyleGuideFile,
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
  logPipelineUsageToConsole,
  logPipelineTotalsToConsole,
  pipelineUsagePath,
  recomputePhaseTotals,
  type PipelineUsageFile
} from '../lib/creative-pipeline-usage.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import {
  buildBraveRetryQueriesFromAudit,
  parseAssetsReviewMaxRoundsFromEnv,
  runCreativeNativeAssetsReview,
  writeAssetsReviewRoundReport,
  writeAssetsReviewTokenUsage,
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
  console.error('Usage: node src/agents/run-creative-native-assets-review.mts <directory-uuid>');
  process.exit(2);
}
const directoryUuid: string = directoryUuidArg;

const directoryPath = join(repoRoot, 'output', directoryUuid);
const reviewDirectoryPath = join(directoryPath, 'review');
const styleGuidePath = join(directoryPath, 'style-guide.json');

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
  `${imageSearchLogPrefix()} Active provider=${resolveImageSearchProvider()} ` +
    `(CREATIVE_IMAGE_SEARCH_PROVIDER=${process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'] ?? '(unset)'})`
);

let styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<
StyleGuide,
'logoFileUrls' | 'productPictureUrls'
>;

const maxRounds = parseAssetsReviewMaxRoundsFromEnv();
if (maxRounds <= 0) {
  console.error('CREATIVE_ASSETS_REVIEW_MAX_ROUNDS must be > 0 for this script.');
  process.exit(2);
}

const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
let imageContext = imageContextFromStyleGuide(styleGuide);

let excludedUrls = loadBraveExcludedUrls(reviewDirectoryPath);

const usageRounds: AssetsReviewUsageTotals[] = [];
let reviewRound = 0;
let lastAudit: AssetsReviewOutput | null = null;

console.log(`[assets-review-agent] Max rounds: ${String(maxRounds)}`);

function productOnlyBlockers (
  findings: { severity: string; asset_id: string }[]
): boolean {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return false;
  }
  return blockers.every((f) => f.asset_id.startsWith('products/'));
}

function logoOnlyBlockers (
  findings: { severity: string; asset_id: string }[]
): boolean {
  const blockers = findings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return false;
  }
  return blockers.every((f) => f.asset_id.startsWith('logos/') || f.asset_id === 'logos');
}

async function runBraveRefresh (
  queries: { logos: string[]; products: string[] },
  round: number
): Promise<boolean> {
  const hasLogoQueries = queries.logos.length > 0;
  const hasProductQueries = queries.products.length > 0;
  if (!hasLogoQueries && !hasProductQueries) {
    return false;
  }

  console.log('[assets-review-agent] Brave asset refresh…');
  const refreshStartedAt = Date.now();
  const refresh = await refreshAssetsFromQueries(directoryPath, imageContext, queries, {
    excludeUrls: excludedUrls
  });
  const refreshDurationMs = Date.now() - refreshStartedAt;

  if (refresh.rejectedUrls.length > 0) {
    excludedUrls = appendBraveExcludedUrls(
      reviewDirectoryPath,
      excludedUrls,
      refresh.rejectedUrls
    );
  }

  styleGuide = mergeRefreshIntoStyleGuideFile(directoryPath, styleGuide, refresh);
  imageContext = imageContextFromStyleGuide(styleGuide);

  const notes = `logos=${String(refresh.downloaded.logos)} products=${String(refresh.downloaded.products)}`;
  const file = appendPipelineUsage(
    directoryPath,
    entryZeroCost({
      action: 'assets_refresh',
      agent: 'lib/brave-image-assets.mts',
      review_round: round,
      phase: 'creative',
      notes,
      duration_ms: refreshDurationMs
    })
  );
  logPipelineUsageToConsole(file.entries[file.entries.length - 1]!);

  if (hasLogoQueries && hasProductQueries) {
    return refresh.downloaded.logos >= 1 && refresh.downloaded.products >= 1;
  }
  if (hasProductQueries) {
    return refresh.downloaded.products >= 1;
  }
  return refresh.downloaded.logos >= 1;
}

while (reviewRound < maxRounds) {
  reviewRound += 1;
  console.log(`[assets-review-agent] Round ${String(reviewRound)}/${String(maxRounds)}`);

  mkdirSync(reviewDirectoryPath, { recursive: true });
  await pruneUndersizedAssets(directoryPath);
  await pruneNonWordmarkLogos(directoryPath);
  await pruneInvalidLogos(directoryPath);

  const deterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
  logDeterministicFindings(deterministic.findings);

  if (!deterministic.ok && reviewRound < maxRounds) {
    const productsOnly = productOnlyBlockers(deterministic.findings);
    const logosOnly = logoOnlyBlockers(deterministic.findings);
    const productQueries = buildProductSearchQueriesFromFindings(
      imageContext,
      deterministic.findings,
      lastAudit?.brave_retry_queries.products
    );
    const logoQueries = buildLogoSearchQueriesFromFindings(
      imageContext,
      deterministic.findings,
      lastAudit?.brave_retry_queries.logos
    );
    const refreshQueries = productsOnly
      ? { logos: [] as string[], products: productQueries }
      : logosOnly
        ? { logos: logoQueries, products: [] as string[] }
        : {
            logos: logoQueries,
            products: productQueries
          };
    console.log(
      '[assets-review-agent] Deterministic blockers — Brave refresh (targeted queries)…'
    );
    const refreshed = await runBraveRefresh(refreshQueries, reviewRound);
    if (refreshed) {
      styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
      imageContext = imageContextFromStyleGuide(styleGuide);
      continue;
    }
  }

  const deterministicSummary =
    deterministic.findings.length > 0
      ? deterministic.findings.map((f) => `[${f.severity}] ${f.asset_id}: ${f.issue}`).join('\n')
      : undefined;

  const { audit, usage } = await runCreativeNativeAssetsReview({
    anthropicClient,
    directoryPath,
    prunedStyleGuide,
    reviewRound,
    ...(deterministicSummary !== undefined ? { deterministicFindingsSummary: deterministicSummary } : {})
  });

  usageRounds.push(usage);
  lastAudit = audit;

  writeAssetsReviewRoundReport(reviewDirectoryPath, reviewRound, {
    audit,
    usage,
    deterministic_ok: deterministic.ok
  });

  if (audit.satisfied && deterministic.ok) {
    console.log('[assets-review-agent] Satisfied.');
    break;
  }

  if (reviewRound >= maxRounds) {
    console.log('[assets-review-agent] Max rounds reached without satisfaction.');
    break;
  }

  const retryQueries = buildBraveRetryQueriesFromAudit(audit, imageContext);
  const products = buildProductSearchQueriesFromFindings(
    imageContext,
    audit.findings,
    retryQueries.products
  );
  const logos = buildLogoSearchQueriesFromFindings(
    imageContext,
    audit.findings,
    retryQueries.logos
  );
  const refreshed = await runBraveRefresh({ logos, products }, reviewRound);
  if (!refreshed) {
    console.warn('[assets-review-agent] Brave refresh did not download enough assets; continuing to next round.');
  }
  styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
}

let postAuditRefreshDone = false;
if (lastAudit !== null && !lastAudit.satisfied) {
  const retryQueries = buildBraveRetryQueriesFromAudit(lastAudit, imageContext);
  const products = buildProductSearchQueriesFromFindings(
    imageContext,
    lastAudit.findings,
    retryQueries.products
  );
  const logos = buildLogoSearchQueriesFromFindings(
    imageContext,
    lastAudit.findings,
    retryQueries.logos
  );
  if (logos.length > 0 || products.length > 0) {
    console.log('[assets-review-agent] Post-audit Brave refresh (Haiku retry queries)…');
    postAuditRefreshDone = true;
    await pruneUndersizedAssets(directoryPath);
    await pruneNonWordmarkLogos(directoryPath);
  await pruneInvalidLogos(directoryPath);
    await runBraveRefresh({ logos, products }, reviewRound + 1);
    styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;

    const postDeterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
    logDeterministicFindings(postDeterministic.findings);

    if (postDeterministic.ok) {
      const { audit, usage } = await runCreativeNativeAssetsReview({
        anthropicClient,
        directoryPath,
        prunedStyleGuide,
        reviewRound: reviewRound + 1
      });
      usageRounds.push(usage);
      lastAudit = audit;
      writeAssetsReviewRoundReport(reviewDirectoryPath, reviewRound + 1, {
        audit,
        usage,
        deterministic_ok: postDeterministic.ok
      });
    }
  }
}

writeAssetsReviewTokenUsage(reviewDirectoryPath, usageRounds);

const finalDeterministic = await runDeterministicAssetsCheck(directoryPath, styleGuide);
const satisfied =
  (lastAudit?.satisfied ?? false) && finalDeterministic.ok && lastAudit !== null;

writeFileSync(
  join(reviewDirectoryPath, 'assets-review-final.json'),
  `${JSON.stringify(
    {
      assets_review_rounds_run: reviewRound + (postAuditRefreshDone ? 1 : 0),
      max_assets_review_rounds: maxRounds,
      post_audit_refresh: postAuditRefreshDone,
      satisfied,
      summary: lastAudit?.summary ?? null,
      findings: lastAudit?.findings ?? [],
      brave_retry_queries: lastAudit?.brave_retry_queries ?? { logos: [], products: [] },
      pipeline_usage_path: pipelineUsagePath(directoryPath)
    },
    null,
    2
  )}\n`,
  { encoding: 'utf8' }
);

const scriptTotalMs = Date.now() - scriptRunStart;
console.log(`[assets-review-agent] Script total : ${formatDurationMinSec(scriptTotalMs)}`);
appendPipelineRunSummary(directoryPath, { wall_clock_ms: scriptTotalMs });
logPipelineTotalsToConsole(directoryPath);
if (existsSync(pipelineUsagePath(directoryPath))) {
  const phaseFile = JSON.parse(readFileSync(pipelineUsagePath(directoryPath), 'utf8')) as PipelineUsageFile;
  logPhaseTotalsToConsole(recomputePhaseTotals(phaseFile.entries));
}
console.log(`Output directory path: ${directoryPath}`);

if (!satisfied) {
  console.error(
    '[assets-review-agent] Assets not approved. Fix manually or re-run this script before gen-creative-code-native.'
  );
  process.exit(1);
}
