import {
  braveLogoCandidatePool,
  braveProductCandidatePool,
  braveProductTargetCount,
  buildLogoSearchQueries,
  buildProductSearchQueries,
  collectAndDownloadValidAssetUrls,
  officialHostsFromContext
} from '../lib/brave-image-assets.mts';
import { basename, join, extname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { withAnthropicRetry } from '../lib/anthropic-retry.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import { toStyleGuideHex } from '../lib/style-guide-colors.mts';
import {
  appendPipelineUsage,
  entryFromAccumulator,
  logPipelineUsageToConsole
} from '../lib/creative-pipeline-usage.mts';

const STYLE_GUIDE_MODEL = 'claude-opus-4-7';

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


const DEFAULT_STYLE_GUIDE_BRAND = 'Peugeot';
const DEFAULT_STYLE_GUIDE_CONTEXT = 'the new EV GTI 208 they are launching';

/** Same wording as style-guide-studio-api `composeStyleGuideContextFromParts`. */
function buildStyleGuideContextFromBrandAndContext (brand: string, context: string): string {
  const b = brand.trim();
  const c = context.trim();
  if (b.length > 0 && c.length > 0) {
    return `The brand is ${b} and the context is ${c}`;
  }
  if (b.length > 0) {
    return 'The brand is '
      + b
      + ' and the context is not specified beyond the brand; infer positioning from official sites and current campaigns.';
  }
  if (c.length > 0) {
    return 'No commercial brand was specified. The context is '
      + c
      + '. Infer visuals, tone, typography, and color direction from official trailers, key art, and distributor or studio materials only; do not invent a corporate brand beyond this title or IP.';
  }
  return '';
}

function defaultStyleGuideContextPrompt (): string {
  return buildStyleGuideContextFromBrandAndContext(DEFAULT_STYLE_GUIDE_BRAND, DEFAULT_STYLE_GUIDE_CONTEXT);
}

function resolveStyleGuideContextPrompt (fallback: string): string {
  const raw = process.env['STYLE_GUIDE_CONTEXT'];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('STYLE_GUIDE_CONTEXT is set but empty after trim.');
  }
  return trimmed;
}

const skillFiles = [
  '.claude/.skills/ui-design/commands/color-palette.md',
  '.claude/.skills/ui-design/commands/type-system.md',
  '.claude/.skills/ui-design/skills/color-system/SKILL.md',
  '.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md',
  '.claude/.skills/ui-design/skills/typography-scale/SKILL.md',
  '.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md'
] as const;

