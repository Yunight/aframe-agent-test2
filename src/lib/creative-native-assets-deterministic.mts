import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import {
  allowedImageMimeTypes,
  imageContextFromStyleGuide,
  officialHostsFromContext,
  type ImageSearchContext
} from './brave-image-assets.mts';
import { listAssetImageFiles } from './asset-sidecar-files.mts';
import {
  loadProductAssetSources,
  removeProductAssetSource
} from './product-asset-sources.mts';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';
import { looksLikeProductPackshotInLogosFolder } from './logo-asset-rules.mts';
import {
  loadLogoAssetSources,
  logoValidationContextFromEntry,
  removeLogoAssetSource
} from './logo-asset-sources.mts';
import { validateLogoAssetFile } from './logo-transparency-check.mts';
import {
  buildProductMatchFields,
  buildProductMatchTerms,
  isListingPageCampaign,
  productMinRelevanceScore,
  resolveCampaignAssetProfile,
  resolveReferenceListingUrls,
  scoreProductContextRelevance,
  wouldPassEntertainmentProductAsset,
  wouldPassExperienceProductAsset,
  wouldPassListingProductAsset
} from './style-guide-context.mts';

export type DeterministicFinding = {
  asset_id: string;
  severity: 'blocker' | 'warn';
  issue: string;
  fix_hint: string;
};

export type DeterministicAssetsCheckResult = {
  ok: boolean;
  findings: DeterministicFinding[];
};

function parseEnvInt (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIN_LOGO_W = () => parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_W', 1);
const MIN_LOGO_H = () => parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_H', 1);
const MIN_PRODUCT_W = () => parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_W', 1);
const MIN_PRODUCT_H = () => parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_H', 1);

export function getAssetMinDimensions (fileType: 'logos' | 'products'): {
  minW: number;
  minH: number;
} {
  if (fileType === 'logos') {
    return { minW: MIN_LOGO_W(), minH: MIN_LOGO_H() };
  }
  return { minW: MIN_PRODUCT_W(), minH: MIN_PRODUCT_H() };
}

export async function pruneOversizedAssets (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const maxBytes = MAX_FILE_BYTES();
  for (const fileType of [ 'logos', 'products' ] as const) {
    const subdirectoryPath = join(directoryPath, fileType);
    for (const fileName of listImageFiles(directoryPath, fileType)) {
      const filePath = join(subdirectoryPath, fileName);
      try {
        const sizeBytes = statSync(filePath).size;
        if (sizeBytes > maxBytes) {
          unlinkSync(filePath);
          removed.push(`${fileType}/${fileName}`);
          if (fileType === 'products') {
            removeProductAssetSource(directoryPath, fileName);
          }
          console.log(
            `[assets-prune] Removed oversized ${fileType}/${fileName} (${String(sizeBytes)} bytes, max ${String(maxBytes)})`
          );
        }
      } catch {
        /* keep for deterministic to flag */
      }
    }
  }
  return { removed };
}

export async function pruneUndersizedAssets (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const fileType of [ 'logos', 'products' ] as const) {
    const { minW, minH } = getAssetMinDimensions(fileType);
    const subdirectoryPath = join(directoryPath, fileType);
    for (const fileName of listImageFiles(directoryPath, fileType)) {
      if (fileType === 'logos' && extname(fileName).toLowerCase() === '.svg') {
        continue;
      }
      const filePath = join(subdirectoryPath, fileName);
      try {
        const { width, height } = await imageSizeFromFile(filePath);
        if (
          width !== undefined &&
          height !== undefined &&
          (width < minW || height < minH)
        ) {
          unlinkSync(filePath);
          removed.push(`${fileType}/${fileName}`);
          console.log(
            `[assets-prune] Removed undersized ${fileType}/${fileName} (${String(width)}×${String(height)}, min ${String(minW)}×${String(minH)})`
          );
        }
      } catch {
        /* corrupt files stay for deterministic to flag */
      }
    }
  }
  return { removed };
}

