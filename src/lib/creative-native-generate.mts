import { repoRootFromModuleDir } from './repo-paths.mts';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { runCreativeCodegen } from './creative-native-codegen-loop.mts';
import {
  formatExistingBundleForPrompt,
  loadExistingCodeBundle
} from './creative-native-codegen-regen.mts';
import {
  buildCampaignProductHeroInstruction,
  loadSkillsForCodegenPrompt,
  resolveCreativeModel
} from './creative-native-codegen-prompt.mts';
import { buildStyleGuideColorConstraintText } from './style-guide-colors.mts';
import { buildCodegenAssetPromptBlocks } from './creative-asset-descriptions.mts';
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
} from './creative-pipeline-usage.mts';
import {
  allocateNextCodeVersionDirectory,
  resolveCodeDirectory
} from './creative-code-versions.mts';
import { loadAdFormatPresets, parseCreativeAdFormatsFromEnv } from './studio-ad-formats.mts';
import { basename, dirname, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Anthropic } from '@anthropic-ai/sdk';

export type CreativeNativeGenerationOptions = {
  directoryUuid: string;
  repoRoot?: string;
  envOverrides?: NodeJS.ProcessEnv;
};

export type CreativeNativeGenerationResult = {
  directoryPath: string;
  codeDirectoryPath: string;
  activeModel: string;
  isRegen: boolean;
  durationMsTotal: number;
};

