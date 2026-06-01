import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { withAnthropicRetry } from './anthropic-retry.mts';
import type { AssetFile } from './creative-native-skills.mts';
import { officialHostsFromContext, type ImageSearchContext } from './brave-image-assets.mts';
import {
  appendPipelineUsage,
  entryFromSingleUsage,
  logPipelineUsageToConsole,
  timedAnthropicCall
} from './creative-pipeline-usage.mts';
import { isCatalogCampaign } from './style-guide-context.mts';
import { isSvgAssetFile, readFileAsAnthropicImageBlock, sniffImageMimeFromBuffer } from './image-mime-sniff.mts';
import { listAssetImageFiles } from './asset-sidecar-files.mts';
import { loadProductAssetSources } from './product-asset-sources.mts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { imageSizeFromFile } from 'image-size/fromFile';

export const DEFAULT_ASSET_DESCRIPTION_MODEL = 'claude-haiku-4-5-20251001';

export const assetDescriptionEntrySchema = z.object({
  asset_id: z.string(),
  fileName: z.string(),
  fileType: z.enum([ 'logos', 'products' ]),
  description: z.string(),
  layout_hints: z.array(z.string()),
  dominant_colors: z.array(z.string())
});

export const assetDescriptionsFileSchema = z.object({
  generated_at: z.string(),
  model: z.string(),
  assets: z.array(assetDescriptionEntrySchema)
});

export type AssetDescriptionEntry = z.infer<typeof assetDescriptionEntrySchema>;
export type AssetDescriptionsFile = z.infer<typeof assetDescriptionsFileSchema>;

const describeBatchOutputSchema = z.object({
  assets: z.array(assetDescriptionEntrySchema)
});

export function assetDescriptionsPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'asset-descriptions.json');
}

export function loadAssetDescriptions (directoryPath: string): AssetDescriptionsFile | null {
  const path = assetDescriptionsPath(directoryPath);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return assetDescriptionsFileSchema.parse(raw);
  } catch {
    return null;
  }
}