/** Remove product packshots mistakenly stored under logos/. */
export async function pruneNonWordmarkLogos (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const subdirectoryPath = join(directoryPath, 'logos');
  if (!existsSync(subdirectoryPath)) {
    return { removed };
  }
  for (const fileName of listImageFiles(directoryPath, 'logos')) {
    if (!looksLikeProductPackshotInLogosFolder(fileName)) {
      continue;
    }
    const filePath = join(subdirectoryPath, fileName);
    unlinkSync(filePath);
    removed.push(`logos/${fileName}`);
    console.log(`[assets-prune] Removed non-wordmark from logos/: ${fileName} (product/packshot heuristic)`);
  }
  return { removed };
}

export async function pruneInvalidLogos (
  directoryPath: string,
  officialHosts: readonly string[] = []
): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const subdirectoryPath = join(directoryPath, 'logos');
  const logoSources = loadLogoAssetSources(directoryPath);
  for (const fileName of listImageFiles(directoryPath, 'logos')) {
    const filePath = join(subdirectoryPath, fileName);
    const context = logoValidationContextFromEntry(logoSources.get(fileName), officialHosts);
    const check = validateLogoAssetFile(filePath, context);
    if (!check.ok) {
      unlinkSync(filePath);
      removeLogoAssetSource(directoryPath, fileName);
      removed.push(`logos/${fileName}`);
      console.log(`[assets-prune] Removed invalid logo ${fileName}: ${check.issue}`);
    }
  }
  return { removed };
}

const MAX_FILE_BYTES = () => parseEnvInt('CREATIVE_ASSETS_MAX_FILE_BYTES', 5 * 1024 * 1024);

function listImageFiles (directoryPath: string, fileType: 'logos' | 'products'): string[] {
  return listAssetImageFiles(directoryPath, fileType);
}

async function checkLogoFiles (
  directoryPath: string,
  minW: number,
  minH: number,
  officialHosts: readonly string[] = []
): Promise<DeterministicFinding[]> {
  const findings: DeterministicFinding[] = [];
  const subdirectoryPath = join(directoryPath, 'logos');
  const files = listImageFiles(directoryPath, 'logos');
  const logoSources = loadLogoAssetSources(directoryPath);

  if (files.length === 0) {
    findings.push({
      asset_id: 'logos',
      severity: 'blocker',
      issue: 'No files in logos/ directory.',
      fix_hint:
        'Run style guide generation or assets refresh to download one official logo (SVG, transparent PNG, or opaque PNG from brandURL header).'
    });
    return findings;
  }

  if (files.length > 1) {
    findings.push({
      asset_id: 'logos',
      severity: 'blocker',
      issue: `Expected exactly one logo file, found ${String(files.length)}.`,
      fix_hint: 'Keep a single transparent wordmark in logos/ (official site, then Wikipedia, then Brave).'
    });
  }

  for (const fileName of files) {
    const assetId = `logos/${fileName}`;
    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);
    const ext = extname(fileName).toLowerCase();
    const isSvg = ext === '.svg' || fileMimeType === 'image/svg+xml';

    if (!isSvg && (fileMimeType === null || !allowedImageMimeTypes.has(fileMimeType))) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Unsupported or unknown MIME type: ${fileMimeType ?? 'null'}.`,
        fix_hint: 'Use SVG or PNG/WebP with transparent pixels from the official site or Wikipedia.'
      });
      continue;
    }

    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > MAX_FILE_BYTES()) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `File size ${String(sizeBytes)} bytes exceeds max ${String(MAX_FILE_BYTES())}.`,
        fix_hint: 'Use a smaller image or raise CREATIVE_ASSETS_MAX_FILE_BYTES.'
      });
    }

    if (!isSvg && looksLikeProductPackshotInLogosFolder(fileName)) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: 'File in logos/ looks like a product packshot, not a brand wordmark.',
        fix_hint:
          'Keep only the official header logo (SVG/PNG lockup) in logos/. Move product images to products/ only.'
      });
      continue;
    }

    const validation = validateLogoAssetFile(
      filePath,
      logoValidationContextFromEntry(logoSources.get(fileName), officialHosts)
    );
    if (!validation.ok) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: validation.issue,
        fix_hint:
          'Source an official brand logo from brandURL/companyURL (SVG, transparent PNG, or opaque header PNG).'
      });
      continue;
    }

    if (validation.warn !== undefined) {
      findings.push({
        asset_id: assetId,
        severity: 'warn',
        issue: validation.warn,
        fix_hint:
          validation.tier === 'B'
            ? 'Tier B opaque official logo — Haiku vision audit must confirm brand identity.'
            : 'Prefer SVG or PNG with transparent pixels when available.'
      });
    }

    if (isSvg) {
      continue;
    }

    try {
      const { width, height } = await imageSizeFromFile(filePath);
      if (width === undefined || height === undefined) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: 'Could not read image dimensions.',
          fix_hint: 'Replace with a valid raster image file.'
        });
        continue;
      }
      if (width < minW || height < minH) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: `Dimensions ${String(width)}×${String(height)} below minimum ${String(minW)}×${String(minH)}.`,
          fix_hint: 'Download a higher-resolution logo via Brave refresh (official site).'
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Failed to read image: ${msg}`,
        fix_hint: 'Replace the corrupt file.'
      });
    }
  }

  return findings;
}

