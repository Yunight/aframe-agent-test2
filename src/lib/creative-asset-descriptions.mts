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
import { buildProductMatchFields, isCatalogCampaign, resolveCampaignAssetProfile } from './style-guide-context.mts';
import { readLogoFileAsAnthropicImageBlock } from './logo-rasterize.mts';
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

export const assetKindSchema = z.enum([
  'product_packshot',
  'lifestyle_scene',
  'text_only_banner',
  'theatrical_poster',
  'key_art',
  'film_still',
  'promotional_photo',
  'attraction_photo',
  'ticket_pass',
  'venue_lifestyle',
  'mascot_brand',
  'logo',
  'other'
]);

/** Film/series promo kinds accepted by entertainment audit (not retail packshots). */
export const ENTERTAINMENT_PROMO_ASSET_KINDS = new Set([
  'theatrical_poster',
  'key_art',
  'film_still',
  'promotional_photo',
  'lifestyle_scene'
]);

/** Theme park / destination promo kinds accepted by experience audit. */
export const EXPERIENCE_PROMO_ASSET_KINDS = new Set([
  'attraction_photo',
  'ticket_pass',
  'venue_lifestyle',
  'lifestyle_scene',
  'promotional_photo',
  'product_packshot'
]);

/** Promo / experience visuals usable as ad heroes (not text-only navigation tiles). */
export const USABLE_PROMO_ASSET_KINDS = new Set([
  'product_packshot',
  'lifestyle_scene',
  ...ENTERTAINMENT_PROMO_ASSET_KINDS,
  ...EXPERIENCE_PROMO_ASSET_KINDS
]);

