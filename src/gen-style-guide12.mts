import { join, basename, extname } from 'node:path';
import { mkdirSync, createWriteStream, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

// --- Tokens / coût (Claude Opus 4.7 Flagship : $5/M input, $25/M output) ---
const USD_PER_MILLION_INPUT_TOKENS = 5;
const USD_PER_MILLION_OUTPUT_TOKENS = 25;

type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

type UsageAccumulator = {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

function createEmptyUsageAccumulator (): UsageAccumulator {
  return {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

function addUsageToAccumulator (
  acc: UsageAccumulator,
  usage: UsageLike | null | undefined
): void {
  if (usage === null || usage === undefined) {
    return;
  }
  acc.api_calls += 1;
  acc.input_tokens += usage.input_tokens;
  acc.output_tokens += usage.output_tokens;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

function billedInputTokens (acc: UsageAccumulator): number {
  return acc.input_tokens + acc.cache_creation_input_tokens + acc.cache_read_input_tokens;
}

function pricesUsdFromAccumulator (acc: UsageAccumulator): {
  billed_input_tokens: number;
  output_tokens: number;
  input_usd: number;
  output_usd: number;
  total_usd: number;
} {
  const billed_input_tokens = billedInputTokens(acc);
  const output_tokens = acc.output_tokens;
  const input_usd = (billed_input_tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS;
  const output_usd = (output_tokens / 1_000_000) * USD_PER_MILLION_OUTPUT_TOKENS;
  return {
    billed_input_tokens,
    output_tokens,
    input_usd,
    output_usd,
    total_usd: input_usd + output_usd
  };
}

function roundUsd6 (n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function logAnthropicUsageAndCost (scriptLabel: string, acc: UsageAccumulator): void {
  const p = pricesUsdFromAccumulator(acc);
  console.log(`--- ${scriptLabel} (cumulative) ---`);
  console.log(`call reason : ${acc.api_calls} réponse(s) API — Claude Opus 4.7 Flagship ($5/M input, $25/M output, cache inclus côté input)`);
  console.log(`input token : ${p.billed_input_tokens}`);
  console.log(`output token : ${p.output_tokens}`);
  console.log(`input price (USD) : ${roundUsd6(p.input_usd)}`);
  console.log(`output price (USD) : ${roundUsd6(p.output_usd)}`);
  console.log(`total price (USD) : ${roundUsd6(p.total_usd)}`);
  console.log('');
}

function billedInputFromUsage (usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function logReadableAnthropicCall (callReason: string, usage: UsageLike | null | undefined): void {
  console.log(`call reason : ${callReason}`);
  if (usage === null || usage === undefined) {
    console.log('input token : —');
    console.log('output token : —');
    console.log('');
    return;
  }
  console.log(`input token : ${billedInputFromUsage(usage)}`);
  console.log(`output token : ${usage.output_tokens}`);
  console.log('');
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
    case 'render_creative_png': {
      const o = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : null;
      const entry = typeof o?.['entryFile'] === 'string' ? o['entryFile'] : '(fichier non précisé)';
      const preset = typeof o?.['devicePreset'] === 'string' ? o['devicePreset'] : null;
      const wait = typeof o?.['waitMs'] === 'number' ? `attente ${o['waitMs']} ms` : null;
      const bits = [ `entrée ${entry}` ];
      if (preset !== null) {
        bits.push(`appareil ${preset}`);
      }
      if (wait !== null) {
        bits.push(wait);
      }
      return `génération de prévisualisation PNG (Puppeteer) — ${bits.join(', ')} — pour contrôler la scène avant livraison des fichiers`;
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


interface BraveImageResult {
  type: 'image_result';
  title: string;
  url: string;
  source: string;
  page_fetched: string;
  thumbnail: { src: string };
  properties: {
    url: string;
    placeholder: string;
  };
  meta_url: {
    scheme: string;
    netloc: string;
    hostname: string;
    favicon: string;
    path: string;
  };
}
 
interface BraveImageSearchResponse {
  type: 'images';
  query: {
    original: string;
    altered?: string;
    spellcheck_off?: boolean;
    show_strict_warning?: boolean;
  };
  results: BraveImageResult[];
}

const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const mimeTypeToExtension: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const contextPrompt = `
  The brand is Mortal Kombat II and the context is for the new movie they are launching.
`.trim();

const skillFiles = [
  '.claude/.skills/ui-design/commands/color-palette.md',
  '.claude/.skills/ui-design/commands/type-system.md',
  '.claude/.skills/ui-design/skills/color-system/SKILL.md',
  '.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md',
  '.claude/.skills/ui-design/skills/typography-scale/SKILL.md',
  '.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md'
] as const;

function loadSkillGuidance (): string {
  const rootDir = join(import.meta.dirname, '..');
  const loadedSkills = skillFiles
    .map((relativePath) => {
      const absolutePath = join(rootDir, relativePath);

      if (!existsSync(absolutePath)) {
        console.warn(`[skills] Missing skill file: ${relativePath}`);
        return null;
      }

      const content = readFileSync(absolutePath, 'utf8').trim();
      return `### ${relativePath}\n${content}`;
    })
    .filter((value): value is string => value !== null);

  if (loadedSkills.length === 0) {
    throw new Error('No local skill files were found in .claude/.skills.');
  }

  return loadedSkills.join('\n\n');
}

function sanitizeFilename (name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

async function downloadFileToFileSystem (url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: '*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`Downloading of file at URL: ${url} failed with status: ${response.status}`);
  }

  const body = response.body;

  if (body === null) {
    throw new Error(`Downloading of file at URL: ${url} returned empty body`);
  }

  const fileFetchStream = Readable.fromWeb(body);
  const fileWriteStream = createWriteStream(destinationPath);
  await pipeline(fileFetchStream, fileWriteStream);
}

async function resolveRemoteImageMetadata(url: string): Promise<{ mimeType: string, extension: string }> {
  const headResponse = await fetch(url, {
    method: 'HEAD',
    headers: {
      Accept: 'image/*'
    }
  });

  if (!headResponse.ok) {
    throw new Error(`Unable to validate image URL ${url}. HEAD request failed with status ${headResponse.status}`);
  }

  const contentTypeHeader = headResponse.headers.get('content-type') ?? '';
  const mimeType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!allowedImageMimeTypes.has(mimeType)) {
    throw new Error(`URL ${url} has unsupported content-type "${contentTypeHeader}"`);
  }

  const extension = mimeTypeToExtension[mimeType];
  if (extension === undefined) {
    throw new Error(`Unsupported MIME type "${mimeType}" for URL ${url}`);
  }

  return { mimeType, extension };
}

async function braveImageSearch (
  { query, num = 10 }:
  { query: string, num: number }
): Promise<BraveImageResult[]> {
    const params = new URLSearchParams();

    params.set('q', query);
    params.set('count', Math.min(Math.max(num, 1), 200).toString());
    params.set('search_lang', 'en');
    params.set('country', 'US');
    params.set('safesearch', 'strict');
    params.set('spellcheck', '0');
 
    const url = `https://api.search.brave.com/res/v1/images/search?${params.toString()}`;
 
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': process.env['BRAVE_API_KEY'] ?? '',
      }
    });
 
    if (!response.ok) {
      throw new Error(`Brave image search failed: ${response.status} and error: ${await response.text() ?? ''}`);
    }
 
    return ((await response.json()) as BraveImageSearchResponse).results;
}

const brandStyleGuideSchema = z.object({
  companyName: z.string().describe('Company name.'),
  companyContext: z.string().describe('What does the company do?'),
  companyURL: z.url().describe('URL of company.'),
  brandName: z.string().describe('Brand name.'),
  brandContext: z.string().describe('What does the brand do?'),
  brandURL: z.url().describe('URL of brand.'),
  logoFileUrls: z.array(z.url()).describe('List of brand image logo URLs in different variants.'),
  productName: z.string().describe('Name of product if one is specified'),
  productPictureUrls: z.array(z.url()).describe('List of product pictures or packshots URLs in different variants.'),
  primaryColorPalette: z.array(z.hex()).describe('List of hexadecimal codes for the colors of primary color palette in descending order of importants.'),
  secondaryColorPalette: z.array(z.hex()).describe('List of hexadecimal codes for the colors of secondary color palette in descending order of importants.'),
  typography: z.array(
    z.object({
      fontFamily: z.string().describe('Font family name'),
      fontWeight: z.number().describe('Font weight as used in CSS'),
      fontEffect: z.array(z.enum([ 'bold', 'italic', 'underline', 'strikethrough' ])).describe('Font effects'),
      fontUses: z.string().describe('Context in which to use said font setting. i.e: brand name, heading, text body, etc.')
    })
  ),
  brandVision: z.string().describe('Direction taken by the brand.'),
  brandValues: z.string().describe('What does the brand or company stand for?')
})
  .describe('Brand style guide object')
  .strict();

export type StyleGuide = z.infer<typeof brandStyleGuideSchema>;

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });
const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const anthropicClient = new Anthropic({
  apiKey: anthropicApiKey
});
const cliArguments = process.argv.slice(2);
if (cliArguments.length > 0) {
  throw new Error(`Unknown argument "${cliArguments[0]}". This script no longer supports optional asset download flags.`);
}

const messages: Anthropic.Messages.MessageParam[] = [{
  role: 'user',
  content: contextPrompt
}];
let finalMessageContent = null;
const localSkillGuidance = loadSkillGuidance();

let i = 0;

const apiUsageTotals = createEmptyUsageAccumulator();

while (true) {
  i += 1;

  console.log(`Generating style guide ... (i=${i})`);

  const styleGuideStream = await anthropicClient.messages.stream({
    max_tokens: 128_000,
    system: `
      You are an agent that assembles brand style guides based on external information.
      The information should ideally be sourced from the brand or company's official websites.
      No information should come from the model memory. It should always be fetched remotely to ensure freshness.

      Make sure to understand who the company or brand is and what the context is.
      If a product name or category is specified analyse the problem with it in mind.

      When specifying URLs, always check that they exist and that they are images (JPG, PNG, WEBP, GIF), filetype must be one of the following: JPG, PNG, WEBP, GIF, the logo should always be a transparent PNG file, even if the filename ends with .png you have to check that it is a transparent PNG file.
      the logo should always be a transparent PNG file.

      When specifying colors, always check that the color exists and matches the one described in the official sources.

      Find at least four versions of the logo (light theme / dark theme and with brand name / without brand name).
      Find at least four product pictures (light theme / dark theme and a few size and compositions variations).

      Search for images using the Google Image Search tool.

      The local design skills below are mandatory constraints.
      Before returning final JSON, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep searching and refining, and do not finalize yet.
      ${localSkillGuidance}
    `.trim(),
    messages,
    model: 'claude-opus-4-6',
    thinking: {
      type: 'enabled',
      budget_tokens: 100_000,
      display: 'omitted'
    },
    output_config: {
      format: zodOutputFormat(brandStyleGuideSchema)
    },
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 25
      },
      {
        name: 'google_image_search',
        description: `
          Search Google Images and return a list of matching images
          (title, direct image URL, source page, dimensions).
          Use this when the user asks for pictures, references, or visual examples of something.
        `.trim(),
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query.',
            },
            num: {
              type: 'integer',
              description: 'How many results to return (1-10).',
              minimum: 1,
              maximum: 20,
            }
          },
          required: [ 'query' ]
        }
      }
    ]
  });
  const styleGuideResponse = await styleGuideStream.finalMessage();
  addUsageToAccumulator(apiUsageTotals, styleGuideResponse.usage);
  logReadableAnthropicCall(
    describeAnthropicTurnForLogs(styleGuideResponse.stop_reason, styleGuideResponse.content),
    styleGuideResponse.usage ?? undefined
  );

  messages.push({ role: 'assistant', content: styleGuideResponse.content });

  console.log('[Claude]', JSON.stringify(styleGuideResponse.content).slice(0, 100), '...');

  if (styleGuideResponse.stop_reason !== 'tool_use') {
    console.log('Stop reason:', styleGuideResponse.stop_reason);
    console.log('Stop details:', styleGuideResponse.stop_details);
    console.log(styleGuideResponse.parsed_output);
    finalMessageContent = styleGuideResponse.parsed_output;
    break;
  }

  const toolResults: Anthropic.ToolResultBlockParam[] = [];

  for (const block of styleGuideResponse.content) {
    if (block.type === 'tool_use' && block.name === 'google_image_search') {
      const args = block.input as Parameters<typeof braveImageSearch>[0];

      try {
        const result = await braveImageSearch(args);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error(`Error while fetching Google Images with query ${args.query} ${err.name}:${err.message}\n${err.stack ?? ''}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }
      }
    }
  }

  messages.push({ role: 'user', content: toolResults });
}

if (finalMessageContent === null) {
  throw new Error('Empty style guide response');
}

const directoryUuid = randomUUID();
const generatorScriptName = basename(import.meta.filename, extname(import.meta.filename));
const outputDirectoryName = `${generatorScriptName}-${directoryUuid}`;
const directoryPath = join(import.meta.dirname, '..', 'output', outputDirectoryName);

console.log(`Output directory path: ${directoryPath}`);
console.log('Download assets: required');

mkdirSync(directoryPath);

const downloadedAssetCounts: Record<'logos' | 'products', number> = {
  logos: 0,
  products: 0
};
const failedAssetDownloads: Array<{ fileType: 'logos' | 'products'; url: string; reason: string }> = [];

for (const fileType of [ 'logos', 'products' ] as const) {
  const fileUrls = (fileType === 'logos'
    ? finalMessageContent?.logoFileUrls
    : fileType === 'products'
      ? finalMessageContent?.productPictureUrls
      : []
  ) ?? [];

  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath);

  for (const fileUrl of fileUrls) {
    const logoFileName = basename(fileUrl);
    const logoFileNameSanitized = sanitizeFilename(logoFileName);
    const originalExtension = extname(logoFileNameSanitized).toLowerCase();

    try {
      const { mimeType, extension } = await resolveRemoteImageMetadata(fileUrl);
      const resolvedFileName = originalExtension === extension
        ? logoFileNameSanitized
        : `${logoFileNameSanitized.replace(/\.[^.]+$/, '')}${extension}`;
      const filePath = join(subdirectoryPath, resolvedFileName);

      if (originalExtension !== extension) {
        console.warn(`[download] Extension mismatch for ${fileUrl}. Original "${originalExtension || 'none'}", remote "${mimeType}". Saving as ${resolvedFileName}.`);
      }

      console.log(`Downloading ${filePath} ...`);
      await downloadFileToFileSystem(fileUrl, filePath);
      downloadedAssetCounts[fileType] += 1;
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(err);
        failedAssetDownloads.push({
          fileType,
          url: fileUrl,
          reason: err.message
        });
      }
    }
  }
}

const minimumAssetsPerType = 1;
const missingTypes = (Object.entries(downloadedAssetCounts) as Array<[ 'logos' | 'products', number ]>)
  .filter(([, count]) => count < minimumAssetsPerType)
  .map(([type, count]) => `${type}: ${count}/${minimumAssetsPerType}`);

if (missingTypes.length > 0) {
  const failedList = failedAssetDownloads.length === 0
    ? 'none'
    : failedAssetDownloads
      .map((entry) => `${entry.fileType} | ${entry.url} | ${entry.reason}`)
      .join('\n');
  throw new Error(
    `Asset download requirements not met (${missingTypes.join(', ')}).\n` +
    `Downloaded counts: logos=${downloadedAssetCounts.logos}, products=${downloadedAssetCounts.products}\n` +
    `Failed downloads:\n${failedList}`
  );
}

const styleGuideFilePath = join(directoryPath, 'style-guide.json');
writeFileSync(
  styleGuideFilePath,
  `${JSON.stringify(finalMessageContent, null, 2)}\n`,
  { encoding: 'utf8' }
);

logAnthropicUsageAndCost(basename(import.meta.filename, extname(import.meta.filename)), apiUsageTotals);
console.log('End.');