async function checkImageFiles (
  fileType: 'logos' | 'products',
  directoryPath: string,
  minW: number,
  minH: number,
  productMatch?: {
    terms: readonly string[];
    listing: boolean;
    entertainment: boolean;
    experience: boolean;
    referenceListingUrls: readonly string[];
    officialHosts: readonly string[];
  }
): Promise<DeterministicFinding[]> {
  if (fileType === 'logos') {
    return checkLogoFiles(
      directoryPath,
      minW,
      minH,
      productMatch?.officialHosts ?? []
    );
  }
  const findings: DeterministicFinding[] = [];
  const subdirectoryPath = join(directoryPath, fileType);
  const files = listImageFiles(directoryPath, fileType);

  if (files.length === 0) {
    findings.push({
      asset_id: fileType,
      severity: 'blocker',
      issue: `No files in ${fileType}/ directory.`,
      fix_hint: 'Run style guide generation or assets refresh to download at least one image.'
    });
    return findings;
  }

  for (const fileName of files) {
    const assetId = `${fileType}/${fileName}`;
    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);

    if (fileMimeType === null || !allowedImageMimeTypes.has(fileMimeType)) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Unsupported or unknown MIME type: ${fileMimeType ?? 'null'}.`,
        fix_hint: 'Replace with JPEG, PNG, WebP, or GIF.'
      });
      continue;
    }

    const ext = extname(fileName).toLowerCase();
    const expectedExt = fileMimeType === 'image/jpeg' ? '.jpg' : `.${fileMimeType.split('/')[1]}`;
    if (ext !== expectedExt && !(fileMimeType === 'image/jpeg' && ext === '.jpeg')) {
      findings.push({
        asset_id: assetId,
        severity: 'warn',
        issue: `Extension ${ext} may not match MIME ${fileMimeType}.`,
        fix_hint: 'Use a consistent file extension for the image type.'
      });
    }

    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > MAX_FILE_BYTES()) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `File size ${String(sizeBytes)} bytes exceeds max ${String(MAX_FILE_BYTES())}.`,
        fix_hint: 'Use a smaller image or raise CREATIVE_ASSETS_MAX_FILE_BYTES.'
      });
    }

    if (productMatch !== undefined && productMatch.terms.length > 0) {
      const sourceMap = loadProductAssetSources(directoryPath);
      const entry = sourceMap.get(fileName);
      const sourceUrl = entry?.sourceUrl ?? '';
      const minScore = productMinRelevanceScore();

      if (productMatch.entertainment) {
        if (
          !wouldPassEntertainmentProductAsset({
            entry,
            sourceUrl,
            referenceListingUrls: productMatch.referenceListingUrls,
            officialHosts: productMatch.officialHosts,
            terms: productMatch.terms,
            minScore,
            ...(entry?.sourceTitle !== undefined ? { sourceTitle: entry.sourceTitle } : {})
          })
        ) {
          findings.push({
            asset_id: assetId,
            severity: 'blocker',
            issue:
              'Product image is not from an official film/studio host or trusted cinema database (IMDb, Allociné).',
            fix_hint:
              'Use poster/key art from scarymovie.film, Paramount, IMDb, or Allociné — not fan merch or blogs.'
          });
          continue;
        }
      } else if (productMatch.experience) {
        if (
          !wouldPassExperienceProductAsset({
            entry,
            sourceUrl,
            referenceListingUrls: productMatch.referenceListingUrls,
            officialHosts: productMatch.officialHosts,
            terms: productMatch.terms,
            minScore,
            ...(entry?.sourceTitle !== undefined ? { sourceTitle: entry.sourceTitle } : {})
          })
        ) {
          findings.push({
            asset_id: assetId,
            severity: 'blocker',
            issue:
              'Product image is not from the official park/destination site or does not match campaign context.',
            fix_hint:
              'Use official attraction photos, lifestyle scenes, or ticket visuals from the brand domain.'
          });
          continue;
        }
      } else if (productMatch.listing) {
        if (
          !wouldPassListingProductAsset({
            entry,
            sourceUrl,
            referenceListingUrls: productMatch.referenceListingUrls,
            officialHosts: productMatch.officialHosts,
            terms: productMatch.terms,
            minScore
          })
        ) {
          findings.push({
            asset_id: assetId,
            severity: 'blocker',
            issue:
              'Product image is not from the campaign reference page or an official brand visual host.',
            fix_hint:
              'Re-scrape the campaign reference URL or use official product/promo images from the brand domain.'
          });
          continue;
        }
      } else {
        if (sourceUrl.length > 0) {
          const relevance = scoreProductContextRelevance(
            sourceUrl,
            entry?.sourceTitle ?? '',
            productMatch.terms
          );
          if (relevance < minScore) {
            findings.push({
              asset_id: assetId,
              severity: 'blocker',
              issue: 'Product image source URL does not match the campaign context or productName.',
              fix_hint:
                'Refresh assets with Brave queries that name the exact hero product from STYLE_GUIDE_CONTEXT (not other models from the range).'
            });
            continue;
          }
        } else {
          findings.push({
            asset_id: assetId,
            severity: 'warn',
            issue: 'Product image has no recorded source URL; context match could not be verified.',
            fix_hint: 'Re-download assets so product-asset-sources.json records the image URL.'
          });
        }
      }
    }

    try {
      const { width, height } = await imageSizeFromFile(filePath);
      if (width === undefined || height === undefined) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: 'Could not read image dimensions.',
          fix_hint: 'Replace with a valid raster image file.'
        });
        continue;
      }
      if (width < minW || height < minH) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: `Dimensions ${String(width)}×${String(height)} below minimum ${String(minW)}×${String(minH)}.`,
          fix_hint: 'Download a higher-resolution asset via Brave refresh.'
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Failed to read image: ${msg}`,
        fix_hint: 'Replace the corrupt file.'
      });
    }
  }

  return findings;
}