export const assetDescriptionEntrySchema = z.object({
  asset_id: z.string(),
  fileName: z.string(),
  fileType: z.enum([ 'logos', 'products' ]),
  description: z.string(),
  layout_hints: z.array(z.string()),
  dominant_colors: z.array(z.string()),
  shows_physical_product: z.boolean().optional(),
  asset_kind: assetKindSchema.optional(),
  /** Concrete SKU / ritual / kit name visible in the image (products only). */
  primary_product_name: z.string().optional(),
  /** True when the image is a multi-SKU flat-lay with no single dominant product. */
  is_generic_collection: z.boolean().optional()
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
  const raw = process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 0;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return n;
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
  officialHosts: readonly string[],
  descriptions?: AssetDescriptionsFile | null
): Promise<string[]> {
  const sourceMap = loadProductAssetSources(directoryPath);
  const descByKey = descriptionMapFromFile(descriptions ?? null);
  const scored: { fileName: string; score: number }[] = [];
  for (const fileName of fileNames) {
    let score = 0;
    const sourceUrl = sourceMap.get(fileName)?.sourceUrl ?? '';
    if (urlHostMatchesOfficial(sourceUrl, officialHosts)) {
      score += 1000;
    }
    const entry = descByKey.get(`products/${fileName}`) ?? descByKey.get(fileName);
    const usablePromo =
      entry?.asset_kind !== undefined && USABLE_PROMO_ASSET_KINDS.has(entry.asset_kind);
    if (entry?.shows_physical_product === true || usablePromo) {
      score += 5000;
    } else if (entry?.asset_kind === 'text_only_banner') {
      score -= 10_000;
    } else if (entry?.shows_physical_product === false) {
      score -= 5000;
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
  const rankedProducts = await rankProductFiles(
    params.directoryPath,
    allProducts,
    officialHosts,
    descriptions
  );
  const selectedProducts =
    maxProducts === 0
      ? new Set(rankedProducts)
      : new Set(rankedProducts.slice(0, maxProducts));
  if (maxProducts > 0 && allProducts.length > maxProducts) {
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

export type DescribeAssetsOptions = {
  anthropicClient: Anthropic;
  directoryPath: string;
  styleGuide: StyleGuide;
  model?: string;
  reviewRound?: number;
  phase?: 'style_guide' | 'creative';
};

export async function describeAssetsForReview (
  params: DescribeAssetsOptions
): Promise<DescribeApprovedAssetsResult | null> {
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

  const profile = resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: params.styleGuide.campaignContext ?? null,
    productName: params.styleGuide.productName,
    brandName: params.styleGuide.brandName,
    brandContext: params.styleGuide.brandContext,
    brandURL: params.styleGuide.brandURL,
    campaignAssetProfile: params.styleGuide.campaignAssetProfile
  }));
  console.log(`[asset-descriptions] Campaign asset profile: ${profile}`);

  const describeIntro =
    profile === 'entertainment'
      ? 'Describe each asset below factually for film/series promotional ad review (French descriptions OK). ' +
        'Focus on: poster/key art/stills, cast, title treatment, framing, readable title text, colors.\n'
      : profile === 'experience'
        ? 'Describe each asset below factually for theme park / leisure / destination ad review (French descriptions OK). ' +
          'Focus on: attractions, rides, families, tickets/passes, mascot, venue atmosphere, readable promo text.\n'
        : 'Describe each asset below factually for HTML5 display ad review (French descriptions OK). ' +
          'Focus on: subject, framing, background, readable text on image, colors, photographed products vs text-only graphics.\n';

  const entertainmentRules =
    'Entertainment campaign: products/ are film promotional visuals (posters, key art, stills, cast photos) — NOT retail packshots. ' +
    'Set shows_physical_product=false for theatrical posters, key art, and film stills (normal). ' +
    'Set asset_kind=theatrical_poster | key_art | film_still | promotional_photo | lifestyle_scene as appropriate. ' +
    'Set text_only_banner only for category navigation tiles with no film imagery. ' +
    `Set primary_product_name to the film title (e.g. "${params.styleGuide.productName}") — same title on multiple assets is OK. ` +
    'Set is_generic_collection=false for all entertainment assets.';

  const experienceRules =
    'Experience campaign (theme park, destination, ticketing): products/ are attraction photos, family lifestyle, passes/tickets — NOT retail SKU packshots. ' +
    'Set shows_physical_product=false for rides, attractions, venue scenes, and family moments (normal). ' +
    'Set shows_physical_product=true only when a physical ticket/pass/gift card is visibly photographed. ' +
    'Set asset_kind=attraction_photo | venue_lifestyle | ticket_pass | lifestyle_scene | mascot_brand | promotional_photo as appropriate. ' +
    'Set text_only_banner only for category navigation tiles with no park/attraction imagery. ' +
    `Set primary_product_name to attraction name, ticket type, or campaign offer (e.g. "${params.styleGuide.productName}", "Abonnement Saison", "Mahuka") — generic visit labels are OK. ` +
    'Set is_generic_collection=false for all experience assets.';

  const retailRules =
    'Set shows_physical_product=true only when a real product (packshot, box, garment, food item, etc.) is visibly photographed. ' +
    'Set shows_physical_product=false for category navigation tiles, menu graphics, or promo banners with only typography on a colored background. ' +
    'Set asset_kind=text_only_banner for those text-only graphics; product_packshot or lifestyle_scene when merchandise is visible.\n' +
    'For each products/ asset with shows_physical_product=true: set primary_product_name to the concrete dominant SKU/ritual/kit name visible ' +
    '(e.g. "Sommeil", "Kit Bubble Tea Litchi Rose") — never vague labels like "thés Kusmi" or "sélection". ' +
    'If multiple products appear, name the most prominent hero. ' +
    'Set is_generic_collection=true only for flat-lays showing many different SKUs with no single dominant product; otherwise false.';

  const expectedAssets: { asset_id: string; fileName: string; fileType: 'logos' | 'products' }[] = [];
  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        describeIntro +
        `Brand: ${params.styleGuide.brandName}\n` +
        `Campaign product: ${params.styleGuide.productName}\n` +
        (params.styleGuide.campaignContext !== undefined && params.styleGuide.campaignContext.length > 0
          ? `Campaign context: ${params.styleGuide.campaignContext}\n`
          : '') +
        (params.styleGuide.campaignReferenceUrl !== undefined &&
        params.styleGuide.campaignReferenceUrl.length > 0
          ? `Campaign reference URL: ${params.styleGuide.campaignReferenceUrl}\n`
          : '') +
        (params.styleGuide.brandContext !== undefined && params.styleGuide.brandContext.length > 0
          ? `Brand context: ${params.styleGuide.brandContext}\n`
          : '') +
        (catalog
          ? 'Catalog campaign: each product image may be one SKU from the collection.\n'
          : '') +
        (profile === 'entertainment'
          ? entertainmentRules
          : profile === 'experience'
            ? experienceRules
            : retailRules)
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

      if (fileType === 'logos') {
        const logoBlock = await readLogoFileAsAnthropicImageBlock(filePath);
        if (logoBlock !== null) {
          userContent.push(logoBlock);
        } else {
          userContent.push({ type: 'text', text: `(unreadable logo: ${filePath})` });
        }
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

  const systemPrompt =
    profile === 'entertainment'
      ? [
          'You write factual visual descriptions for film/series promotional assets before HTML5 ad approval.',
          'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
          'shows_physical_product (required): false for posters/key art/stills; true only if merchandise (DVD box, etc.) is visibly photographed.',
          'asset_kind (required): theatrical_poster | key_art | film_still | promotional_photo | lifestyle_scene | text_only_banner | logo | other.',
          'primary_product_name (required for products/): film title; same title on multiple assets is expected.',
          'is_generic_collection (required for products/): always false for entertainment campaigns.',
          'layout_hints: short tags e.g. theatrical-poster, key-art, character-close-up, ensemble-cast, production-still, logo-lockup.',
          'dominant_colors: up to 4 hex colors if visible, else empty array.',
          'description: 2-4 factual sentences — identify poster vs still vs BTS; state title text if readable.'
        ].join('\n')
      : profile === 'experience'
        ? [
            'You write factual visual descriptions for theme park / leisure / destination assets before HTML5 ad approval.',
            'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
            'shows_physical_product (required): false for attractions/rides/family scenes; true only for photographed tickets/passes/gift cards.',
            'asset_kind (required): attraction_photo | venue_lifestyle | ticket_pass | lifestyle_scene | mascot_brand | promotional_photo | text_only_banner | logo | other.',
            'primary_product_name (required for products/): attraction name, ticket/pass type, or campaign offer — not retail SKU codes.',
            'is_generic_collection (required for products/): always false for experience campaigns.',
            'layout_hints: short tags e.g. roller-coaster-action, family-moment, ticket-pass, mascot-hero, ride-action, park-setting.',
            'dominant_colors: up to 4 hex colors if visible, else empty array.',
            'description: 2-4 factual sentences — identify ride vs family scene vs ticket; name attraction if visible.'
          ].join('\n')
        : [
            'You write factual visual descriptions for brand assets before HTML5 ad approval.',
            'Return one entry per asset id listed in the user message (exact asset_id, fileName, fileType).',
            'shows_physical_product (required): true if a product is visibly photographed; false for text-only banners/tiles.',
            'asset_kind (required): product_packshot | lifestyle_scene | text_only_banner | logo | other.',
            'primary_product_name (required for products/ with shows_physical_product=true): concrete SKU/ritual/kit name; empty for logos.',
            'is_generic_collection (required for products/): true only when no single dominant SKU is identifiable.',
            'layout_hints: short tags e.g. packshot-centre, lifestyle-scene, categorie-banner, logo-lockup.',
            'dominant_colors: up to 4 hex colors if visible, else empty array.',
            'description: 2-4 factual sentences — state explicitly when an image contains only text on a solid/gradient background.'
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
    phase: params.phase ?? 'style_guide',
    ...(params.reviewRound !== undefined ? { review_round: params.reviewRound } : {}),
    duration_ms: apiDurationMs
  });
  logPipelineUsageToConsole(appendPipelineUsage(params.directoryPath, pipelineEntry).entries.at(-1)!);

  return { file, usage };
}

/** Post-approval alias — same vision describe used during review when assets are already vetted. */
export async function describeApprovedAssets (params: {
  anthropicClient: Anthropic;
  directoryPath: string;
  styleGuide: StyleGuide;
  model?: string;
}): Promise<DescribeApprovedAssetsResult | null> {
  return await describeAssetsForReview({ ...params, phase: 'style_guide' });
}