function loadSkillGuidance (): string {
  const rootDir = repoRootFromModuleDir(import.meta.dirname);
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

/** CSS hex with mandatory `#` prefix (model may return bare RRGGBB). */
const styleGuideHexColor = z
  .string()
  .transform((value) => toStyleGuideHex(value))
  .pipe(z.string().regex(/^#[0-9A-Fa-f]{6}$/u, 'Expected #RRGGBB hex color'));

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
  primaryColorPalette: z
    .array(styleGuideHexColor)
    .describe('List of #RRGGBB hex codes for the primary color palette, most important first.'),
  secondaryColorPalette: z
    .array(styleGuideHexColor)
    .describe('List of #RRGGBB hex codes for the secondary color palette, most important first.'),
  typography: z.array(
    z.object({
      fontFamily: z.string().describe('Font family name'),
      fontWeight: z.number().describe('Font weight as used in CSS'),
      fontEffect: z.array(z.enum([ 'bold', 'italic', 'underline', 'strikethrough' ])).describe('Font effects'),
      fontUses: z.string().describe('Context in which to use said font setting. i.e: brand name, heading, text body, etc.')
    })
  ),
  brandVision: z.string().describe('Direction taken by the brand.'),
  brandValues: z.string().describe('What does the brand or company stand for?'),
  logoImageSearchQueries: z
    .array(z.string())
    .default([])
    .describe('Brave Image Search queries for the official logo (filled by the model at generation time).'),
  productImageSearchQueries: z
    .array(z.string())
    .default([])
    .describe('Brave Image Search queries for official product/packshot images.')
})
  .describe('Brand style guide object')
  .strict();

const logoImageSearchQueriesModel = z
  .array(z.string().min(5))
  .min(3)
  .max(12)
  .describe(
    '3-12 Brave Image Search queries to find the official logo. Prefer site:hostname from brandURL/companyURL, inurl:logo, filetype:svg. No third-party scraper sites.'
  );

const productImageSearchQueriesModel = z
  .array(z.string().min(5))
  .min(3)
  .max(15)
  .describe(
    '3-15 Brave Image Search queries for official product/packshot images. Prefer site:official host, packshot, key art; avoid thumbnails and wallpapers unless gaming.'
  );

export type StyleGuide = z.infer<typeof brandStyleGuideSchema>;

const brandStyleGuideModelSchema = brandStyleGuideSchema
  .omit({
    logoFileUrls: true,
    productPictureUrls: true
  })
  .extend({
    logoImageSearchQueries: logoImageSearchQueriesModel,
    productImageSearchQueries: productImageSearchQueriesModel
  });

loadDotenv({ path: join(repoRootFromModuleDir(import.meta.dirname), '.env') });
const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const braveApiKeyConfigured = process.env['BRAVE_API_KEY']?.trim();
if (braveApiKeyConfigured === undefined || braveApiKeyConfigured.length === 0) {
  throw new Error('Missing BRAVE_API_KEY. Set it in project root .env (Brave Search API key for image search).');
}

const contextPrompt = resolveStyleGuideContextPrompt(defaultStyleGuideContextPrompt());

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
let styleGuideFromModel: z.infer<typeof brandStyleGuideModelSchema> | null = null;
const localSkillGuidance = loadSkillGuidance();

let i = 0;

const apiUsageTotals = createEmptyUsageAccumulator();

while (true) {
  i += 1;

  console.log(`Generating style guide ... (i=${i})`);

  const styleGuideResponse = await withAnthropicRetry(`style-guide turn ${String(i)}`, async () => {
    const styleGuideStream = await anthropicClient.messages.stream({
      max_tokens: 128000,
      system: `
      You are an agent that assembles brand style guides based on external information.
      The information should ideally be sourced from the brand or company's official websites.
      No information should come from the model memory. It should always be fetched remotely to ensure freshness.

      Make sure to understand who the company or brand is and what the context is.
      If a product name or category is specified analyse the problem with it in mind.

      Do not invent or guess direct image URLs for logos or product photos. Logos and product images are
      downloaded after your JSON via the Brave Images API using logoImageSearchQueries and productImageSearchQueries.

      Logo (critical):
      - Use web_search to find the real logo asset page on companyURL and brandURL (paths like /logo, /brand, /identite-visuelle, /press, /media).
      - Fill logoImageSearchQueries with 3-12 highly specific Brave queries discovered from that research. Put the best queries first.
      - Every query should target the official site: use site:hostname, inurl:logo, filetype:svg or filetype:png when appropriate.
      - Never use KindPNG, PNGaaa, Pinterest, or generic "transparent logo PNG" without site:official host.
      - Opaque PNG/JPEG on brand background and official SVG wordmarks are valid.

      Product images:
      - Use web_search for official product pages, press kits, and catalog imagery on brandURL.
      - Fill productImageSearchQueries with 3-15 queries: site:official host, product name, packshot, official photo, key art.
      - Avoid wallpaper, thumbnail, screenshot aggregator URLs in your queries (do not search gaming-cdn thumbs for retail brands).

      companyURL and brandURL must be valid canonical HTTPS URLs from web_search (not guessed).
      When specifying colors, always check that the color exists and matches the one described in the official sources.
      Every entry in primaryColorPalette and secondaryColorPalette must be a CSS hex with the # prefix (e.g. #1F4E8C, not 1F4E8C).

      Use web_search for company/brand facts, official pages, typography and color references only.
      keep it simple and clean for visual direction in text (no image URLs in your output schema for assets).
      The local design skills below are mandatory constraints.
      Before returning final JSON, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep searching and refining, and do not finalize yet.
      ${localSkillGuidance}
    `.trim(),
      messages,
      model: 'claude-opus-4-7',
      thinking: {
        type: 'adaptive',
        display: 'omitted'
      },
      output_config: {
        format: zodOutputFormat(brandStyleGuideModelSchema),
        effort: 'xhigh' as 'low' | 'medium' | 'high' | 'max' | null
      },
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 25
        }
      ]
    });
    return await styleGuideStream.finalMessage();
  });
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
    styleGuideFromModel = styleGuideResponse.parsed_output;
    break;
  }

  messages.push({
    role: 'user',
    content:
      'Continue: produce the full style guide JSON per the schema. Use web_search only for textual facts. '
      + 'Your structured output must not include logo or product image URLs (those fields are omitted from the schema). '
      + 'Complete all other fields and end the turn with valid structured output.'
  });
}

