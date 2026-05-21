import { withAnthropicRetry } from './anthropic-retry.mts';
import type { StyleGuide } from './gen-style-guide.mjs';
import {
  contains,
  creativeNativeStructuredOutputFilesSchema,
  loadDesignSkillGuidance,
  validateCreativeSkillCompliance,
  type AssetFile
} from './creative-native-skills.mts';
import {
  addUsageToAccumulator,
  appendPipelineUsage,
  createEmptyUsageAccumulator,
  entryFromAccumulator,
  logAnthropicUsageAndCost,
  logPipelineUsageToConsole,
  logReadableAnthropicCall,
  priceUsdFromAccumulator
} from './creative-pipeline-usage.mts';
import { buildCreativeAdFormatInstructions, loadAdFormatPresets, parseCreativeAdFormatsFromEnv } from './studio-ad-formats.mts';
import { basename, dirname, extname, join } from 'node:path';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';
import { z } from 'zod';

const CREATIVE_MODEL = 'claude-opus-4-6';

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

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });

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

const directoryPath = join(import.meta.dirname, '..', 'output', directoryUuid);
const codeDirectoryPath = join(directoryPath, 'code');
const repoRoot = join(import.meta.dirname, '..');
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
    const fileMimeType = mime.getType(fileName);
    const { width, height } = await imageSizeFromFile(filePath);
    const assetDescription = createAssetDescription(fileName, fileType);

    if (fileMimeType === null) {
      throw new Error(`Unable to determine MIME type for file ${fileName}`);
    } else if (!contains([ 'image/jpeg', 'image/png', 'image/gif', 'image/webp' ], fileMimeType)) {
      throw new Error(`Unsupported MIME type ${fileMimeType} for file ${fileName}`);
    }

    const textPayload =
      `- Asset: ${fileName}\n` +
      `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
      `  - Local path to use in generated code: ./${fileName}\n` +
      `  - Dimensions: ${width}x${height}\n` +
      `  - ${assetDescription}\n` +
      `  - Required: describe this specific image before using it and integrate it visually in the creative.`;
    fileMessages.push({
      type: 'text',
      text: textPayload,
      citations: null
    });

    if (assetInputMode === 'base64') {
      const fileContentBase64 = readFileSync(filePath).toString('base64');
      fileMessages.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: fileMimeType,
          data: fileContentBase64
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
if (regenFeedback !== undefined && regenFeedback.length > 0) {
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
  const systemPrompt = `
      You are an agent that invents modern interactive advertisement creatives.

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
      Logo and product images are local files. Reference them with relative paths from the project root
      (for example: ./logo.png).

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
    const creativeCodeStream = await anthropicClient.messages.stream({
      max_tokens: 128000,
      system: systemPrompt,
      messages,
      model: 'claude-opus-4-6',
      thinking: {
        type: 'enabled',
        budget_tokens: 100_000,
        display: 'omitted'
      },
      output_config: {
        format: zodOutputFormat(filesSchema),
      },
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 50
        }
      ]
    });
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
  CREATIVE_MODEL
);

const cumulativePrices = priceUsdFromAccumulator(creativeUsageTotals, CREATIVE_MODEL);
writeFileSync(
  join(directoryPath, 'creative-native-token-usage.json'),
  `${JSON.stringify({
    ...creativeUsageTotals,
    total_tokens_reported_sum: sumReportedTokens,
    price_usd: cumulativePrices
  }, null, 2)}\n`,
  { encoding: 'utf8' }
);

const isRegen = regenFeedback !== undefined && regenFeedback.length > 0;
const regenRoundRaw = process.env['CREATIVE_REGEN_REVIEW_ROUND']?.trim();
const regenRound =
  regenRoundRaw !== undefined && regenRoundRaw.length > 0 ? Number.parseInt(regenRoundRaw, 10) : null;
const pipelineEntry = entryFromAccumulator({
  action: isRegen ? 'creative_regeneration' : 'creative_generation',
  agent: 'gen-creative-code-native.mts',
  model: CREATIVE_MODEL,
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
