import { withAnthropicRetry } from '../lib/anthropic-retry.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import type { StyleGuide } from './gen-style-guide.mjs';
import {
  contains,
  creativeNativeStructuredOutputFilesSchema,
  loadDesignSkillGuidance,
  validateCreativeSkillCompliance,
  type AssetFile
} from '../lib/creative-native-skills.mts';
import {
  addUsageToAccumulator,
  appendPipelineUsage,
  createEmptyUsageAccumulator,
  entryFromAccumulator,
  logAnthropicUsageAndCost,
  logPipelineUsageToConsole,
  logReadableAnthropicCall,
  priceUsdFromAccumulator
} from '../lib/creative-pipeline-usage.mts';
import { isSvgAssetFile, sniffImageMimeFromBuffer } from '../lib/image-mime-sniff.mts';
import { buildCreativeAdFormatInstructions, loadAdFormatPresets, parseCreativeAdFormatsFromEnv } from '../lib/studio-ad-formats.mts';
import { basename, dirname, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';
import { z } from 'zod';

const CREATIVE_MODEL = 'claude-opus-4-6';
const DEFAULT_CREATIVE_REGEN_MODEL = 'claude-haiku-4-5-20251001';
const CREATIVE_OPUS_MAX_OUTPUT_TOKENS = 128_000;
const CREATIVE_HAIKU_MAX_OUTPUT_TOKENS = 64_000;

function maxOutputTokensForModel (model: string): number {
  return model.toLowerCase().includes('haiku')
    ? CREATIVE_HAIKU_MAX_OUTPUT_TOKENS
    : CREATIVE_OPUS_MAX_OUTPUT_TOKENS;
}

function shortenForLog (s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function pickQueryFromUnknown (input: unknown): string | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }
  const o = input as Record<string, unknown>;
  for (const key of [ 'query', 'search_query', 'q' ] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return shortenForLog(v, 160);
    }
  }
  return null;
}

function describeClientToolUse (name: string, input: unknown): string {
  switch (name) {
    case 'web_search':
      return "recherche web (pages officielles, sources, vérification d'informations)";
    case 'google_image_search': {
      const q = pickQueryFromUnknown(input);
      if (q !== null) {
        return `recherche d'images Google — requête « ${q} »`;
      }
      return "recherche d'images Google (logos, produits, références visuelles)";
    }
    default:
      return `outil personnalisé « ${name} »`;
  }
}

function describeServerToolUse (name: Anthropic.ServerToolUseBlock['name'], input: unknown): string {
  const q = pickQueryFromUnknown(input);
  const qSuffix = q !== null ? ` — requête « ${q} »` : '';
  switch (name) {
    case 'web_search':
      return `recherche web intégrée (serveur Anthropic)${qSuffix}`;
    case 'web_fetch':
      return `récupération de page distante (web_fetch)${qSuffix}`;
    case 'code_execution':
    case 'bash_code_execution':
    case 'text_editor_code_execution':
      return `exécution / édition côté serveur (${name})`;
    case 'tool_search_tool_regex':
    case 'tool_search_tool_bm25':
      return `recherche d'outils (${name})`;
    default:
      return `outil serveur « ${name} »${qSuffix}`;
  }
}

function describeAnthropicTurnForLogs (
  stopReason: Anthropic.Message['stop_reason'],
  content: Anthropic.Message['content']
): string {
  const segments: string[] = [];

  if (stopReason !== null && stopReason !== undefined) {
    segments.push(`arrêt: ${stopReason}`);
  }

  if (content.length === 0) {
    segments.push('aucun bloc de contenu');
    return segments.join(' — ');
  }

  const actions: string[] = [];
  let hasThinking = false;
  let hasText = false;

  for (const block of content) {
    if (block.type === 'tool_use') {
      actions.push(describeClientToolUse(block.name, block.input));
    } else if (block.type === 'server_tool_use') {
      actions.push(describeServerToolUse(block.name, block.input));
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      hasThinking = true;
    } else if (block.type === 'text') {
      hasText = true;
    }
  }

  if (actions.length > 0) {
    segments.push(`objectif du tour : ${actions.join(' | ')}`);
  }

  if (stopReason === 'tool_use' && actions.length === 0) {
    segments.push('arrêt tool_use sans blocs tool_use reconnus (vérifier la réponse)');
  }

  if (stopReason !== 'tool_use') {
    if (hasText && actions.length === 0) {
      segments.push('réponse textuelle ou JSON structuré (livraison ou étape intermédiaire)');
    }
    if (hasThinking && actions.length === 0 && !hasText) {
      segments.push('réflexion interne uniquement (extended thinking), sans texte ni outil client');
    }
    if (!hasText && actions.length === 0 && stopReason === 'end_turn') {
      segments.push('fin de tour (souvent JSON de guide de style ou liste de fichiers parsée)');
    }
  }

  if (hasThinking && actions.length > 0) {
    segments.push('inclut de la réflexion étendue');
  }

  return segments.join(' — ');
}