function checkStyleGuideFields (styleGuide: StyleGuide): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];

  if (styleGuide.brandName.trim().length === 0) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'brandName is empty.',
      fix_hint: 'Regenerate the style guide with a valid brand name.'
    });
  }

  if (styleGuide.primaryColorPalette.length < 1) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'primaryColorPalette has no colors.',
      fix_hint: 'Regenerate the style guide with at least one primary hex color.'
    });
  }

  if (styleGuide.typography.length < 1) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'typography array is empty.',
      fix_hint: 'Regenerate the style guide with typography entries.'
    });
  }

  const hexPattern = /^#[0-9A-Fa-f]{6}$/;
  for (const hex of [
    ...styleGuide.primaryColorPalette,
    ...styleGuide.secondaryColorPalette
  ]) {
    if (!hexPattern.test(hex)) {
      findings.push({
        asset_id: 'style_guide',
        severity: 'blocker',
        issue: `Invalid hex color: ${hex}`,
        fix_hint: 'Use #RRGGBB format in the style guide.'
      });
    }
  }

  return findings;
}

/** Remove listing-mode product files that would fail deterministic review (legacy folders). */
export function pruneListingIneligibleProducts (
  directoryPath: string,
  styleGuide: StyleGuide
): string[] {
  const referenceListingUrls = resolveReferenceListingUrls({
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  if (referenceListingUrls.length === 0) {
    return [];
  }

  const listing = isListingPageCampaign({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  if (!listing) {
    return [];
  }

  const imageCtx = imageContextFromStyleGuide(styleGuide);
  const officialHosts = officialHostsFromContext(imageCtx);
  const terms = buildProductMatchTerms({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL
  });
  if (terms.length === 0) {
    return [];
  }

  const sourceMap = loadProductAssetSources(directoryPath);
  const removed: string[] = [];

  for (const fileName of listAssetImageFiles(directoryPath, 'products')) {
    const entry = sourceMap.get(fileName);
    const sourceUrl = entry?.sourceUrl ?? '';
    if (
      wouldPassListingProductAsset({
        entry,
        sourceUrl,
        referenceListingUrls,
        officialHosts,
        terms
      })
    ) {
      continue;
    }
    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    removeProductAssetSource(directoryPath, fileName);
    removed.push(fileName);
  }

  if (removed.length > 0) {
    console.log(
      `[assets-deterministic] Pruned ${String(removed.length)} listing-ineligible product file(s): ${removed.join(', ')}`
    );
  }
  return removed;
}

export async function runDeterministicAssetsCheck (
  directoryPath: string,
  styleGuide: StyleGuide
): Promise<DeterministicAssetsCheckResult> {
  const styleGuidePath = join(directoryPath, 'style-guide.json');
  const findings: DeterministicFinding[] = [];

  if (!existsSync(styleGuidePath)) {
    return {
      ok: false,
      findings: [
        {
          asset_id: 'style_guide',
          severity: 'blocker',
          issue: 'Missing style-guide.json.',
          fix_hint: 'Run src/agents/gen-style-guide.mts first.'
        }
      ]
    };
  }

  try {
    JSON.parse(readFileSync(styleGuidePath, 'utf8'));
  } catch {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'style-guide.json is not valid JSON.',
      fix_hint: 'Fix or regenerate the style guide file.'
    });
  }

  findings.push(...checkStyleGuideFields(styleGuide));

  const imageCtx: ImageSearchContext = {
    brandName: styleGuide.brandName,
    companyName: styleGuide.companyName,
    productName: styleGuide.productName,
    brandURL: styleGuide.brandURL,
    companyURL: styleGuide.companyURL,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  };
  const officialHosts = officialHostsFromContext(imageCtx);

  findings.push(
    ...(await checkImageFiles('logos', directoryPath, MIN_LOGO_W(), MIN_LOGO_H(), {
      terms: [],
      listing: false,
      entertainment: false,
      experience: false,
      referenceListingUrls: [],
      officialHosts
    }))
  );

  const productMatchTerms = buildProductMatchTerms({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL
  });
  const referenceListingUrls = resolveReferenceListingUrls({
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  const listing = isListingPageCampaign({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  });
  const profile = resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: styleGuide.campaignContext ?? null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL,
    campaignAssetProfile: styleGuide.campaignAssetProfile,
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {})
  }));
  findings.push(
    ...(await checkImageFiles(
      'products',
      directoryPath,
      MIN_PRODUCT_W(),
      MIN_PRODUCT_H(),
      productMatchTerms.length > 0
        ? {
            terms: productMatchTerms,
            listing,
            entertainment: profile === 'entertainment',
            experience: profile === 'experience',
            referenceListingUrls,
            officialHosts
          }
        : undefined
    ))
  );

  const blockers = findings.filter((f) => f.severity === 'blocker');
  return {
    ok: blockers.length === 0,
    findings
  };
}