if (styleGuideFromModel === null) {
  throw new Error('Empty style guide response');
}

const directoryUuid = randomUUID();
const outputDirectoryName = directoryUuid;
const directoryPath = join(repoRootFromModuleDir(import.meta.dirname), 'output', outputDirectoryName);

console.log(`Output directory path: ${directoryPath}`);
console.log('Download assets: required');

mkdirSync(directoryPath);

const imageContext = {
  brandName: styleGuideFromModel.brandName,
  companyName: styleGuideFromModel.companyName,
  productName: styleGuideFromModel.productName,
  brandURL: styleGuideFromModel.brandURL,
  companyURL: styleGuideFromModel.companyURL,
  logoImageSearchQueries: styleGuideFromModel.logoImageSearchQueries,
  productImageSearchQueries: styleGuideFromModel.productImageSearchQueries
};

console.log('[Brave images] Collecting logo candidates…');
const logoDownload = await collectAndDownloadValidAssetUrls(
  'logos',
  directoryPath,
  buildLogoSearchQueries(imageContext),
  {
    targetCount: 2,
    candidatePool: braveLogoCandidatePool(),
    clearFolder: true,
    officialHosts: officialHostsFromContext(imageContext)
  }
);

console.log('[Brave images] Collecting product photo candidates…');
const productDownload = await collectAndDownloadValidAssetUrls(
  'products',
  directoryPath,
  buildProductSearchQueries(imageContext),
  {
    targetCount: braveProductTargetCount(),
    candidatePool: braveProductCandidatePool(),
    clearFolder: true,
    officialHosts: officialHostsFromContext(imageContext)
  }
);

const minimumAssetsPerType = 1;
if (logoDownload.count < minimumAssetsPerType || productDownload.count < minimumAssetsPerType) {
  throw new Error(
    `Asset download requirements not met (logos: ${String(logoDownload.count)}/${String(minimumAssetsPerType)}, products: ${String(productDownload.count)}/${String(minimumAssetsPerType)}).`
  );
}

const finalMessageContent: StyleGuide = brandStyleGuideSchema.parse({
  ...styleGuideFromModel,
  logoFileUrls: logoDownload.downloadedUrls,
  productPictureUrls: productDownload.downloadedUrls
});

const styleGuideFilePath = join(directoryPath, 'style-guide.json');
writeFileSync(
  styleGuideFilePath,
  `${JSON.stringify(finalMessageContent, null, 2)}\n`,
  { encoding: 'utf8' }
);

logAnthropicUsageAndCost(basename(import.meta.filename, extname(import.meta.filename)), apiUsageTotals);

const styleGuidePipelineEntry = entryFromAccumulator({
  action: 'style_guide',
  agent: 'agents/gen-style-guide.mts',
  model: STYLE_GUIDE_MODEL,
  acc: apiUsageTotals
});
const styleGuidePipelineFile = appendPipelineUsage(directoryPath, styleGuidePipelineEntry);
logPipelineUsageToConsole(styleGuidePipelineFile.entries[styleGuidePipelineFile.entries.length - 1]!);

console.log('End.');
