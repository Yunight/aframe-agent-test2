/**
 * Agent review UI (Playwright screenshots + Haiku vision).
 * Boucle jusqu'à satisfaction ou CREATIVE_UI_REVIEW_MAX_ROUNDS (défaut 3).
 * Relance gen-creative-code-native.mts avec feedback si des blockers subsistent.
 *
 * Usage : node src/agents/run-creative-native-ui-review.mts <directory-uuid>
 * Prérequis : output/<uuid>/code/…/index.html (Vn ou legacy) et style-guide.json
 */

import type { StyleGuide } from './gen-style-guide.mjs';
import { captureCreativeNativeScreenshots } from '../lib/creative-native-playwright-screenshots.mts';
import { loadDesignSkillGuidance } from '../lib/creative-native-skills.mts';
import {
  appendPipelineRunSummary,
  formatDurationMinSec,
  logPhaseTotalsToConsole,
  logPipelineTotalsToConsole,
  pipelineUsagePath,
  recomputePhaseTotals,
  type PipelineUsageFile
} from '../lib/creative-pipeline-usage.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import {
  buildRegenerationUserMessage,
  parseUiReviewMaxRoundsFromEnv,
  runCreativeNativeUiReview,
  writeUiReviewRoundReport,
  writeUiReviewTokenUsage,
  type UiReviewOutput,
  type UiReviewUsageTotals
} from './creative-native-ui-review.mts';
import { loadAdFormatPresets, parseCreativeAdFormatsFromEnv, type AdFormatSelection } from '../lib/studio-ad-formats.mts';
import {
  buildStrictMinimalRegenSuffix,
  resolveRegenModelFromUiAudit
} from '../lib/creative-native-ui-review-regen.mts';
import {
  isCaptureOrDomBlockerAudit,
  tryDeterministicCaptureFixes
} from '../lib/creative-native-regen-deterministic.mts';
import {
  isRegenDiffGuardEnabled,
  logRegenDiffSummary,
  reconcileRegenWithBaseline,
  snapshotCodeBundleForDiff,
  writeRegenBaselineSnapshot
} from '../lib/creative-native-regen-diff.mts';
import { latestCodeVersion } from '../lib/creative-code-versions.mts';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';

const repoRoot = repoRootFromModuleDir(import.meta.dirname);
loadDotenv({ path: join(repoRoot, '.env') });
const scriptRunStart = Date.now();

const directoryUuidArg = process.argv[2];
if (directoryUuidArg === undefined || directoryUuidArg.startsWith('--')) {
  console.error('Usage: node src/agents/run-creative-native-ui-review.mts <directory-uuid>');
  process.exit(2);
}
const directoryUuid: string = directoryUuidArg;

const directoryPath = join(repoRoot, 'output', directoryUuid);
const codeVersion = latestCodeVersion(directoryPath);
if (codeVersion === null) {
  console.error(`Missing creative code under ${join(directoryPath, 'code')}`);
  process.exit(2);
}
const codeDirectoryPath = codeVersion.directoryPath;
const regenCodeVersionId = codeVersion.versionId;
console.log(`[ui-review-agent] Code version: ${codeVersion.versionLabel} (${regenCodeVersionId})`);
const reviewDirectoryPath = join(directoryPath, 'review');
const screenshotsDirectoryPath = join(reviewDirectoryPath, 'screenshots');
const styleGuidePath = join(directoryPath, 'style-guide.json');
const adFormatsPath = join(directoryPath, 'creative-native-ad-formats.json');

if (!existsSync(styleGuidePath)) {
  console.error(`Missing style guide: ${styleGuidePath}`);
  process.exit(2);
}
if (!existsSync(join(codeDirectoryPath, 'index.html'))) {
  console.error(`Missing index.html in code version directory: ${codeDirectoryPath}`);
  process.exit(2);
}

const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY.');
}

const adFormatPresets = loadAdFormatPresets(repoRoot);
let adFormats: readonly AdFormatSelection[];
if (existsSync(adFormatsPath)) {
  const parsed = JSON.parse(readFileSync(adFormatsPath, 'utf8')) as { adFormats?: unknown };
  adFormats = Array.isArray(parsed.adFormats)
    ? (parsed.adFormats as AdFormatSelection[])
    : parseCreativeAdFormatsFromEnv(process.env['CREATIVE_AD_FORMATS'], adFormatPresets);
} else {
  adFormats = parseCreativeAdFormatsFromEnv(process.env['CREATIVE_AD_FORMATS'], adFormatPresets);
}

