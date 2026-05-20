/**
 * Agent review UI (Playwright screenshots + Haiku vision).
 * Boucle jusqu'à satisfaction ou CREATIVE_UI_REVIEW_MAX_ROUNDS (défaut 3).
 * Relance gen-creative-code-native.mts avec feedback si des blockers subsistent.
 *
 * Usage : node src/run-creative-native-ui-review.mts <directory-uuid>
 * Prérequis : output/<uuid>/code/index.html et style-guide.json
 */

import type { StyleGuide } from './gen-style-guide.mjs';
import { captureCreativeNativeScreenshots } from './creative-native-playwright-screenshots.mts';
import { loadDesignSkillGuidance } from './creative-native-skills.mts';
import {
  buildRegenerationUserMessage,
  parseUiReviewMaxRoundsFromEnv,
  runCreativeNativeUiReview,
  writeUiReviewRoundReport,
  writeUiReviewTokenUsage,
  type UiReviewOutput,
  type UiReviewUsageTotals
} from './creative-native-ui-review.mts';
import { loadAdFormatPresets, parseCreativeAdFormatsFromEnv, type AdFormatSelection } from './studio-ad-formats.mts';
import { spawnSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from '@anthropic-ai/sdk';

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });

const directoryUuidArg = process.argv[2];
if (directoryUuidArg === undefined || directoryUuidArg.startsWith('--')) {
  console.error('Usage: node src/run-creative-native-ui-review.mts <directory-uuid>');
  process.exit(2);
}
const directoryUuid: string = directoryUuidArg;

const repoRoot = join(import.meta.dirname, '..');
const directoryPath = join(repoRoot, 'output', directoryUuid);
const codeDirectoryPath = join(directoryPath, 'code');
const reviewDirectoryPath = join(directoryPath, 'review');
const screenshotsDirectoryPath = join(reviewDirectoryPath, 'screenshots');
const styleGuidePath = join(directoryPath, 'style-guide.json');
const adFormatsPath = join(directoryPath, 'creative-native-ad-formats.json');

if (!existsSync(styleGuidePath)) {
  console.error(`Missing style guide: ${styleGuidePath}`);
  process.exit(2);
}
if (!existsSync(codeDirectoryPath)) {
  console.error(`Missing code directory: ${codeDirectoryPath}`);
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
const genScriptPath = join(repoRoot, 'src', 'gen-creative-code-native.mts');
const assetInputMode = process.env['CREATIVE_ASSET_INPUT']?.trim() === 'base64' ? 'base64' : 'url';

function runNativeRegeneration (feedback: string): number {
  const result = spawnSync(
    process.execPath,
    [ genScriptPath, directoryUuid, '--asset-input', assetInputMode ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CREATIVE_REGEN_FEEDBACK: feedback,
        CREATIVE_UI_REVIEW_MAX_ROUNDS: '0',
        CREATIVE_AD_FORMATS: JSON.stringify(adFormats)
      },
      stdio: 'inherit'
    }
  );
  return result.status ?? 1;
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
    outputScreensDir: screenshotsDirectoryPath
  });

  const { audit, usage } = await runCreativeNativeUiReview({
    anthropicClient,
    manifest,
    screenshotsDir: screenshotsDirectoryPath,
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

  console.log('[ui-review-agent] Regenerating creative code from review feedback…');
  const regenExit = runNativeRegeneration(buildRegenerationUserMessage(audit, adFormats, uiReviewRound));
  if (regenExit !== 0) {
    console.error(`[ui-review-agent] Regeneration failed with exit code ${String(regenExit)}.`);
    process.exit(regenExit);
  }
}

writeUiReviewTokenUsage(reviewDirectoryPath, uiReviewUsageRounds);
writeFileSync(
  join(reviewDirectoryPath, 'ui-review-final.json'),
  `${JSON.stringify(
    {
      ui_review_rounds_run: uiReviewRound,
      max_ui_review_rounds: maxUiReviewRounds,
      satisfied: lastUiAudit?.satisfied ?? false,
      summary: lastUiAudit?.summary ?? null,
      findings: lastUiAudit?.findings ?? [],
      screenshots_dir: screenshotsDirectoryPath
    },
    null,
    2
  )}\n`,
  { encoding: 'utf8' }
);

console.log(`Output directory path: ${directoryPath}`);

if (lastUiAudit !== null && !lastUiAudit.satisfied) {
  process.exit(1);
}