export async function runCreativeNativeGeneration (
  options: CreativeNativeGenerationOptions
): Promise<CreativeNativeGenerationResult> {
  const repoRoot = options.repoRoot ?? repoRootFromModuleDir(import.meta.dirname);
  const env = { ...process.env, ...options.envOverrides };
  const directoryPath = join(repoRoot, 'output', options.directoryUuid);

  const assetsReviewSkip = env['CREATIVE_ASSETS_REVIEW_SKIP']?.trim() === '1';
  const assetsReviewFinalPath = join(directoryPath, 'review', 'assets-review-final.json');
  if (!assetsReviewSkip) {
    if (!existsSync(assetsReviewFinalPath)) {
      throw new Error(
        `Assets review required before creative generation. Run the style guide studio job with "Review assets après génération", `
          + `or: node src/agents/run-style-guide-assets-review.mts ${options.directoryUuid}\n`
          + 'Or set CREATIVE_ASSETS_REVIEW_SKIP=1 to bypass (not recommended).'
      );
    }
    const assetsFinal = JSON.parse(readFileSync(assetsReviewFinalPath, 'utf8')) as { satisfied?: boolean };
    if (assetsFinal.satisfied !== true) {
      throw new Error(
        `Assets review not satisfied (${assetsReviewFinalPath}). Re-run: node src/agents/run-style-guide-assets-review.mts ${options.directoryUuid}`
      );
    }
  }

  const regenFeedback = env['CREATIVE_REGEN_FEEDBACK']?.trim();
  const isRegen = regenFeedback !== undefined && regenFeedback.length > 0;
  let codeDirectoryPath: string;
  if (isRegen) {
    const versionHint = env['CREATIVE_CODE_VERSION']?.trim();
    const resolved = resolveCodeDirectory(directoryPath, versionHint ?? undefined);
    if (resolved === null) {
      throw new Error(`No creative code version to patch under ${join(directoryPath, 'code')}. Run a full generation first.`);
    }
    codeDirectoryPath = resolved;
  } else {
    const allocated = allocateNextCodeVersionDirectory(directoryPath);
    codeDirectoryPath = allocated.directoryPath;
    console.log(`[creative-native] New code version ${allocated.versionId} → ${allocated.directoryPath}`);
  }

  const adFormatPresets = loadAdFormatPresets(repoRoot);
  const adFormats = parseCreativeAdFormatsFromEnv(env['CREATIVE_AD_FORMATS'], adFormatPresets);
  console.log('[creative-native] Ad formats:', JSON.stringify(adFormats));
  const styleGuidePath = join(directoryPath, 'style-guide.json');
  const styleGuide = JSON.parse(readFileSync(styleGuidePath, { encoding: 'utf8' })) as StyleGuide;
  const anthropicApiKey = env['ANTHROPIC_API_KEY'];
  if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
    throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
  }

  const anthropicClient = new Anthropic({ apiKey: anthropicApiKey });
  const skillsText = loadSkillsForCodegenPrompt(repoRoot);
  const { fileMessages, assetFiles } = await buildCodegenAssetPromptBlocks({ directoryPath, styleGuide });
  const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  delete (prunedStyleGuide as { logoFileUrls?: unknown }).logoFileUrls;
  delete (prunedStyleGuide as { productPictureUrls?: unknown }).productPictureUrls;

  const baseMessages: Anthropic.Messages.MessageParam[] = [{
    role: 'user',
    content: [
      ...fileMessages,
      { type: 'text', text: buildCampaignProductHeroInstruction(prunedStyleGuide) },
      { type: 'text', text: JSON.stringify(prunedStyleGuide) },
      { type: 'text', text: buildStyleGuideColorConstraintText(prunedStyleGuide) }
    ]
  }];

  const activeModel = resolveCreativeModel(isRegen);
  console.log(`[creative-native] Model: ${activeModel} (${isRegen ? 'regeneration' : 'generation'})`);
  const messages = [ ...baseMessages ];
  if (isRegen && regenFeedback !== undefined) {
    const existingBundle = loadExistingCodeBundle(codeDirectoryPath);
    if (existingBundle.files.some((f) => f.truncated)) {
      console.warn('[creative-native] Regen: one or more code files truncated for prompt context.');
    }
    messages.push({ role: 'user', content: formatExistingBundleForPrompt(existingBundle) });
    messages.push({ role: 'user', content: regenFeedback });
    if (env['CREATIVE_REGEN_STRICT_MINIMAL']?.trim() === '1') {
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

  mkdirSync(codeDirectoryPath, { recursive: true });
  for (const codeFile of codegenResult.files) {
    const filePath = join(codeDirectoryPath, codeFile.fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, codeFile.fileContent, { encoding: 'utf8' });
  }
  for (const assetFile of assetFiles) {
    copyFileSync(assetFile.filePath, join(codeDirectoryPath, assetFile.fileName));
  }

  const creativeUsageTotals = codegenResult.usage;
  const sumReportedTokens =
    creativeUsageTotals.input_tokens +
    creativeUsageTotals.output_tokens +
    creativeUsageTotals.cache_creation_input_tokens +
    creativeUsageTotals.cache_read_input_tokens;
  logAnthropicUsageAndCost(basename(import.meta.filename, extname(import.meta.filename)), creativeUsageTotals, activeModel);

  writeFileSync(
    join(directoryPath, 'creative-native-token-usage.json'),
    `${JSON.stringify({
      ...creativeUsageTotals,
      model: activeModel,
      total_tokens_reported_sum: sumReportedTokens,
      price_usd: priceUsdFromAccumulator(creativeUsageTotals, activeModel),
      duration_ms_total: durationMsTotal,
      turn_timings: codegenResult.timings
    }, null, 2)}\n`,
    { encoding: 'utf8' }
  );

  const regenRoundRaw = env['CREATIVE_REGEN_REVIEW_ROUND']?.trim();
  const regenRound = regenRoundRaw !== undefined && regenRoundRaw.length > 0 ? Number.parseInt(regenRoundRaw, 10) : null;
  const pipelineEntry = entryFromAccumulator({
    action: isRegen ? 'creative_regeneration' : 'creative_generation',
    agent: 'agents/gen-creative-code-native.mts',
    model: activeModel,
    acc: creativeUsageTotals,
    phase: 'creative',
    review_round: Number.isFinite(regenRound ?? Number.NaN) ? regenRound : null,
    duration_ms: durationMsTotal,
    api_call_timings: codegenTurnTimingsToApiCallTimings(codegenResult.timings)
  });
  const pipelineFile = appendPipelineUsage(directoryPath, pipelineEntry);
  logPipelineUsageToConsole(pipelineFile.entries[pipelineFile.entries.length - 1]!);
  logPhaseTotalsToConsole(recomputePhaseTotals(pipelineFile.entries));

  writeFileSync(
    join(directoryPath, 'creative-native-ad-formats.json'),
    `${JSON.stringify({ adFormats }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  console.log(`[creative-native] Phase format de pub (génération) : ${formatDurationMinSec(durationMsTotal)}`);
  console.log(`Output directory path: ${directoryPath}`);

  return { directoryPath, codeDirectoryPath, activeModel, isRegen, durationMsTotal };
}