function createAssetDescription(fileName: string, fileType: 'logos' | 'products'): string {
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

type AssetInputMode = 'base64' | 'url';

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

const directoryPath = join(repoRootFromModuleDir(import.meta.dirname), 'output', directoryUuid);

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
const repoRoot = repoRootFromModuleDir(import.meta.dirname);
const adFormatPresets = loadAdFormatPresets(repoRoot);
const adFormats = parseCreativeAdFormatsFromEnv(process.env['CREATIVE_AD_FORMATS'], adFormatPresets);
console.log('[creative-native] Ad formats:', JSON.stringify(adFormats));
const styleGuidePath = join(directoryPath, 'style-guide.json');
const styleGuide = JSON.parse(readFileSync(styleGuidePath, { encoding: 'utf8' })) as StyleGuide;

const filesSchema = creativeNativeStructuredOutputFilesSchema;

const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const anthropicClient = new Anthropic({
  apiKey: anthropicApiKey
});
const localDesignSkillGuidance = loadDesignSkillGuidance();

const fileMessages: (Anthropic.ImageBlockParam | Anthropic.TextBlock)[] = [];
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
        text: textPayload,
        citations: null
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
      text: textPayload,
      citations: null
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

const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide));
delete prunedStyleGuide.logoFileUrls;
delete prunedStyleGuide.productPictureUrls;