const styleGuide = JSON.parse(readFileSync(styleGuidePath, 'utf8')) as StyleGuide;
const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<
StyleGuide,
'logoFileUrls' | 'productPictureUrls'
>;

const maxUiReviewRounds = parseUiReviewMaxRoundsFromEnv();
if (maxUiReviewRounds <= 0) {
  console.error('CREATIVE_UI_REVIEW_MAX_ROUNDS must be > 0 for this script.');
  process.exit(2);
}

const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
const skillGuidance = loadDesignSkillGuidance(repoRoot);
const genScriptPath = join(repoRoot, 'src', 'agents', 'gen-creative-code-native.mts');
const assetInputMode = process.env['CREATIVE_ASSET_INPUT']?.trim() === 'base64' ? 'base64' : 'url';

function runNativeRegeneration (params: {
  feedback: string;
  reviewRound: number;
  regenModel: string;
  beforeSnapshots: Record<string, string> | null;
  strictMinimal: boolean;
}): { exitCode: number; likelyFullRewrite: boolean } {
  const baselineDir = join(reviewDirectoryPath, 'regen-baseline');
  if (params.beforeSnapshots !== null) {
    writeRegenBaselineSnapshot(codeDirectoryPath, baselineDir);
  }

  const result = spawnSync(
    process.execPath,
    [ genScriptPath, directoryUuid, '--asset-input', assetInputMode ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CREATIVE_REGEN_FEEDBACK: params.feedback,
        CREATIVE_REGEN_MODEL: params.regenModel,
        CREATIVE_REGEN_REVIEW_ROUND: String(params.reviewRound),
        CREATIVE_REGEN_STRICT_MINIMAL: params.strictMinimal ? '1' : '0',
        CREATIVE_ASSETS_REVIEW_SKIP: '1',
        CREATIVE_UI_REVIEW_MAX_ROUNDS: '0',
        CREATIVE_AD_FORMATS: JSON.stringify(adFormats),
        CREATIVE_CODE_VERSION: regenCodeVersionId
      },
      stdio: 'inherit'
    }
  );
  const exitCode = result.status ?? 1;
  if (exitCode !== 0 || params.beforeSnapshots === null || !isRegenDiffGuardEnabled()) {
    return { exitCode, likelyFullRewrite: false };
  }

  const reconciled = reconcileRegenWithBaseline(codeDirectoryPath, params.beforeSnapshots);
  logRegenDiffSummary(reconciled);
  if (reconciled.restoredFiles.length > 0) {
    console.warn(
      `[ui-review-agent] Restored files after oversized regen: ${reconciled.restoredFiles.join(', ')}`
    );
  }
  return { exitCode, likelyFullRewrite: reconciled.likelyFullRewrite };
}

const uiReviewUsageRounds: UiReviewUsageTotals[] = [];
let uiReviewRound = 0;
let lastUiAudit: UiReviewOutput | null = null;

console.log(`[ui-review-agent] Max rounds: ${String(maxUiReviewRounds)}`);