/** Remove product files flagged as blockers by deterministic pre-audit (before Brave retry). */
export function pruneDeterministicBlockedProducts (
  directoryPath: string,
  findings: readonly { severity: string; asset_id: string }[]
): { removed: string[]; excludedSourceUrls: string[] } {
  const removed: string[] = [];
  const excludedSourceUrls: string[] = [];
  const seenUrls = new Set<string>();
  const sourceMap = loadProductAssetSources(directoryPath);

  for (const f of findings) {
    if (f.severity !== 'blocker' || !f.asset_id.startsWith('products/')) {
      continue;
    }
    const fileName = f.asset_id.slice('products/'.length);
    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removed.push(f.asset_id);
    }
    const sourceUrl = sourceMap.get(fileName)?.sourceUrl?.trim() ?? '';
    if (sourceUrl.length > 0 && !seenUrls.has(sourceUrl)) {
      seenUrls.add(sourceUrl);
      excludedSourceUrls.push(sourceUrl);
    }
    removeProductAssetSource(directoryPath, fileName);
  }

  return { removed, excludedSourceUrls };
}

/** Remove logo files flagged as blockers by Haiku vision audit. */
export function pruneVisionBlockedLogos (
  directoryPath: string,
  findings: readonly { asset_id: string; severity: string }[],
  logoSourceUrls: readonly string[] = []
): { removed: string[]; excludedSourceUrls: string[] } {
  const removed: string[] = [];
  const excludedSourceUrls: string[] = [];
  const seenUrls = new Set<string>();
  const seenFiles = new Set<string>();

  for (const url of logoSourceUrls) {
    const trimmed = url.trim();
    if (trimmed.length > 0 && !seenUrls.has(trimmed)) {
      seenUrls.add(trimmed);
      excludedSourceUrls.push(trimmed);
    }
  }

  for (const f of findings) {
    if (f.severity !== 'blocker' || !f.asset_id.startsWith('logos/')) {
      continue;
    }
    const fileName = f.asset_id.slice('logos/'.length);
    if (fileName.length === 0 || fileName === 'logos' || seenFiles.has(fileName)) {
      continue;
    }
    seenFiles.add(fileName);

    const filePath = join(directoryPath, 'logos', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removeLogoAssetSource(directoryPath, fileName);
      removed.push(f.asset_id);
      console.log(`[assets-prune] Removed vision-blocked logo: ${f.asset_id}`);
    }
  }

  return { removed, excludedSourceUrls };
}