const messages: Anthropic.Messages.MessageParam[] = [{
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
const activeModel = isRegen
  ? (process.env['CREATIVE_REGEN_MODEL']?.trim() ?? DEFAULT_CREATIVE_REGEN_MODEL)
  : CREATIVE_MODEL;
console.log(`[creative-native] Model: ${activeModel} (${isRegen ? 'regeneration' : 'generation'})`);
if (isRegen) {
  messages.push({ role: 'user', content: regenFeedback });
  console.log('[creative-native] Regeneration from UI review agent feedback.');
}

let codeFileList: z.infer<typeof filesSchema> | null = null;
let generationIndex = 0;
const maxGenerationTurns = 8;
let structuredOutputRetryCount = 0;
const maxStructuredOutputRetries = 2;

const creativeUsageTotals = createEmptyUsageAccumulator();

while (true) {
  generationIndex += 1;
  if (generationIndex > maxGenerationTurns) {
    throw new Error(`Generation exceeded ${maxGenerationTurns} turns without valid output.`);
  }
  const regenSystemPrefix = isRegen
    ? `You are fixing an existing HTML5/CSS/JS ad bundle from UI review feedback. Change only what is needed to resolve blockers; preserve working structure and assets where possible.

`
    : '';
  const systemPrompt = `${regenSystemPrefix}You are an agent that invents modern interactive advertisement creatives.

      Required stack: plain HTML5, CSS, and JavaScript only. No React, Vue, Svelte, no Vite/Webpack,
      no Tailwind/DaisyUI/npm dependencies, no JSX/TSX, no build step. The result must open from disk
      (file://) in a browser when index.html is loaded.

      Create a 2D advertisement creative in a new format you invent.
      create at least 4 differents versions of the creative for the different ad formats, each format should have a unique features and a unique look.
      Graphic elements (fonts, colors, pictures) must follow only the JSON style guide from the user.
      The layout and interaction design are up to you: fresh, modern, eye-catching, with animation and
      interactivity where appropriate.
      Only use one logo image by default the light theme only, if the logo is not visible in the light theme, use the dark theme.
      the logo should remains visible and a good scale so it is not too small or too big, do not apply any filter to the logo.
      Logo and product images are local files copied next to index.html under code/. Reference them with
      relative paths (for example: ./brand-logo.svg or ./product.jpg). SVG logos are valid — use
      <img src="./filename.svg">; raster logos/products may also be sent as vision context when base64 mode is on.

      Output: a list of files with their contents. Paths must be relative to the project root.

      You MUST output exactly these root files (no subfolders required for these three):
      - index.html — viewport meta width=device-width; link to styles.css; script src app.js (defer recommended).
      - styles.css — all presentation (no preprocessor).
      - app.js — vanilla DOM scripting only (no import maps to npm).

      ${buildCreativeAdFormatInstructions(adFormats)}

      Optional: additional static assets only if needed (e.g. extra .svg), still no package.json or bundlers.

      Fonts and colors: only those defined in the style guide. Ad copy in French.
      Include at least one logo and one product image from the provided assets in the HTML/CSS/JS.
      Do not add browser chrome: no zoom, fullscreen, or VR toggles in the creative UI.

      The local design skills below are mandatory constraints.
      Before returning final files, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep refining and do not finalize.
      Use only typography families listed in the style guide.
      Use only hex colors listed in the style guide primary/secondary palettes.
      Follow the local design skills below as mandatory constraints for layout, color, typography,
      hierarchy, animation, and interaction decisions:
      ${localDesignSkillGuidance}
    `.trim();

  const creativeCodeResponse = await withAnthropicRetry('creative generation', async () => {
    const streamParams = {
      max_tokens: maxOutputTokensForModel(activeModel),
      system: systemPrompt,
      messages,
      model: activeModel,
      output_config: {
        format: zodOutputFormat(filesSchema)
      },
      ...(isRegen
        ? {}
        : {
            thinking: {
              type: 'enabled' as const,
              budget_tokens: 100_000,
              display: 'omitted' as const
            },
            tools: [
              {
                type: 'web_search_20250305' as const,
                name: 'web_search' as const,
                max_uses: 50
              }
            ]
          })
    };
    const creativeCodeStream = await anthropicClient.messages.stream(streamParams);
    return await creativeCodeStream.finalMessage();
  });
  addUsageToAccumulator(creativeUsageTotals, creativeCodeResponse.usage);
  logReadableAnthropicCall(
    describeAnthropicTurnForLogs(creativeCodeResponse.stop_reason, creativeCodeResponse.content),
    creativeCodeResponse.usage ?? undefined
  );
  messages.push({ role: 'assistant', content: creativeCodeResponse.content });

  if (creativeCodeResponse.stop_reason !== 'tool_use') {
    if (creativeCodeResponse.parsed_output !== null && creativeCodeResponse.parsed_output.length > 0) {
      const complianceCheck = validateCreativeSkillCompliance(creativeCodeResponse.parsed_output, prunedStyleGuide, assetFiles);
      if (complianceCheck.ok) {
        codeFileList = creativeCodeResponse.parsed_output;
        break;
      }

      structuredOutputRetryCount += 1;
      if (structuredOutputRetryCount > maxStructuredOutputRetries) {
        throw new Error(`AI output failed skill compliance checks: ${complianceCheck.issues.join(' | ')}`);
      }

      messages.push({
        role: 'user',
        content:
          `Your previous output is not compliant with mandatory skills/style-guide constraints: ${complianceCheck.issues.join(' ; ')}. `
          + `Regenerate all files and fix every issue. Required ad sizes (px): ${adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}.`
      });
      continue;
    }

    structuredOutputRetryCount += 1;
    if (structuredOutputRetryCount > maxStructuredOutputRetries) {
      throw new Error('AI returned no structured code output after retries.');
    }

    messages.push({
      role: 'user',
      content: `Your previous response did not include the required structured file list. Respond now with only valid structured output matching the expected schema. Do not call tools.`
    });
    continue;
  }

  messages.push({
    role: 'user',
    content:
      'Continue: return the structured file list (index.html, styles.css, app.js) matching the schema. '
      + `Respect every required ad size: ${adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}. `
      + 'No screenshot or preview tools are available.'
  });
  continue;
}

if (codeFileList === null || codeFileList.length === 0) {
  throw new Error('Missing or empty code file list returned by AI.');
}

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
    price_usd: cumulativePrices
  }, null, 2)}\n`,
  { encoding: 'utf8' }
);

const regenRoundRaw = process.env['CREATIVE_REGEN_REVIEW_ROUND']?.trim();
const regenRound =
  regenRoundRaw !== undefined && regenRoundRaw.length > 0 ? Number.parseInt(regenRoundRaw, 10) : null;
const pipelineEntry = entryFromAccumulator({
  action: isRegen ? 'creative_regeneration' : 'creative_generation',
  agent: 'agents/gen-creative-code-native.mts',
  model: activeModel,
  acc: creativeUsageTotals,
  review_round: Number.isFinite(regenRound ?? Number.NaN) ? regenRound : null
});
const pipelineFile = appendPipelineUsage(directoryPath, pipelineEntry);
logPipelineUsageToConsole(pipelineFile.entries[pipelineFile.entries.length - 1]!);

writeFileSync(
  join(directoryPath, 'creative-native-ad-formats.json'),
  `${JSON.stringify({ adFormats }, null, 2)}\n`,
  { encoding: 'utf8' }
);

console.log(`Output directory path: ${directoryPath}`);
