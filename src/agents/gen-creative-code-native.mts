import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import type { StyleGuide } from './gen-style-guide.mjs';
import { runCreativeCodegen } from '../lib/creative-native-codegen-loop.mts';
import {
  formatExistingBundleForPrompt,
  loadExistingCodeBundle
} from '../lib/creative-native-codegen-regen.mts';
import {
  buildCampaignProductHeroInstruction,
  loadSkillsForCodegenPrompt,
  resolveCreativeModel
} from '../lib/creative-native-codegen-prompt.mts';
import { buildCodegenAssetPromptBlocks } from '../lib/creative-asset-descriptions.mts';
import {
  appendPipelineUsage,
  codegenTurnTimingsToApiCallTimings,
  entryFromAccumulator,
  formatDurationMinSec,
  logAnthropicUsageAndCost,
  logPhaseTotalsToConsole,
  logPipelineUsageToConsole,
  priceUsdFromAccumulator,
  recomputePhaseTotals
} from '../lib/creative-pipeline-usage.mts';
import {
  allocateNextCodeVersionDirectory,
  resolveCodeDirectory
} from '../lib/creative-code-versions.mts';
import { loadAdFormatPresets, parseCreativeAdFormatsFromEnv } from '../lib/studio-ad-formats.mts';
import { basename, dirname, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';

loadDotenv({ path: join(repoRootFromModuleDir(import.meta.dirname), '.env') });

const directoryUuid = process.argv[2];

if (directoryUuid === undefined) {
  throw new Error('Missing project directory UUID.');
}

const cliArguments = process.argv.slice(3);
for (let i = 0; i < cliArguments.length; i += 1) {
  const argument = cliArguments[i];
  if (argument === '--asset-input') {
    const value = cliArguments[i + 1];
    if (value === 'base64') {
      console.warn(
        '[creative-native] --asset-input base64 is ignored; generation uses precomputed text descriptions only (no vision blocks to Opus).'
      );
    }
    i += 1;
    continue;
  }
  throw new Error(`Unknown argument "${argument}". Allowed option: --asset-input (url only effective).`);
}

const repoRoot = repoRootFromModuleDir(import.meta.dirname);
const directoryPath = join(repoRoot, 'output', directoryUuid);

const assetsReviewSkip = process.env['CREATIVE_ASSETS_REVIEW_SKIP']?.trim() === '1';
const assetsReviewFinalPath = join(directoryPath, 'review', 'assets-review-final.json');
if (!assetsReviewSkip) {
  if (!existsSync(assetsReviewFinalPath)) {
    throw new Error(
      `Assets review required before creative generation. Run the style guide studio job with "Review assets après génération", ` +
        `or: node src/agents/run-style-guide-assets-review.mts ${directoryUuid}\n` +
        'Or set CREATIVE_ASSETS_REVIEW_SKIP=1 to bypass (not recommended).'
    );
  }
  const assetsFinal = JSON.parse(readFileSync(assetsReviewFinalPath, 'utf8')) as { satisfied?: boolean };
  if (assetsFinal.satisfied !== true) {
    throw new Error(
      `Assets review not satisfied (${assetsReviewFinalPath}). Re-run: node src/agents/run-style-guide-assets-review.mts ${directoryUuid}`
    );
  }
}

const regenFeedbackEarly = process.env['CREATIVE_REGEN_FEEDBACK']?.trim();
const isRegenEarly = regenFeedbackEarly !== undefined && regenFeedbackEarly.length > 0;
let codeDirectoryPath: string;
if (isRegenEarly) {
  const versionHint = process.env['CREATIVE_CODE_VERSION']?.trim();
  const resolved = resolveCodeDirectory(directoryPath, versionHint ?? undefined);
  if (resolved === null) {
    throw new Error(
      `No creative code version to patch under ${join(directoryPath, 'code')}. Run a full generation first.`
    );
  }
  codeDirectoryPath = resolved;
} else {
  const allocated = allocateNextCodeVersionDirectory(directoryPath);
  codeDirectoryPath = allocated.directoryPath;
  console.log(
    `[creative-native] New code version ${allocated.versionId} → ${allocated.directoryPath}`
  );
}
const adFormatPresets = loadAdFormatPresets(repoRoot);
const adFormats = parseCreativeAdFormatsFromEnv(process.env['CREATIVE_AD_FORMATS'], adFormatPresets);
console.log('[creative-native] Ad formats:', JSON.stringify(adFormats));
const styleGuidePath = join(directoryPath, 'style-guide.json');
const styleGuide = JSON.parse(readFileSync(styleGuidePath, { encoding: 'utf8' })) as StyleGuide;

const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const anthropicClient = new Anthropic({
  apiKey: anthropicApiKey
});
const skillsText = loadSkillsForCodegenPrompt(repoRoot);

const { fileMessages, assetFiles } = await buildCodegenAssetPromptBlocks({
  directoryPath,
  styleGuide
});

const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<
StyleGuide,
'logoFileUrls' | 'productPictureUrls'
>;
delete (prunedStyleGuide as { logoFileUrls?: unknown }).logoFileUrls;
delete (prunedStyleGuide as { productPictureUrls?: unknown }).productPictureUrls;

const baseMessages: Anthropic.Messages.MessageParam[] = [{
  role: 'user',
  content: [
    ...fileMessages,
    {
      type: 'text',
      text: buildCampaignProductHeroInstruction(prunedStyleGuide)
    },
    {
      type: 'text',
      text: JSON.stringify(prunedStyleGuide)
    }
  ]
}];

const regenFeedback = process.env['CREATIVE_REGEN_FEEDBACK']?.trim();
const isRegen = regenFeedback !== undefined && regenFeedback.length > 0;
const activeModel = resolveCreativeModel(isRegen);
console.log(`[creative-native] Model: ${activeModel} (${isRegen ? 'regeneration' : 'generation'})`);

const messages = [ ...baseMessages ];
if (isRegen) {
  const existingBundle = loadExistingCodeBundle(codeDirectoryPath);
  const truncated = existingBundle.files.some((f) => f.truncated);
  if (truncated) {
    console.warn('[creative-native] Regen: one or more code files truncated for prompt context.');
  }
  messages.push({
    role: 'user',
    content: formatExistingBundleForPrompt(existingBundle)
  });
  messages.push({ role: 'user', content: regenFeedback });
  if (process.env['CREATIVE_REGEN_STRICT_MINIMAL']?.trim() === '1') {
    messages.push({
      role: 'user',
      content:
        'STRICT MINIMAL PATCH: Change only the lines required by the feedback. '
        + 'Do not rewrite styles.css. Typical fix is under 15 lines total across all files.'
    });
  }
  console.log('[creative-native] Corrective regen: patching existing index.html, styles.css, app.js.');
}

const genStart = Date.now();
const codegenResult = await runCreativeCodegen({
  anthropicClient,
  model: activeModel,
  isRegen,
  repoRoot,
  skillsText,
  baseMessages: messages,
  adFormats,
  prunedStyleGuide,
  assetFiles
});
const durationMsTotal = Date.now() - genStart;

const codeFileList = codegenResult.files;
const creativeUsageTotals = codegenResult.usage;

mkdirSync(codeDirectoryPath, { recursive: true });

for (const codeFile of codeFileList) {
  const filePath = join(codeDirectoryPath, codeFile.fileName);
  const fileDirectoryPath = dirname(filePath);

  mkdirSync(fileDirectoryPath, { recursive: true });
  writeFileSync(filePath, codeFile.fileContent, { encoding: 'utf8' });
}

for (const assetFile of assetFiles) {
  const destinationPath = join(codeDirectoryPath, assetFile.fileName);
  copyFileSync(assetFile.filePath, destinationPath);
}

const sumReportedTokens =
  creativeUsageTotals.input_tokens +
  creativeUsageTotals.output_tokens +
  creativeUsageTotals.cache_creation_input_tokens +
  creativeUsageTotals.cache_read_input_tokens;

logAnthropicUsageAndCost(
  basename(import.meta.filename, extname(import.meta.filename)),
  creativeUsageTotals,
  activeModel
);

const cumulativePrices = priceUsdFromAccumulator(creativeUsageTotals, activeModel);
writeFileSync(
  join(directoryPath, 'creative-native-token-usage.json'),
  `${JSON.stringify({
    ...creativeUsageTotals,
    model: activeModel,
    total_tokens_reported_sum: sumReportedTokens,
    price_usd: cumulativePrices,
    duration_ms_total: durationMsTotal,
    turn_timings: codegenResult.timings
  }, null, 2)}\n`,
  { encoding: 'utf8' }
);

const regenRoundRaw = process.env['CREATIVE_REGEN_REVIEW_ROUND']?.trim();
const regenRound =
  regenRoundRaw !== undefined && regenRoundRaw.length > 0 ? Number.parseInt(regenRoundRaw, 10) : null;
const apiCallTimings = codegenTurnTimingsToApiCallTimings(codegenResult.timings);
const pipelineEntry = entryFromAccumulator({
  action: isRegen ? 'creative_regeneration' : 'creative_generation',
  agent: 'agents/gen-creative-code-native.mts',
  model: activeModel,
  acc: creativeUsageTotals,
  phase: 'creative',
  review_round: Number.isFinite(regenRound ?? Number.NaN) ? regenRound : null,
  duration_ms: durationMsTotal,
  api_call_timings: apiCallTimings
});
const pipelineFile = appendPipelineUsage(directoryPath, pipelineEntry);
logPipelineUsageToConsole(pipelineFile.entries[pipelineFile.entries.length - 1]!);
logPhaseTotalsToConsole(recomputePhaseTotals(pipelineFile.entries));

writeFileSync(
  join(directoryPath, 'creative-native-ad-formats.json'),
  `${JSON.stringify({ adFormats }, null, 2)}\n`,
  { encoding: 'utf8' }
);

console.log(
  `[creative-native] Phase format de pub (génération) : ${formatDurationMinSec(durationMsTotal)}`
);
console.log(`Output directory path: ${directoryPath}`);