/** Remove product files flagged as blockers by vision or descriptions audit. */
export function pruneVisionBlockedProducts (
  directoryPath: string,
  findings: readonly { asset_id: string; severity: string }[]
): { removed: string[]; excludedSourceUrls: string[] } {
  const removed: string[] = [];
  const excludedSourceUrls: string[] = [];
  const seenUrls = new Set<string>();
  const sourceMap = loadProductAssetSources(directoryPath);
  const seenFiles = new Set<string>();

  for (const f of findings) {
    if (f.severity !== 'blocker' || !f.asset_id.startsWith('products/')) {
      continue;
    }
    const fileName = f.asset_id.slice('products/'.length);
    if (fileName.length === 0 || fileName === 'products' || seenFiles.has(fileName)) {
      continue;
    }
    seenFiles.add(fileName);

    const sourceUrl = sourceMap.get(fileName)?.sourceUrl?.trim() ?? '';
    if (sourceUrl.length > 0 && !seenUrls.has(sourceUrl)) {
      seenUrls.add(sourceUrl);
      excludedSourceUrls.push(sourceUrl);
    }

    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removed.push(f.asset_id);
      console.log(`[assets-prune] Removed vision-blocked product: ${f.asset_id}`);
    }
    removeProductAssetSource(directoryPath, fileName);
  }
  return { removed, excludedSourceUrls };
}

export function logDeterministicFindings (findings: DeterministicFinding[]): void {
  if (findings.length === 0) {
    console.log('[assets-deterministic] (no issues)');
    return;
  }
  console.log(`[assets-deterministic] findings (${String(findings.length)}):`);
  for (const f of findings) {
    console.log(`[assets-deterministic]   [${f.severity}] ${f.asset_id}: ${f.issue}`);
    console.log(`[assets-deterministic]     fix: ${f.fix_hint}`);
  }
}