function parseEnvInt (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function maxProductAssetsForCodegen (): number {
  return parseEnvInt('CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS', 5);
}

function listAssetFiles (directoryPath: string, fileType: 'logos' | 'products'): string[] {
  return listAssetImageFiles(directoryPath, fileType);
}

function filenameFallbackDescription (fileName: string, fileType: 'logos' | 'products'): string {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const keywordString = baseName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const categoryLabel = fileType === 'logos' ? 'logo de marque' : 'visuel produit';
  const usageHint =
    fileType === 'logos'
      ? 'a utiliser en branding (header, badge, signature visuelle)'
      : 'a utiliser comme visuel hero ou element de scene principal';
  return `Description asset (${categoryLabel}): ${keywordString || baseName}. ${usageHint}.`;
}

function descriptionMapFromFile (file: AssetDescriptionsFile | null): Map<string, AssetDescriptionEntry> {
  const map = new Map<string, AssetDescriptionEntry>();
  if (file === null) {
    return map;
  }
  for (const entry of file.assets) {
    map.set(`${entry.fileType}/${entry.fileName}`, entry);
    map.set(entry.fileName, entry);
  }
  return map;
}

function urlHostMatchesOfficial (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0 || url.length === 0) {
    return false;
  }
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
    return officialHosts.some((oh) => h === oh || h.endsWith(`.${oh}`) || oh.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

async function rankProductFiles (
  directoryPath: string,
  fileNames: string[],
  officialHosts: readonly string[]
): Promise<string[]> {
  const sourceMap = loadProductAssetSources(directoryPath);
  const scored: { fileName: string; score: number }[] = [];
  for (const fileName of fileNames) {
    let score = 0;
    const sourceUrl = sourceMap.get(fileName)?.sourceUrl ?? '';
    if (urlHostMatchesOfficial(sourceUrl, officialHosts)) {
      score += 1000;
    }
    try {
      const filePath = join(directoryPath, 'products', fileName);
      const { width, height } = await imageSizeFromFile(filePath);
      score += (width ?? 0) * (height ?? 0);
    } catch {
      score += 0;
    }
    scored.push({ fileName, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.fileName);
}

export type BuildCodegenAssetPromptResult = {
  fileMessages: Anthropic.Messages.TextBlockParam[];
  assetFiles: AssetFile[];
  usedPrecomputedDescriptions: boolean;
};

export async function buildCodegenAssetPromptBlocks (params: {
  directoryPath: string;
  styleGuide: StyleGuide;
  descriptionsFile?: AssetDescriptionsFile | null;
  /** Return false to omit a file from the codegen prompt (e.g. video in habillage). */
  shouldIncludeFile?: (file: {
    fileName: string;
    fileType: 'logos' | 'products';
    sniffedMime: string | null;
  }) => boolean;
}): Promise<BuildCodegenAssetPromptResult> {
  const descriptions =
    params.descriptionsFile !== undefined
      ? params.descriptionsFile
      : loadAssetDescriptions(params.directoryPath);
  const descByKey = descriptionMapFromFile(descriptions);
  const usedPrecomputed = descriptions !== null && descriptions.assets.length > 0;

  if (usedPrecomputed) {
    console.log(
      `[creative-native] Using precomputed asset descriptions (${String(descriptions!.assets.length)} assets).`
    );
  } else {
    console.warn(
      '[creative-native] No review/asset-descriptions.json — using filename fallback descriptions.'
    );
  }

  const imageCtx: ImageSearchContext = {
    brandName: params.styleGuide.brandName,
    companyName: params.styleGuide.companyName,
    productName: params.styleGuide.productName,
    brandURL: params.styleGuide.brandURL,
    companyURL: params.styleGuide.companyURL
  };
  const officialHosts = officialHostsFromContext(imageCtx);
  const sourceMap = loadProductAssetSources(params.directoryPath);

  const maxProducts = maxProductAssetsForCodegen();
  const allProducts = listAssetFiles(params.directoryPath, 'products');
  const rankedProducts = await rankProductFiles(params.directoryPath, allProducts, officialHosts);
  const selectedProducts = new Set(rankedProducts.slice(0, maxProducts));
  if (allProducts.length > maxProducts) {
    console.log(
      `[creative-native] Product assets capped at ${String(maxProducts)} of ${String(allProducts.length)} for codegen prompt.`
    );
  }

  const fileMessages: Anthropic.Messages.TextBlockParam[] = [];
  const assetFiles: AssetFile[] = [];

  const refUrl = params.styleGuide.campaignReferenceUrl?.trim() ?? '';
  if (refUrl.length > 0) {
    fileMessages.push({
      type: 'text',
      text:
        `Campaign reference URL (listing/collection page for this creative): ${refUrl}\n` +
        'Use product assets as heroes from this campaign context.'
    });
  }

  for (const fileType of [ 'logos', 'products' ] as const) {
    const fileList = listAssetFiles(params.directoryPath, fileType);
    for (const fileName of fileList) {
      if (fileType === 'products' && !selectedProducts.has(fileName)) {
        continue;
      }

      const filePath = join(params.directoryPath, fileType, fileName);
      const fileBuf = readFileSync(filePath);
      const sniffedMimeEarly = sniffImageMimeFromBuffer(fileBuf);
      if (
        params.shouldIncludeFile !== undefined &&
        !params.shouldIncludeFile({
          fileName,
          fileType,
          sniffedMime: sniffedMimeEarly
        })
      ) {
        continue;
      }
      const assetId = `${fileType}/${fileName}`;
      const entry = descByKey.get(assetId) ?? descByKey.get(fileName);
      const description =
        entry?.description ?? filenameFallbackDescription(fileName, fileType);
      const layoutHints =
        entry !== undefined && entry.layout_hints.length > 0
          ? `\n  - Layout hints: ${entry.layout_hints.join(', ')}`
          : '';
      const colors =
        entry !== undefined && entry.dominant_colors.length > 0
          ? `\n  - Dominant colors (reference only — do NOT use in CSS; style-guide palette is mandatory): ${entry.dominant_colors.join(', ')}`
          : '';
      const sourceUrl = sourceMap.get(fileName)?.sourceUrl ?? '';
      const sourceLine =
        sourceUrl.length > 0 ? `\n  - Source URL (context): ${sourceUrl}` : '';
      const localCodePath = `./${fileName}`;

      if (isSvgAssetFile(fileName, fileBuf)) {
        const textPayload =
          `- Asset: ${fileName}\n` +
          `  - Category: logo\n` +
          `  - Format: SVG vector (pre-approved; no image block in this prompt)\n` +
          `  - Local path to use in generated code: ${localCodePath}\n` +
          `  - Visual description (authoritative): ${description}${layoutHints}${colors}\n` +
          `  - Use in HTML as <img src="${localCodePath}" alt="logo">; path is relative to index.html in code/\n` +
          `  - Integrate this SVG wordmark at a readable scale without filters.`;
        fileMessages.push({ type: 'text', text: textPayload });
        assetFiles.push({ fileName, filePath, fileType });
        continue;
      }

      const sniffedMime = sniffImageMimeFromBuffer(fileBuf);
      if (sniffedMime === null) {
        console.warn(
          `[creative-native] Skipping non-image asset ${fileType}/${fileName} (not a raster/SVG image).`
        );
        continue;
      }

      const { width, height } = await imageSizeFromFile(filePath);
      const textPayload =
        `- Asset: ${fileName}\n` +
        `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
        `  - Local path to use in generated code: ${localCodePath}\n` +
        `  - Dimensions: ${String(width)}×${String(height)}\n` +
        `  - Visual description (authoritative — do not re-infer from pixels): ${description}${layoutHints}${colors}${sourceLine}\n` +
        `  - Integrate visually in the creative using the local path above.`;
      fileMessages.push({ type: 'text', text: textPayload });
      assetFiles.push({ fileName, filePath, fileType });
    }
  }

  return { fileMessages, assetFiles, usedPrecomputedDescriptions: usedPrecomputed };
}

export type DescribeApprovedAssetsResult = {
  file: AssetDescriptionsFile;
  usage: {
    api_calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
};

export async function describeApprovedAssets (params: {
  anthropicClient: Anthropic;
  directoryPath: string;
  styleGuide: StyleGuide;
  model?: string;
}): Promise<DescribeApprovedAssetsResult | null> {
  if (process.env['STYLE_GUIDE_SKIP_ASSET_DESCRIPTIONS']?.trim() === '1') {
    console.log('[asset-descriptions] Skipped (STYLE_GUIDE_SKIP_ASSET_DESCRIPTIONS=1).');
    return null;
  }

  const model =
    params.model ?? process.env['CREATIVE_ASSET_DESCRIPTION_MODEL']?.trim() ?? DEFAULT_ASSET_DESCRIPTION_MODEL;

  const catalog = isCatalogCampaign({
    campaignContext: params.styleGuide.campaignContext ?? null,
    productName: params.styleGuide.productName,
    brandName: params.styleGuide.brandName,
    brandContext: params.styleGuide.brandContext,
    brandURL: params.styleGuide.brandURL
  });

  const expectedAssets: { asset_id: string; fileName: string; fileType: 'logos' | 'products' }[] = [];
  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        'Describe each asset below for HTML5 display ad layout (French descriptions OK). ' +
        'Focus on: subject, framing, background, readable text on image, colors, and how to use as hero or logo. ' +
        'This is NOT a quality audit — assets are already approved.\n' +
        `Brand: ${params.styleGuide.brandName}\n` +
        `Campaign product: ${params.styleGuide.productName}\n` +
        (params.styleGuide.campaignContext !== undefined && params.styleGuide.campaignContext.length > 0
          ? `Campaign context: ${params.styleGuide.campaignContext}\n`
          : '') +
        (params.styleGuide.campaignReferenceUrl !== undefined &&
        params.styleGuide.campaignReferenceUrl.length > 0
          ? `Campaign reference URL: ${params.styleGuide.campaignReferenceUrl}\n`
          : '') +
        (catalog
          ? 'Catalog campaign: each product image may be one SKU from the collection; mention it can rotate as hero.\n'
          : '')
    }
  ];

  for (const fileType of [ 'logos', 'products' ] as const) {
    const files = listAssetFiles(params.directoryPath, fileType);
    if (files.length === 0) {
      continue;
    }
    userContent.push({
      type: 'text',
      text: `--- ${fileType} (${String(files.length)} file(s)) ---`
    });
    for (const fileName of files) {
      const asset_id = `${fileType}/${fileName}`;
      expectedAssets.push({ asset_id, fileName, fileType });
      const filePath = join(params.directoryPath, fileType, fileName);
      userContent.push({ type: 'text', text: `Asset id: ${asset_id}` });

      if (fileType === 'logos' && fileName.toLowerCase().endsWith('.svg')) {
        const svgText = readFileSync(filePath, 'utf8').slice(0, 8000);
        userContent.push({
          type: 'text',
          text: `SVG markup (truncated):\n${svgText}`
        });
        continue;
      }

      const block = readFileAsAnthropicImageBlock(filePath);
      if (block !== null) {
        userContent.push(block);
      } else {
        userContent.push({ type: 'text', text: `(unreadable raster: ${filePath})` });
      }
    }
  }

  if (expectedAssets.length === 0) {
    console.log('[asset-descriptions] No assets to describe.');
    return null;
  }

  const systemPrompt = [
    'You write concise visual descriptions for approved brand assets used in HTML5 banners.',
    'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
    'layout_hints: short tags e.g. hero, logo-lockup, fond-clair, packshot-centre.',
    'dominant_colors: up to 4 hex colors if visible, else empty array.',
    'description: 2-4 sentences for ad layout integration.'
  ].join('\n');

  console.log(`[asset-descriptions] Describing ${String(expectedAssets.length)} asset(s) — model ${model}`);

  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    'asset-descriptions batch',
    async () =>
      await withAnthropicRetry('asset-descriptions batch', async () => {
        return await params.anthropicClient.messages.parse({
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages: [ { role: 'user', content: userContent } ],
          output_config: {
            format: zodOutputFormat(describeBatchOutputSchema)
          }
        });
      })
  );

  if (msg.parsed_output === null || msg.parsed_output === undefined) {
    throw new Error('Asset descriptions: empty structured output from API.');
  }

  const parsed = describeBatchOutputSchema.parse(msg.parsed_output);
  const file: AssetDescriptionsFile = {
    generated_at: new Date().toISOString(),
    model,
    assets: parsed.assets
  };

  const reviewDir = join(params.directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const outPath = assetDescriptionsPath(params.directoryPath);
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  console.log(`[asset-descriptions] Wrote ${outPath} (${String(file.assets.length)} entries).`);

  const usage = {
    api_calls: 1,
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0
  };

  const pipelineEntry = entryFromSingleUsage({
    action: 'asset_descriptions',
    agent: 'lib/creative-asset-descriptions.mts',
    model,
    usage: msg.usage,
    phase: 'style_guide',
    duration_ms: apiDurationMs
  });
  logPipelineUsageToConsole(appendPipelineUsage(params.directoryPath, pipelineEntry).entries.at(-1)!);

  return { file, usage };
}