while (uiReviewRound < maxUiReviewRounds) {
  uiReviewRound += 1;
  console.log(`[ui-review-agent] Round ${String(uiReviewRound)}/${String(maxUiReviewRounds)}`);

  mkdirSync(screenshotsDirectoryPath, { recursive: true });
  const manifest = await captureCreativeNativeScreenshots({
    codeDirectoryPath,
    adFormats,
    outputScreensDir: screenshotsDirectoryPath,
    directoryPath,
    reviewRound: uiReviewRound
  });

  const { audit, usage } = await runCreativeNativeUiReview({
    anthropicClient,
    manifest,
    screenshotsDir: screenshotsDirectoryPath,
    directoryPath,
    prunedStyleGuide,
    adFormats,
    skillGuidance,
    reviewRound: uiReviewRound
  });

  uiReviewUsageRounds.push(usage);
  lastUiAudit = audit;

  writeUiReviewRoundReport(reviewDirectoryPath, uiReviewRound, {
    audit,
    usage,
    manifestPath: join(screenshotsDirectoryPath, 'manifest.json')
  });

  if (audit.satisfied) {
    console.log('[ui-review-agent] Satisfied.');
    break;
  }

  if (uiReviewRound >= maxUiReviewRounds) {
    console.log('[ui-review-agent] Max rounds reached without satisfaction.');
    break;
  }

  if (isCaptureOrDomBlockerAudit(audit)) {
    const deterministic = tryDeterministicCaptureFixes(codeDirectoryPath, adFormats);
    if (deterministic.applied) {
      console.log(
        `[ui-review-agent] Deterministic capture fix (no LLM): ${deterministic.details.join('; ')}`
      );
      continue;
    }
  }

  const beforeSnapshots = isRegenDiffGuardEnabled()
    ? snapshotCodeBundleForDiff(codeDirectoryPath)
    : null;
  let feedback = buildRegenerationUserMessage(audit, adFormats, uiReviewRound);
  let regenModel = resolveRegenModelFromUiAudit(audit);
  console.log(`[ui-review-agent] Regenerating (model ${regenModel})…`);

  let { exitCode: regenExit, likelyFullRewrite } = runNativeRegeneration({
    feedback,
    reviewRound: uiReviewRound,
    regenModel,
    beforeSnapshots,
    strictMinimal: false
  });

  if (regenExit === 0 && likelyFullRewrite && beforeSnapshots !== null) {
    console.warn('[ui-review-agent] Regen changed too much — retrying with strict minimal patch (Sonnet).');
    feedback = `${feedback}${buildStrictMinimalRegenSuffix()}`;
    regenModel = resolveRegenModelFromUiAudit(audit, { strictMinimalRetry: true });
    const retry = runNativeRegeneration({
      feedback,
      reviewRound: uiReviewRound,
      regenModel,
      beforeSnapshots,
      strictMinimal: true
    });
    regenExit = retry.exitCode;
    likelyFullRewrite = retry.likelyFullRewrite;
    if (retry.exitCode === 0 && retry.likelyFullRewrite) {
      console.warn(
        '[ui-review-agent] Strict regen still exceeded diff threshold; kept reconciled (baseline) files.'
      );
    }
  }

  if (regenExit !== 0) {
    console.error(`[ui-review-agent] Regeneration failed with exit code ${String(regenExit)}.`);
    process.exit(regenExit);
  }
}

writeUiReviewTokenUsage(reviewDirectoryPath, uiReviewUsageRounds);

let pipelineTotalsUsd: { total: number } | null = null;
const pipelinePath = pipelineUsagePath(directoryPath);
if (existsSync(pipelinePath)) {
  const pipelineFile = JSON.parse(readFileSync(pipelinePath, 'utf8')) as {
    totals?: { price_usd?: { total: number } };
  };
  pipelineTotalsUsd = pipelineFile.totals?.price_usd ?? null;
}

writeFileSync(
  join(reviewDirectoryPath, 'ui-review-final.json'),
  `${JSON.stringify(
    {
      ui_review_rounds_run: uiReviewRound,
      max_ui_review_rounds: maxUiReviewRounds,
      satisfied: lastUiAudit?.satisfied ?? false,
      summary: lastUiAudit?.summary ?? null,
      findings: lastUiAudit?.findings ?? [],
      screenshots_dir: screenshotsDirectoryPath,
      pipeline_usage_path: pipelinePath,
      pipeline_totals_usd: pipelineTotalsUsd
    },
    null,
    2
  )}\n`,
  { encoding: 'utf8' }
);

const scriptTotalMs = Date.now() - scriptRunStart;
console.log(`[ui-review-agent] Script total : ${formatDurationMinSec(scriptTotalMs)}`);
appendPipelineRunSummary(directoryPath, { wall_clock_ms: scriptTotalMs });
logPipelineTotalsToConsole(directoryPath);
if (existsSync(pipelinePath)) {
  const phaseFile = JSON.parse(readFileSync(pipelinePath, 'utf8')) as PipelineUsageFile;
  logPhaseTotalsToConsole(recomputePhaseTotals(phaseFile.entries));
}

console.log(`Output directory path: ${directoryPath}`);

if (lastUiAudit !== null && !lastUiAudit.satisfied) {
  process.exit(1);
}
