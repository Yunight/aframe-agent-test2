import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import type { StyleGuide } from './gen-style-guide.mjs';
import { contains, type AssetFile } from '../lib/creative-native-skills.mts';
import { runCreativeCodegen } from '../lib/creative-native-codegen-loop.mts';
import {
  formatExistingBundleForPrompt,
  loadExistingCodeBundle
} from '../lib/creative-native-codegen-regen.mts';
import { loadSkillsForCodegenPrompt, resolveCreativeModel } from '../lib/creative-native-codegen-prompt.mts';
import {
  appendPipelineUsage,
  entryFromAccumulator,
  logAnthropicUsageAndCost,
  logPipelineUsageToConsole,
  priceUsdFromAccumulator
} from '../lib/creative-pipeline-usage.mts';
import { isSvgAssetFile, sniffImageMimeFromBuffer } from '../lib/image-mime-sniff.mts';
import { loadAdFormatPresets, parseCreativeAdFormatsFromEnv } from '../lib/studio-ad-formats.mts';
import { basename, dirname, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';

type AssetInputMode = 'base64' | 'url';

function createAssetDescription (fileName: string, fileType: 'logos' | 'products'): string {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const keywordString = baseName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categoryLabel = fileType === 'logos' ? 'logo de marque' : 'visuel produit';
  const usageHint = fileType === 'logos'
    ? 'a utiliser en branding (header, badge, signature visuelle)'
    : 'a utiliser comme visuel hero ou element de scene principal';

  return `Description asset (${categoryLabel}): ${keywordString || baseName}. ${usageHint}.`;
}

loadDotenv({ path: join(repoRootFromModuleDir(import.meta.dirname), '.env') });

const directoryUuid = process.argv[2];

if (directoryUuid === undefined) {
  throw new Error('Missing project directory UUID.');
}

const cliArguments = process.argv.slice(3);
let assetInputMode: AssetInputMode = 'url';

for (let i = 0; i < cliArguments.length; i += 1) {
  const argument = cliArguments[i];

  if (argument === '--asset-input') {
    const value = cliArguments[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Missing value for --asset-input. Expected "base64" or "url".');
    }
    if (!contains([ 'base64', 'url' ] as const, value)) {
      throw new Error(`Invalid --asset-input value "${value}". Allowed values: base64, url.`);
    }
    assetInputMode = value;
    i += 1;
    continue;
  }

  throw new Error(`Unknown argument "${argument}". Allowed option: --asset-input`);
}

const repoRoot = repoRootFromModuleDir(import.meta.dirname);
const directoryPath = join(repoRoot, 'output', directoryUuid);

const assetsReviewSkip = process.env['CREATIVE_ASSETS_REVIEW_SKIP']?.trim() === '1';
const assetsReviewFinalPath = join(directoryPath, 'review', 'assets-review-final.json');
if (!assetsReviewSkip) {
  if (!existsSync(assetsReviewFinalPath)) {
    throw new Error(
      `Assets pre-flight review required. Run: node src/agents/run-creative-native-assets-review.mts ${directoryUuid}\n` +
      'Or set CREATIVE_ASSETS_REVIEW_SKIP=1 to bypass (not recommended).'
    );
  }
  const assetsFinal = JSON.parse(readFileSync(assetsReviewFinalPath, 'utf8')) as { satisfied?: boolean };
  if (assetsFinal.satisfied !== true) {
    throw new Error(
      `Assets review not satisfied (${assetsReviewFinalPath}). Re-run: node src/agents/run-creative-native-assets-review.mts ${directoryUuid}`
    );
  }
}

const codeDirectoryPath = join(directoryPath, 'code');
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

const fileMessages: (Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam)[] = [];
const assetFiles: AssetFile[] = [];

for (const fileType of [ 'logos', 'products' ] as const) {
  const subdirectoryPath = join(directoryPath, fileType);
  const fileList = readdirSync(subdirectoryPath);

  for (const fileName of fileList) {
    if (fileName.startsWith('.')) {
      continue;
    }

    const filePath = join(subdirectoryPath, fileName);
    const fileBuf = readFileSync(filePath);
    const assetDescription = createAssetDescription(fileName, fileType);
    const localCodePath = `./${fileName}`;

    if (isSvgAssetFile(fileName, fileBuf)) {
      const textPayload =
        `- Asset: ${fileName}\n` +
        `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
        `  - Format: SVG vector (not sent as vision preview)\n` +
        `  - Local path to use in generated code: ${localCodePath}\n` +
        `  - Use in HTML as <img src="${localCodePath}" alt="logo"> or inline <object>/<svg> reference; path is relative to index.html in code/\n` +
        `  - ${assetDescription}\n` +
        `  - Required: integrate this SVG logo in the creative via the local path above.`;
      fileMessages.push({
        type: 'text',
        text: textPayload
      });
      assetFiles.push({ fileName, filePath, fileType });
      continue;
    }

    const sniffedMime = sniffImageMimeFromBuffer(fileBuf);
    const fileMimeType = sniffedMime ?? mime.getType(fileName);

    if (fileMimeType === null || sniffedMime === null) {
      throw new Error(`Unable to detect image MIME for file ${fileName} (extension may not match content).`);
    }
    if (!contains([ 'image/jpeg', 'image/png', 'image/gif', 'image/webp' ], fileMimeType)) {
      throw new Error(`Unsupported MIME type ${fileMimeType} for file ${fileName}`);
    }

    const { width, height } = await imageSizeFromFile(filePath);
    const textPayload =
      `- Asset: ${fileName}\n` +
      `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
      `  - Local path to use in generated code: ${localCodePath}\n` +
      `  - Dimensions: ${String(width)}x${String(height)}\n` +
      `  - ${assetDescription}\n` +
      `  - Required: describe this specific image before using it and integrate it visually in the creative.`;
    fileMessages.push({
      type: 'text',
      text: textPayload
    });

    if (assetInputMode === 'base64') {
      fileMessages.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: sniffedMime,
          data: fileBuf.toString('base64')
        }
      });
    }
    assetFiles.push({
      fileName,
      filePath,
      fileType
    });
  }
}

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
const turnNotes = codegenResult.timings.map((t) => `turn${String(t.turn)}=${String(t.duration_ms)}ms`).join(', ');
const pipelineEntry = entryFromAccumulator({
  action: isRegen ? 'creative_regeneration' : 'creative_generation',
  agent: 'agents/gen-creative-code-native.mts',
  model: activeModel,
  acc: creativeUsageTotals,
  review_round: Number.isFinite(regenRound ?? Number.NaN) ? regenRound : null,
  duration_ms: durationMsTotal,
  ...(turnNotes.length > 0 ? { notes: turnNotes } : {})
});
const pipelineFile = appendPipelineUsage(directoryPath, pipelineEntry);
logPipelineUsageToConsole(pipelineFile.entries[pipelineFile.entries.length - 1]!);

writeFileSync(
  join(directoryPath, 'creative-native-ad-formats.json'),
  `${JSON.stringify({ adFormats }, null, 2)}\n`,
  { encoding: 'utf8' }
);

console.log(`[creative-native] Total duration: ${String(durationMsTotal)} ms`);
console.log(`Output directory path: ${directoryPath}`);
