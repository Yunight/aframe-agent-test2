import { basename, extname, join } from 'node:path';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { imageSizeFromFile } from 'image-size/fromFile';
import type { LogoSourcePhase } from './logo-asset-sources.mts';
import {
  isUntrustedLogoUrl,
  validateLogoAssetFile,
  type LogoValidationContext
} from './logo-transparency-check.mts';
import { AssetHostFailureTracker } from './asset-host-fail-fast.mts';
import {
  isLowValueOfficialProductUrl,
  type OfficialProductCandidate
} from './official-site-logo-extract.mts';
import {
  officialImageFetchHeaders,
  shouldRetryImageMetadataWithGet
} from './official-fetch.mts';
import type { ProductAssetSourceProvenance } from './product-asset-sources.mts';
import {
  buildProductMatchFields,
  buildProductMatchTerms,
  filterPrioritizeProductUrls,
  isEntertainmentCampaign,
  isEntertainmentDeniedHost,
  isEntertainmentVisualHost,
  isExperienceCampaign,
  isOfficialHostCampaignOrProductImageUrl,
  normalizeForTermMatch,
  productMinRelevanceScore,
  resolveCampaignAssetProfile,
  resolveReferenceListingUrls,
  scoreProductContextRelevance
} from './style-guide-context.mts';
import type { ImageSearchRow } from './image-search-types.mts';
import { imageSearch, imageSearchLogPrefix, resolveImageSearchProvider } from './image-search.mts';

export interface BraveImageResult {
  type: 'image_result';
  title: string;
  url: string;
  source: string;
  page_fetched: string;
  thumbnail: { src: string; width?: number; height?: number };
  properties: {
    url: string;
    placeholder: string;
    width?: number;
    height?: number;
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

export const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml'
]);

export const mimeTypeToExtension: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg'
};

export interface ImageSearchContext {
  brandName: string;
  companyName: string;
  productName: string;
  brandContext?: string;
  brandURL?: string;
  companyURL?: string;
  logoImageSearchQueries?: string[];
  productImageSearchQueries?: string[];
  campaignContext?: string;
  /** HTTPS URLs extracted from the user prompt (collection pages, etc.). */
  campaignUrls?: readonly string[];
  /** User-provided campaign/collection page — scraped before brandURL. */
  campaignReferenceUrl?: string;
  productMatchTerms?: readonly string[];
}

export function imageContextFromStyleGuide (styleGuide: {
  brandName: string;
  companyName: string;
  productName: string;
  brandURL: string;
  companyURL: string;
  brandContext?: string | undefined;
  campaignContext?: string | undefined;
  campaignUrls?: readonly string[] | undefined;
  campaignReferenceUrl?: string | undefined;
  logoImageSearchQueries?: string[] | undefined;
  productImageSearchQueries?: string[] | undefined;
}): ImageSearchContext {
  const campaignContext = styleGuide.campaignContext?.trim() ?? '';
  const productMatchTerms = buildProductMatchTerms({
    campaignContext: campaignContext.length > 0 ? campaignContext : null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    ...(styleGuide.brandContext !== undefined ? { brandContext: styleGuide.brandContext } : {}),
    brandURL: styleGuide.brandURL
  });
  const campaignUrls = styleGuide.campaignUrls?.filter((u) => u.length > 0) ?? [];
  const brandContext = styleGuide.brandContext?.trim() ?? '';
  return {
    brandName: styleGuide.brandName,
    companyName: styleGuide.companyName,
    productName: styleGuide.productName,
    brandURL: styleGuide.brandURL,
    companyURL: styleGuide.companyURL,
    ...(brandContext.length > 0 ? { brandContext } : {}),
    logoImageSearchQueries: styleGuide.logoImageSearchQueries ?? [],
    productImageSearchQueries: styleGuide.productImageSearchQueries ?? [],
    ...(campaignContext.length > 0 ? { campaignContext } : {}),
    ...(campaignUrls.length > 0 ? { campaignUrls } : {}),
    ...(styleGuide.campaignReferenceUrl !== undefined && styleGuide.campaignReferenceUrl.length > 0
      ? { campaignReferenceUrl: styleGuide.campaignReferenceUrl }
      : {}),
    ...(productMatchTerms.length > 0 ? { productMatchTerms } : {})
  };
}

function parseEnvInt (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function braveProductCandidatePool (): number {
  return parseEnvInt('BRAVE_PRODUCT_CANDIDATE_POOL', 20);
}

export function braveProductTargetCount (): number {
  return parseEnvInt('BRAVE_PRODUCT_TARGET_COUNT', 6);
}

export function braveProductMinContentLength (): number {
  return parseEnvInt('BRAVE_PRODUCT_MIN_CONTENT_LENGTH', 30_000);
}

export function braveLogoCandidatePool (): number {
  return parseEnvInt('BRAVE_LOGO_CANDIDATE_POOL', 30);
}

export function braveProductMinReportedWidth (): number {
  return parseEnvInt('BRAVE_PRODUCT_MIN_REPORTED_W', 400);
}

export function braveProductMinReportedHeight (): number {
  return parseEnvInt('BRAVE_PRODUCT_MIN_REPORTED_H', 300);
}

function assetMinDimensions (fileType: 'logos' | 'products'): { minW: number; minH: number } {
  if (fileType === 'logos') {
    return {
      minW: parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_W', 1),
      minH: parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_H', 1)
    };
  }
  return {
    minW: parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_W', 1),
    minH: parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_H', 1)
  };
}

const LOW_RES_URL_PATTERNS: RegExp[] = [
  /thumb(?:v\d+)?/i,
  /thumbnail/i,
  /\bicon\b/i,
  /favicon/i,
  /sprite/i,
  /avatar/i,
  /\/small\//i,
  /\b50x\d+/i,
  /\b100x\d+/i,
  /wallpaper-\d+-thumb/i,
  /screenshot\/[^/]*thumb/i,
  /\.jpg_v_/i,
  /gaming-cdn\.com\/images\/products\/\d+\/screenshot\/.*thumb/i
];

export function isLikelyLowResolutionImageUrl (url: string): boolean {
  const lower = url.toLowerCase();
  return LOW_RES_URL_PATTERNS.some((pattern) => pattern.test(lower));
}

export function sanitizeAssetFilename (name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Basename from URL pathname (ignores query string — Demandware `*.jpg?sw=800`). */
export function fileNameFromImageUrl (fileUrl: string): string {
  try {
    const pathBase = basename(new URL(fileUrl).pathname);
    if (pathBase.length > 0 && pathBase !== '/') {
      return sanitizeAssetFilename(pathBase);
    }
  } catch {
    // fall through
  }
  const raw = basename(fileUrl.split('?')[0] ?? fileUrl);
  return sanitizeAssetFilename(raw);
}

export async function downloadFileToFileSystem (url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: officialImageFetchHeaders()
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

function parseImageMetadataFromResponse (
  url: string,
  response: Response,
  options?: { minContentLength?: number }
): { mimeType: string; extension: string; contentLength: number | null } {
  const contentTypeHeader = response.headers.get('content-type') ?? '';
  const mimeType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!allowedImageMimeTypes.has(mimeType)) {
    throw new Error(`URL ${url} has unsupported content-type "${contentTypeHeader}"`);
  }

  const extension = mimeTypeToExtension[mimeType];
  if (extension === undefined) {
    throw new Error(`Unsupported MIME type "${mimeType}" for URL ${url}`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength =
    contentLengthHeader !== null && contentLengthHeader.length > 0
      ? Number.parseInt(contentLengthHeader, 10)
      : null;
  const minLen = options?.minContentLength;
  if (
    minLen !== undefined &&
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength < minLen
  ) {
    throw new Error(
      `URL ${url} content-length ${String(contentLength)} below minimum ${String(minLen)}`
    );
  }

  return { mimeType, extension, contentLength };
}

export async function resolveRemoteImageMetadata (
  url: string,
  options?: { minContentLength?: number }
): Promise<{ mimeType: string; extension: string; contentLength: number | null }> {
  const headers = officialImageFetchHeaders();
  const headResponse = await fetch(url, {
    method: 'HEAD',
    headers
  });

  if (headResponse.ok) {
    return parseImageMetadataFromResponse(url, headResponse, options);
  }

  if (shouldRetryImageMetadataWithGet(headResponse.status)) {
    const getResponse = await fetch(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-8191' },
      redirect: 'follow'
    });
    if (getResponse.ok) {
      return parseImageMetadataFromResponse(url, getResponse, options);
    }
    throw new Error(
      `Unable to validate image URL ${url}. GET request failed with status ${String(getResponse.status)}`
    );
  }

  throw new Error(
    `Unable to validate image URL ${url}. HEAD request failed with status ${String(headResponse.status)}`
  );
}

export function filterOfficialProductPrioritizeUrls (urls: readonly string[]): string[] {
  const withoutLow = urls.filter((u) => !isLowValueOfficialProductUrl(u));
  return withoutLow.length > 0 ? withoutLow : [ ...urls ];
}

export function isListingBraveProductCandidateAllowed (
  url: string,
  officialHosts: readonly string[]
): boolean {
  return isOfficialHostCampaignOrProductImageUrl(url, officialHosts);
}

/** When true, Brave product search runs without listing-mode host restrictions. */
export function shouldRelaxProductListingBraveFilter (params: {
  fileType: 'logos' | 'products';
  listingMode: boolean;
  downloadedCount: number;
}): boolean {
  return (
    params.fileType === 'products' &&
    params.listingMode &&
    params.downloadedCount === 0
  );
}

export async function braveImageSearch ({
  query,
  num = 10
}: {
  query: string;
  num?: number;
}): Promise<BraveImageResult[]> {
  const apiKey = process.env['BRAVE_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Missing BRAVE_API_KEY for Brave image search.');
  }

  const params = new URLSearchParams();

  params.set('q', query);
  params.set('count', Math.min(Math.max(num, 1), 200).toString());
  params.set('search_lang', 'fr');
  params.set('country', 'fr');
  params.set('safesearch', 'strict');
  params.set('spellcheck', '0');

  const url = `https://api.search.brave.com/res/v1/images/search?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`Brave image search failed: ${response.status} and error: ${await response.text()}`);
  }

  return ((await response.json()) as BraveImageSearchResponse).results;
}

function normalizeHost (hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, '');
}

export function officialHostsFromContext (ctx: ImageSearchContext): string[] {
  const hosts: string[] = [];
  for (const raw of [ ctx.brandURL, ctx.companyURL ]) {
    const h = hostFromBrandUrl(raw);
    if (h !== null) {
      const n = normalizeHost(h);
      if (!hosts.includes(n)) {
        hosts.push(n);
      }
    }
  }
  return hosts;
}

function urlHostMatchesOfficial (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0) {
    return false;
  }
  try {
    const h = normalizeHost(new URL(url).hostname);
    return officialHosts.some((oh) => h === oh || h.endsWith(`.${oh}`));
  } catch {
    return false;
  }
}

function mergeSearchQueries (modelQueries: readonly string[] | undefined, builtIn: string[]): string[] {
  const fromModel = (modelQueries ?? []).map((q) => q.trim()).filter((q) => q.length >= 5);
  return [ ...new Set([ ...fromModel, ...builtIn ]) ];
}

/** Exported for unit tests (game expansion vs corporate publisher lockups). */
export function scoreCampaignLogoAdjustment (
  url: string,
  title: string,
  logoScoring: {
    productName: string;
    companyName: string;
    brandName: string;
  }
): number {
  const product = logoScoring.productName.trim();
  const brand = logoScoring.brandName.trim();
  const company = logoScoring.companyName.trim();
  if (product.length === 0 || brand.length === 0) {
    return 0;
  }
  if (product.toLowerCase() === brand.toLowerCase()) {
    return 0;
  }

  const hay = normalizeForTermMatch(`${url} ${title}`);
  let adjust = 0;

  const productTokens = product
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4);
  const hasProductHint = productTokens.some((t) => hay.includes(t));
  const companyNorm = normalizeForTermMatch(company);
  const looksCorporate =
    company.length > 0 &&
    (hay.includes(companyNorm.replace(/\s+/gu, '')) ||
      /blizzard[\s-]?entertainment/iu.test(hay));

  if (looksCorporate && !hasProductHint && !/lord[-_\s]?of[-_\s]?hatred/iu.test(hay)) {
    adjust -= 150;
  }
  if (/lord[-_\s]?of[-_\s]?hatred/iu.test(hay)) {
    adjust += 80;
  }
  if (hasProductHint) {
    adjust += 35;
  }
  return adjust;
}

/** Penalize parent-company logos and homonyms when brandName differs from companyName. */
export function scoreSubBrandLogoAdjustment (
  url: string,
  title: string,
  logoScoring: {
    companyName: string;
    brandName: string;
  }
): number {
  const brand = logoScoring.brandName.trim();
  const company = logoScoring.companyName.trim();
  if (brand.length === 0 || company.length === 0) {
    return 0;
  }

  const hay = normalizeForTermMatch(`${url} ${title}`);
  let adjust = 0;

  if (/\bnet[_\s-]?logo\b/iu.test(hay) && !/materiel|matnet/iu.test(hay)) {
    adjust -= 200;
  }

  if (brand.toLowerCase() === company.toLowerCase()) {
    const brandNorm = normalizeForTermMatch(brand).replace(/\s+/gu, '');
    if (brandNorm.length >= 4 && hay.includes(brandNorm)) {
      adjust += 50;
    }
    return adjust;
  }

  const brandNorm = normalizeForTermMatch(brand).replace(/\s+/gu, '');
  const companyNorm = normalizeForTermMatch(company).replace(/\s+/gu, '');
  const brandTokens = brand
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4);

  if (brandNorm.length >= 4 && hay.includes(brandNorm)) {
    adjust += 80;
  } else if (brandTokens.some((t) => hay.includes(t))) {
    adjust += 50;
  }

  if (companyNorm.length >= 4 && hay.includes(companyNorm) && !hay.includes(brandNorm)) {
    adjust -= 150;
  }

  return adjust;
}

/** Penalize franchise logos from the wrong installment (e.g. Scary Movie 4 vs 2026 / part 6). */
export function scoreEntertainmentLogoOpusPenalty (
  url: string,
  title: string,
  productName: string
): number {
  const hay = normalizeForTermMatch(`${url} ${title}`);
  const productHay = normalizeForTermMatch(productName);
  if (productHay.length === 0) {
    return 0;
  }

  let adjust = 0;

  const productYear = productHay.match(/\b(20\d{2})\b/)?.[1];
  const productSequel = productHay.match(/\b(?:movie|film|part|scary\s*movie)\s*(\d+)\b/)?.[1]
    ?? productHay.match(/\bscary\s*movie\s*(\d+)\b/)?.[1];

  const urlOpus = hay.match(/(?:scarymovie|scary-movie|movie[-_]?)(\d+)/)?.[1]
    ?? hay.match(/\bfilm[-_]?(\d+)\b/)?.[1];

  if (urlOpus !== undefined) {
    if (productSequel !== undefined && urlOpus !== productSequel) {
      adjust -= 150;
    } else if (productYear !== undefined && urlOpus !== productYear.slice(-1) && !productHay.includes(urlOpus)) {
      adjust -= 120;
    }
  }

  if (/scarymovie4|scary-movie-4|\bmovie[-_]?4\b/.test(hay) && /(?:\b6\b|2026)/.test(productHay)) {
    adjust -= 150;
  }

  return adjust;
}

function scoreImageSearchRow (
  url: string,
  row: ImageSearchRow,
  options: {
    assetKind: 'logo' | 'product';
    officialHosts: readonly string[];
    minProductW: number;
    minProductH: number;
    productMatchTerms?: readonly string[];
    logoScoring?: {
      productName: string;
      companyName: string;
      brandName: string;
    };
  }
): number {
  let score = 0;
  if (urlHostMatchesOfficial(url, options.officialHosts)) {
    score += 120;
  }
  const source = (row.source ?? '').toLowerCase();
  if (options.officialHosts.some((oh) => source.includes(oh))) {
    score += 45;
  }

  const title = (row.title ?? '').toLowerCase();
  const w = row.properties?.width ?? row.thumbnail?.width;
  const h = row.properties?.height ?? row.thumbnail?.height;

  if (options.assetKind === 'logo') {
    if (/wikimedia\.org|wikipedia\.org/iu.test(url)) {
      score += 90;
    }
    if (/wikimedia|wikipedia/iu.test(source)) {
      score += 40;
    }
    if (/logo|wordmark|marque|identit|brand|sigle/iu.test(title)) {
      score += 18;
    }
    if (/\.svg($|[?#])/iu.test(url)) {
      score += 28;
    }
    if (/\.png($|[?#])/iu.test(url) && /transparent/iu.test(title + url)) {
      score += 12;
    }
    if (/favicon|icon-16|sprite|emoji/iu.test(url)) {
      score -= 80;
    }
    if (isUntrustedLogoUrl(url)) {
      score -= 300;
    }
    if (w !== undefined && h !== undefined && w >= 120 && h >= 40) {
      score += 12;
    }
    if (options.logoScoring !== undefined) {
      score += scoreCampaignLogoAdjustment(url, title, options.logoScoring);
      score += scoreSubBrandLogoAdjustment(url, title, options.logoScoring);
    }
    if (/wikimedia\.org|wikipedia\.org/iu.test(url) && options.logoScoring !== undefined) {
      const brandNorm = normalizeForTermMatch(options.logoScoring.brandName).replace(/\s+/gu, '');
      if (brandNorm.length >= 4 && !normalizeForTermMatch(`${url} ${title}`).includes(brandNorm)) {
        score -= 120;
      }
    }
    if (options.logoScoring !== undefined) {
      score += scoreEntertainmentLogoOpusPenalty(url, title, options.logoScoring.productName);
    }
    const currentYear = String(logoSearchCurrentYear());
    if (url.includes(currentYear) || title.includes(currentYear)) {
      score += 30;
    }
  } else {
    if (isEntertainmentVisualHost(url)) {
      score += 55;
    }
    if (isEntertainmentDeniedHost(url)) {
      score -= 200;
    }
    if (/poster|affiche|key\s*art|still|cast|cinema|theatrical/iu.test(title)) {
      score += 22;
    }
    if (/packshot|produit|product|official|officiel|catalogue/iu.test(title)) {
      score += 14;
    }
    if (options.productMatchTerms !== undefined && options.productMatchTerms.length > 0) {
      score += scoreProductContextRelevance(url, title, options.productMatchTerms);
    }
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (
        /leparisien|lefigaro|pinterest|blogspot|wordpress|medium\.com|kindpng|pngaaa/iu.test(host)
      ) {
        score -= 180;
      }
    } catch {
      // ignore
    }
    if (/wallpaper|screenshot|thumb|avatar|icon/iu.test(url) || isLikelyLowResolutionImageUrl(url)) {
      score -= 90;
    }
    if (w !== undefined && h !== undefined) {
      if (w >= options.minProductW && h >= options.minProductH) {
        score += 30;
      } else if (w < 200 || h < 200) {
        score -= 70;
      }
    }
  }

  return score;
}

function pickDirectImageUrl (r: ImageSearchRow): string | null {
  const fromProps = r.properties?.url?.trim();
  if (fromProps !== undefined && fromProps.length > 0 && /^https?:\/\//iu.test(fromProps)) {
    return fromProps;
  }
  const direct = r.url?.trim();
  if (direct.length > 0 && /^https?:\/\//iu.test(direct)) {
    return direct;
  }
  return null;
}

export type GatherImageUrlsOptions = {
  maxResults: number;
  perQuery: number;
  excludeUrls?: Set<string>;
  skipLowResUrls?: boolean;
  minContentLength?: number;
  assetKind?: 'logo' | 'product';
  officialHosts?: readonly string[];
  productMatchTerms?: readonly string[];
  referenceListingUrls?: readonly string[];
  entertainmentMode?: boolean;
  experienceMode?: boolean;
  logoScoring?: {
    productName: string;
    companyName: string;
    brandName: string;
  };
};

export async function gatherValidatedImageUrls (
  queries: readonly string[],
  options: GatherImageUrlsOptions
): Promise<{ urls: string[]; titlesByUrl: Map<string, string> }> {
  const seen = new Set<string>();
  const titlesByUrl = new Map<string, string>();
  const skipLowRes = options.skipLowResUrls !== false;
  const assetKind = options.assetKind ?? 'product';
  const officialHosts = options.officialHosts ?? [];
  const ranked: { url: string; score: number; title: string }[] = [];
  const provider = resolveImageSearchProvider();
  const logPrefix = imageSearchLogPrefix(provider);
  const listingFilter =
    options.entertainmentMode !== true &&
    options.experienceMode !== true &&
    options.referenceListingUrls !== undefined &&
    options.referenceListingUrls.length > 0;

  for (const query of queries) {
    let results: ImageSearchRow[];
    try {
      results = await imageSearch({
        query,
        num: options.perQuery,
        assetKind,
        officialHosts,
        provider
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${logPrefix} query failed "${query}": ${msg}`);
      continue;
    }
    for (const row of results) {
      const candidate = pickDirectImageUrl(row);
      if (candidate === null || seen.has(candidate)) {
        continue;
      }
      if (options.excludeUrls?.has(candidate) === true) {
        continue;
      }
      if (skipLowRes && isLikelyLowResolutionImageUrl(candidate)) {
        continue;
      }
      if (assetKind === 'logo' && isUntrustedLogoUrl(candidate)) {
        continue;
      }

      const score = scoreImageSearchRow(candidate, row, {
        assetKind,
        officialHosts,
        minProductW: braveProductMinReportedWidth(),
        minProductH: braveProductMinReportedHeight(),
        ...(options.productMatchTerms !== undefined && options.productMatchTerms.length > 0
          ? { productMatchTerms: options.productMatchTerms }
          : {}),
        ...(assetKind === 'logo' && options.logoScoring !== undefined
          ? { logoScoring: options.logoScoring }
          : {})
      });
      if (score < -50) {
        continue;
      }
      if (
        assetKind === 'product' &&
        listingFilter &&
        !isListingBraveProductCandidateAllowed(candidate, officialHosts)
      ) {
        continue;
      }
      if (
        assetKind === 'product' &&
        options.productMatchTerms !== undefined &&
        options.productMatchTerms.length > 0 &&
        (options.entertainmentMode === true ||
          options.experienceMode === true ||
          options.referenceListingUrls === undefined ||
          options.referenceListingUrls.length === 0 ||
          !isOfficialHostCampaignOrProductImageUrl(candidate, officialHosts)) &&
        scoreProductContextRelevance(candidate, row.title ?? '', options.productMatchTerms) <
          productMinRelevanceScore()
      ) {
        continue;
      }

      if (assetKind === 'logo' && /\.svg($|[?#])/iu.test(candidate)) {
        seen.add(candidate);
        ranked.push({ url: candidate, score, title: row.title ?? '' });
        continue;
      }

      try {
        await resolveRemoteImageMetadata(candidate, {
          ...(options.minContentLength !== undefined
            ? { minContentLength: options.minContentLength }
            : {})
        });
        seen.add(candidate);
        ranked.push({ url: candidate, score, title: row.title ?? '' });
      } catch {
        /* URL not a usable image */
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  const urls = ranked.slice(0, options.maxResults).map((r) => r.url);
  for (const row of ranked.slice(0, options.maxResults)) {
    if (row.title.length > 0) {
      titlesByUrl.set(row.url, row.title);
    }
  }
  if (urls.length > 0 && ranked[0] !== undefined) {
    console.log(
      `${logPrefix} Top ${assetKind} candidate score=${String(ranked[0].score)} host=${(() => {
        try {
          return new URL(ranked[0].url).hostname;
        } catch {
          return '?';
        }
      })()}`
    );
  } else if (assetKind === 'product') {
    const filterHints: string[] = [];
    if (listingFilter) {
      filterHints.push('listing-mode official-host filter');
    }
    if (options.minContentLength !== undefined) {
      filterHints.push(`min content-length ${String(options.minContentLength)}`);
    }
    if (options.productMatchTerms !== undefined && options.productMatchTerms.length > 0) {
      filterHints.push('product context match terms');
    }
    if (skipLowRes) {
      filterHints.push('low-res URL skip');
    }
    console.warn(
      `${logPrefix} No product candidates after filtering (${filterHints.join('; ') || 'queries returned no usable images'}).`
    );
  }
  return { urls, titlesByUrl };
}

/** Calendar year used in logo search queries to bias toward the latest brand lockup. */
export function logoSearchCurrentYear (): number {
  return new Date().getFullYear();
}

function expansionLogoSearchQueries (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const product = base.productName.trim();
  if (product.length === 0 || brand.length === 0) {
    return [];
  }
  if (product.toLowerCase() === brand.toLowerCase()) {
    return [];
  }

  const year = logoSearchCurrentYear();
  const queries: string[] = [
    `${product} logo transparent`,
    `${product} wordmark svg`,
    `${product} official logo`,
    `${product} logo ${year}`
  ];
  const ref = base.campaignReferenceUrl?.trim() ?? base.brandURL?.trim() ?? '';
  if (ref.length > 0) {
    try {
      const parsed = new URL(ref);
      const host = parsed.hostname;
      const segments = parsed.pathname.split('/').filter((s) => s.length >= 3);
      const slug = segments.at(-1);
      if (slug !== undefined) {
        queries.push(`site:${host} ${slug.replace(/-/gu, ' ')} logo`);
      }
      queries.push(`site:${host} logo filetype:svg`);
    } catch {
      // skip invalid URL
    }
  }
  return queries;
}

function buildLogoSearchQueriesBuiltin (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const company = base.companyName.trim();
  const year = logoSearchCurrentYear();
  const queries: string[] = [ ...expansionLogoSearchQueries(base) ];
  const brandHost = hostFromBrandUrl(base.brandURL);
  const companyHost = hostFromBrandUrl(base.companyURL);

  if (brandHost !== null) {
    const h = brandHost;
    queries.push(
      `site:${h} logo`,
      `site:${h} logo filetype:svg`,
      `site:${h} logo filetype:png`,
      `site:${h} inurl:logo`,
      `site:${h} wordmark`,
      `${brand} logo officiel site:${h}`,
      `site:${h} logo ${year}`,
      `${brand} logo ${year} site:${h}`
    );
  }
  if (companyHost !== null && companyHost !== brandHost) {
    queries.push(`site:${companyHost} ${brand} logo`, `site:${companyHost} logo`);
  }

  if (company.length > 0 && company.toLowerCase() !== brand.toLowerCase()) {
    queries.push(`${company} logo officiel`);
  }

  queries.push(
    `${brand} identité visuelle logo`,
    `${brand} charte graphique logo`,
    `${brand} logo ${year}`,
    `${brand} nouveau logo ${year}`,
    `${brand} identité visuelle logo ${year}`
  );

  return queries;
}

export function buildLogoSearchQueries (base: ImageSearchContext): string[] {
  return mergeSearchQueries(base.logoImageSearchQueries, buildLogoSearchQueriesBuiltin(base));
}

function hostFromBrandUrl (brandURL: string | undefined): string | null {
  if (brandURL === undefined || brandURL.trim().length === 0) {
    return null;
  }
  try {
    return new URL(brandURL.trim()).hostname || null;
  } catch {
    return null;
  }
}

function buildProductSearchQueriesBuiltin (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const product = base.productName.trim();
  const campaign = base.campaignContext?.trim() ?? '';
  const queries: string[] = [];
  const host = hostFromBrandUrl(base.brandURL);
  const companyHost = hostFromBrandUrl(base.companyURL);
  const entertainment = isEntertainmentCampaign(buildProductMatchFields({
    campaignContext: campaign.length > 0 ? campaign : null,
    productName: product,
    brandName: brand,
    brandContext: base.brandContext,
    brandURL: base.brandURL
  }));
  const experience = isExperienceCampaign(buildProductMatchFields({
    campaignContext: campaign.length > 0 ? campaign : null,
    productName: product,
    brandName: brand,
    brandContext: base.brandContext,
    brandURL: base.brandURL
  }));

  if (entertainment) {
    const title = product.length > 0 ? product : brand;
    queries.push(
      `site:imdb.com ${title} poster`,
      `site:allocine.fr ${title} affiche`,
      `site:impawards.com ${title}`,
      `${title} official poster key art`,
      `${title} theatrical poster Paramount`
    );
    if (host !== null) {
      queries.push(`site:${host} poster`, `site:${host} key art`);
    }
  }

  if (experience && host !== null) {
    queries.push(
      `site:${host} attraction photo`,
      `site:${host} ${product} été`,
      `site:${host} famille parc`,
      `${brand} ${product} attraction officielle`,
      `${brand} roller coaster photo officielle`
    );
  }

  if (campaign.length > 0) {
    if (host !== null) {
      queries.push(
        `site:${host} ${campaign} packshot`,
        `site:${host} ${campaign} photo officielle`,
        `site:${host} ${brand} ${campaign}`
      );
    }
    queries.push(`${brand} ${campaign} packshot officiel`, `${campaign} visuel marketing`);
  }

  const terms = base.productMatchTerms ?? [];
  for (const term of terms.slice(0, 6)) {
    if (host !== null) {
      queries.push(`site:${host} ${term} packshot`, `site:${host} ${term} image`);
    }
    queries.push(`${brand} ${term} packshot officiel`);
  }

  if (host !== null) {
    if (product.length > 0) {
      queries.push(
        `site:${host} ${product} packshot`,
        `site:${host} ${product} photo produit`,
        `site:${host} ${product} image officielle`,
        `site:${host} ${brand} ${product}`
      );
    } else if (campaign.length === 0) {
      queries.push(`site:${host} ${brand} produit photo`, `site:${host} catalogue produit`);
    }
  }
  if (companyHost !== null && companyHost !== host && product.length > 0) {
    queries.push(`site:${companyHost} ${product} photo`);
  }

  if (product.length > 0) {
    queries.push(
      `${brand} ${product} packshot officiel`,
      `${product} photo produit haute résolution`,
      `${brand} ${product} visuel marketing officiel`
    );
  } else {
    queries.push(`${brand} produit photo officiel`, `${brand} gamme produit`);
  }

  return queries;
}

export function buildProductSearchQueries (base: ImageSearchContext): string[] {
  return mergeSearchQueries(base.productImageSearchQueries, buildProductSearchQueriesBuiltin(base));
}

export function buildLogoSearchQueriesFromFindings (
  base: ImageSearchContext,
  findings?: readonly { issue?: string; asset_id?: string }[],
  auditLogoQueries?: readonly string[]
): string[] {
  const queries = [ ...buildLogoSearchQueries(base) ];
  const brand = base.brandName.trim();

  if (auditLogoQueries !== undefined) {
    for (const q of auditLogoQueries) {
      if (q.trim().length > 0) {
        queries.push(q.trim());
      }
    }
  }

  const hasLogoIssue =
    findings?.some((f) => f.asset_id?.startsWith('logos/') === true) ?? false;

  if (hasLogoIssue) {
    const year = logoSearchCurrentYear();
    const brandHost = hostFromBrandUrl(base.brandURL);
    const companyHost = hostFromBrandUrl(base.companyURL);
    if (brandHost !== null) {
      queries.unshift(
        `site:${brandHost} logo filetype:svg`,
        `site:${brandHost} inurl:logo`,
        `site:${brandHost} logo officiel`,
        `site:${brandHost} logo ${year}`,
        `${brand} logo ${year}`
      );
    }
    if (companyHost !== null && companyHost !== brandHost) {
      queries.unshift(`site:${companyHost} ${brand} logo`);
    }
  }

  return [ ...new Set(queries) ];
}

export function buildProductSearchQueriesFromFindings (
  base: ImageSearchContext,
  findings?: readonly { issue?: string; asset_id?: string }[],
  auditProductQueries?: readonly string[]
): string[] {
  const queries = [ ...buildProductSearchQueries(base) ];
  const brand = base.brandName.trim();
  const product = base.productName.trim();

  if (auditProductQueries !== undefined) {
    for (const q of auditProductQueries) {
      if (q.trim().length > 0) {
        queries.push(q.trim());
      }
    }
  }

  const hasDimensionIssue =
    findings?.some(
      (f) =>
        (f.issue?.includes('below minimum') ?? false) ||
        (f.issue?.includes('Dimensions') ?? false) ||
        (f.asset_id?.includes('thumb') ?? false)
    ) ?? false;

  const hasHostIssue =
    findings?.some(
      (f) =>
        (f.issue?.includes('official brand visual host') ?? false) ||
        (f.issue?.includes('official film/studio host') ?? false) ||
        (f.issue?.includes('cinema database') ?? false)
    ) ?? false;

  const entertainment = isEntertainmentCampaign(buildProductMatchFields({
    campaignContext: base.campaignContext ?? null,
    productName: base.productName,
    brandName: base.brandName,
    brandContext: base.brandContext,
    brandURL: base.brandURL
  }));

  if (hasHostIssue && entertainment) {
    const title = base.productName.trim() || base.brandName.trim();
    queries.unshift(
      `site:allocine.fr ${title} affiche`,
      `site:imdb.com ${title} poster`,
      `site:impawards.com ${title}`
    );
  }

  if (hasDimensionIssue) {
    const host = hostFromBrandUrl(base.brandURL);
    if (host !== null && product.length > 0) {
      queries.unshift(
        `site:${host} ${product} packshot`,
        `site:${host} ${product} photo haute résolution`
      );
    }
    if (product.length > 0) {
      queries.push(`${product} packshot officiel haute résolution`, `${brand} ${product} visuel HD`);
    }
  }

  return [ ...new Set(queries) ];
}

export function loadBraveExcludedUrls (reviewDirectoryPath: string): Set<string> {
  const filePath = join(reviewDirectoryPath, 'brave-excluded-urls.json');
  if (!existsSync(filePath)) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { urls?: string[] };
    return new Set(parsed.urls ?? []);
  } catch {
    return new Set();
  }
}

export function appendBraveExcludedUrls (
  reviewDirectoryPath: string,
  excluded: Set<string>,
  newUrls: readonly string[]
): Set<string> {
  for (const url of newUrls) {
    excluded.add(url);
  }
  mkdirSync(reviewDirectoryPath, { recursive: true });
  writeFileSync(
    join(reviewDirectoryPath, 'brave-excluded-urls.json'),
    `${JSON.stringify({ urls: [ ...excluded ] }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  return excluded;
}

export function clearAssetSubdirectory (subdirectoryPath: string): void {
  if (!existsSync(subdirectoryPath)) {
    mkdirSync(subdirectoryPath, { recursive: true });
    return;
  }
  for (const fileName of readdirSync(subdirectoryPath)) {
    if (fileName.startsWith('.')) {
      continue;
    }
    unlinkSync(join(subdirectoryPath, fileName));
  }
}

function validateDownloadedLogoAsset (
  filePath: string,
  context?: LogoValidationContext
): boolean {
  const check = validateLogoAssetFile(filePath, context);
  if (!check.ok) {
    console.warn(`[download] Rejected logo ${basename(filePath)}: ${check.issue}`);
    return false;
  }
  if (check.warn !== undefined) {
    console.log(`[download] Logo ${basename(filePath)}: ${check.warn}`);
  }
  if (check.tier === 'B') {
    console.log(`[download] Logo ${basename(filePath)}: Tier B official opaque lockup accepted.`);
  }
  return true;
}

async function validateDownloadedDimensions (
  fileType: 'logos' | 'products',
  filePath: string
): Promise<{ ok: boolean; width?: number; height?: number }> {
  if (fileType === 'logos' && extname(filePath).toLowerCase() === '.svg') {
    return { ok: true };
  }
  const { minW, minH } = assetMinDimensions(fileType);
  try {
    const { width, height } = await imageSizeFromFile(filePath);
    if (width === undefined || height === undefined) {
      return { ok: false };
    }
    if (width < minW || height < minH) {
      console.warn(
        `[download] Rejected ${fileType} ${basename(filePath)}: ${String(width)}×${String(height)} below ${String(minW)}×${String(minH)}`
      );
      return { ok: false, width, height };
    }
    return { ok: true, width, height };
  } catch {
    return { ok: false };
  }
}

export async function downloadUrlsToAssetFolder (
  fileType: 'logos' | 'products',
  directoryPath: string,
  fileUrls: readonly string[],
  options?: {
    validateDimensions?: boolean;
    rejectedUrls?: string[];
    productProvenanceByUrl?: ReadonlyMap<string, ProductAssetSourceProvenance>;
    productTitleByUrl?: ReadonlyMap<string, string>;
    logoSourcePhase?: LogoSourcePhase;
    officialHosts?: readonly string[];
  }
): Promise<{ downloadedUrls: string[]; count: number }> {
  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath, { recursive: true });
  const validateDims = options?.validateDimensions === true;

  const downloadedUrls: string[] = [];

  const { recordProductAssetSource } = await import('./product-asset-sources.mts');
  const { recordLogoAssetSource } = await import('./logo-asset-sources.mts');

  for (const fileUrl of fileUrls) {
    const logoFileNameSanitized = fileNameFromImageUrl(fileUrl);
    const originalExtension = extname(logoFileNameSanitized).toLowerCase();

    try {
      const { mimeType, extension } = await resolveRemoteImageMetadata(fileUrl);
      const resolvedFileName =
        originalExtension === extension
          ? logoFileNameSanitized
          : `${logoFileNameSanitized.replace(/\.[^.]+$/, '')}${extension}`;
      const filePath = join(subdirectoryPath, resolvedFileName);

      if (originalExtension !== extension && originalExtension.length > 0) {
        console.warn(
          `[download] Extension mismatch for ${fileUrl}. Pathname ext "${originalExtension}", remote "${mimeType}". Saving as ${resolvedFileName}.`
        );
      }

      console.log(`Downloading ${filePath} ...`);
      await downloadFileToFileSystem(fileUrl, filePath);

      if (validateDims) {
        const dim = await validateDownloadedDimensions(fileType, filePath);
        if (!dim.ok) {
          unlinkSync(filePath);
          options?.rejectedUrls?.push(fileUrl);
          continue;
        }
      }

      if (fileType === 'logos') {
        const logoContext: LogoValidationContext = {
          sourceUrl: fileUrl,
          officialHosts: options?.officialHosts ?? [],
          sourcePhase: options?.logoSourcePhase ?? 'unknown'
        };
        if (!validateDownloadedLogoAsset(filePath, logoContext)) {
          unlinkSync(filePath);
          options?.rejectedUrls?.push(fileUrl);
          continue;
        }
      }

      downloadedUrls.push(fileUrl);
      if (fileType === 'products') {
        const provenance = options?.productProvenanceByUrl?.get(fileUrl);
        const sourceTitle = options?.productTitleByUrl?.get(fileUrl);
        recordProductAssetSource(
          directoryPath,
          resolvedFileName,
          fileUrl,
          {
            ...(provenance ?? {}),
            ...(sourceTitle !== undefined && sourceTitle.length > 0 ? { sourceTitle } : {})
          }
        );
      }
      if (fileType === 'logos') {
        recordLogoAssetSource(
          directoryPath,
          resolvedFileName,
          fileUrl,
          options?.logoSourcePhase ?? 'unknown'
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(`[download] ${fileType} failed ${fileUrl}: ${err.message}`);
      }
    }
  }

  return { downloadedUrls, count: downloadedUrls.length };
}

export type CollectAndDownloadOptions = {
  targetCount: number;
  candidatePool: number;
  excludeUrls?: Set<string>;
  clearFolder?: boolean;
  officialHosts?: readonly string[];
  /** Header lockup URLs scraped from brandURL (tried before Brave image search). */
  prioritizeUrls?: readonly string[];
  /** Official scrape candidates with page provenance (preferred over prioritizeUrls). */
  prioritizeCandidates?: readonly OfficialProductCandidate[];
  /** When true and prioritizeUrls filled the target, skip Brave image search entirely. */
  skipBraveWhenPrioritizedFilled?: boolean;
  productMatchTerms?: readonly string[];
  referenceListingUrls?: readonly string[];
  entertainmentMode?: boolean;
  experienceMode?: boolean;
  logoScoring?: {
    productName: string;
    companyName: string;
    brandName: string;
  };
};

export async function collectAndDownloadValidAssetUrls (
  fileType: 'logos' | 'products',
  directoryPath: string,
  queries: readonly string[],
  options: CollectAndDownloadOptions
): Promise<{ downloadedUrls: string[]; count: number; rejectedUrls: string[] }> {
  const subdirectoryPath = join(directoryPath, fileType);
  if (options.clearFolder === true) {
    clearAssetSubdirectory(subdirectoryPath);
    if (fileType === 'products') {
      const { clearProductAssetSources } = await import('./product-asset-sources.mts');
      clearProductAssetSources(directoryPath);
    }
  } else {
    mkdirSync(subdirectoryPath, { recursive: true });
  }

  const excludeUrls = new Set(options.excludeUrls ?? []);
  const rejectedUrls: string[] = [];
  const downloadedUrls: string[] = [];
  const officialHosts = options.officialHosts ?? [];
  const minContentLength =
    fileType === 'products' ? braveProductMinContentLength() : undefined;

  const listingMode =
    options.entertainmentMode !== true &&
    options.experienceMode !== true &&
    options.referenceListingUrls !== undefined &&
    options.referenceListingUrls.length > 0;
  const entertainmentMode = options.entertainmentMode === true;
  const experienceMode = options.experienceMode === true;

  const productProvenanceByUrl = new Map<string, ProductAssetSourceProvenance>();
  let prioritize: string[] = [];
  if (
    fileType === 'products' &&
    options.prioritizeCandidates !== undefined &&
    options.prioritizeCandidates.length > 0
  ) {
    for (const c of options.prioritizeCandidates) {
      prioritize.push(c.url);
      productProvenanceByUrl.set(c.url, {
        sourcePageUrl: c.sourcePageUrl,
        fromReferencePage: c.fromReferencePage
      });
    }
  } else {
    prioritize = [ ...(options.prioritizeUrls ?? []) ];
  }

  if (
    fileType === 'products' &&
    !listingMode &&
    options.productMatchTerms !== undefined &&
    options.productMatchTerms.length > 0 &&
    prioritize.length > 0
  ) {
    const beforeCount = prioritize.length;
    prioritize = filterPrioritizeProductUrls(
      prioritize,
      options.productMatchTerms,
      productMinRelevanceScore(),
      officialHosts
    );
    if (prioritize.length < beforeCount) {
      console.log(
        `[download] Filtered official product URLs by context: ${String(prioritize.length)}/${String(beforeCount)} kept`
      );
    }
  }

  if (fileType === 'products' && prioritize.length > 0) {
    prioritize = filterOfficialProductPrioritizeUrls(prioritize);
  }

  if (prioritize.length > 0 && (fileType === 'logos' || fileType === 'products')) {
    const assetLabel = fileType === 'logos' ? 'logo' : 'product';
    console.log(
      `[download] Trying ${String(prioritize.length)} official-site ${assetLabel} URL(s) before Brave…`
    );
    const hostTracker = new AssetHostFailureTracker(2);
    for (const fileUrl of prioritize) {
      if (downloadedUrls.length >= options.targetCount) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      if (hostTracker.isBlocked(fileUrl)) {
        continue;
      }
      const batch = await downloadUrlsToAssetFolder(fileType, directoryPath, [ fileUrl ], {
        validateDimensions: true,
        rejectedUrls,
        ...(fileType === 'products' && productProvenanceByUrl.size > 0
          ? { productProvenanceByUrl }
          : {}),
        ...(fileType === 'logos'
          ? { logoSourcePhase: 'official' as const, officialHosts }
          : {})
      });
      if (batch.count > 0) {
        downloadedUrls.push(...batch.downloadedUrls);
        console.log(`[download] Official ${assetLabel} saved: ${fileUrl}`);
      } else {
        excludeUrls.add(fileUrl);
        rejectedUrls.push(fileUrl);
        if (hostTracker.recordFailure(fileUrl)) {
          const host = hostTracker.blockedHostForLog();
          console.log(
            `[download] Skipping remaining official ${assetLabel} URLs on ${host ?? 'host'} (downloads blocked)`
          );
          break;
        }
      }
    }
  }

  if (
    options.skipBraveWhenPrioritizedFilled === true &&
    downloadedUrls.length >= options.targetCount
  ) {
    console.log(
      `[download] Official ${fileType} satisfied — skipping Brave image search for ${fileType}.`
    );
    return { downloadedUrls, count: downloadedUrls.length, rejectedUrls };
  }

  let effectiveListingMode = listingMode;
  if (
    shouldRelaxProductListingBraveFilter({
      fileType,
      listingMode: effectiveListingMode,
      downloadedCount: downloadedUrls.length
    })
  ) {
    console.log(
      prioritize.length > 0
        ? '[download] Official product candidates failed — relaxing listing-mode Brave filter.'
        : '[download] No official product assets — relaxing listing-mode Brave filter.'
    );
    effectiveListingMode = false;
  }

  let pass = 0;
  while (downloadedUrls.length < options.targetCount && pass < 4) {
    pass += 1;
    const need = options.targetCount - downloadedUrls.length;
    const poolSize = Math.max(options.candidatePool, need * 3);
    const gathered = await gatherValidatedImageUrls(queries, {
      maxResults: poolSize,
      perQuery: fileType === 'logos' ? 15 : 12,
      excludeUrls,
      skipLowResUrls: true,
      assetKind: fileType === 'logos' ? 'logo' : 'product',
      officialHosts,
      ...(minContentLength !== undefined ? { minContentLength } : {}),
      ...(fileType === 'products' &&
      options.productMatchTerms !== undefined &&
      options.productMatchTerms.length > 0
        ? { productMatchTerms: options.productMatchTerms }
        : {}),
      ...(fileType === 'products' && effectiveListingMode
        ? { referenceListingUrls: options.referenceListingUrls }
        : {}),
      ...(fileType === 'products' && entertainmentMode ? { entertainmentMode: true } : {}),
      ...(fileType === 'products' && experienceMode ? { experienceMode: true } : {}),
      ...(fileType === 'logos' && options.logoScoring !== undefined
        ? { logoScoring: options.logoScoring }
        : {})
    });
    const candidates = gathered.urls;
    const productTitleByUrl = gathered.titlesByUrl;

    if (fileType === 'products' && candidates.length === 0) {
      console.warn(
        `[download] Brave product search pass ${String(pass)}: 0 candidates after gather` +
          (effectiveListingMode ? ' (listing-mode filter was active)' : '')
      );
    }

    for (const fileUrl of candidates) {
      if (downloadedUrls.length >= options.targetCount) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      const before = downloadedUrls.length;
      const batch = await downloadUrlsToAssetFolder(fileType, directoryPath, [ fileUrl ], {
        validateDimensions: true,
        rejectedUrls,
        ...(fileType === 'products' && productProvenanceByUrl.size > 0
          ? { productProvenanceByUrl }
          : {}),
        ...(fileType === 'products' && productTitleByUrl.size > 0
          ? { productTitleByUrl }
          : {}),
        ...(fileType === 'logos'
          ? {
              logoSourcePhase: /wikimedia\.org|wikipedia\.org/iu.test(fileUrl)
                ? ('wikipedia' as const)
                : ('brave' as const),
              officialHosts
            }
          : {})
      });
      if (batch.count > 0) {
        downloadedUrls.push(...batch.downloadedUrls);
      } else {
        excludeUrls.add(fileUrl);
        rejectedUrls.push(fileUrl);
      }
      if (batch.count === 0 && before === downloadedUrls.length) {
        excludeUrls.add(fileUrl);
      }
    }

    if (downloadedUrls.length >= options.targetCount) {
      break;
    }
  }

  return { downloadedUrls, count: downloadedUrls.length, rejectedUrls };
}

export type RefreshAssetsResult = {
  logoFileUrls: string[];
  productPictureUrls: string[];
  downloaded: { logos: number; products: number };
};

/** Resolves logo Brave queries; `logos: []` means skip logo refresh (no fallback). */
export function resolveRefreshLogoQueries (
  queries: { logos?: string[] },
  context: ImageSearchContext
): string[] {
  const skipLogoRefresh = queries.logos !== undefined && queries.logos.length === 0;
  if (skipLogoRefresh) {
    return [];
  }
  return queries.logos !== undefined && queries.logos.length > 0
    ? queries.logos
    : buildLogoSearchQueries(context);
}

/** Resolves product Brave queries; `products: []` means skip product refresh (no fallback). */
export function resolveRefreshProductQueries (
  queries: { products?: string[] },
  context: ImageSearchContext
): string[] {
  const skipProductRefresh = queries.products !== undefined && queries.products.length === 0;
  if (skipProductRefresh) {
    return [];
  }
  return queries.products !== undefined && queries.products.length > 0
    ? queries.products
    : buildProductSearchQueries(context);
}

export async function refreshAssetsFromQueries (
  directoryPath: string,
  context: ImageSearchContext,
  queries: { logos?: string[]; products?: string[] },
  options?: {
    logoMaxResults?: number;
    productMaxResults?: number;
    excludeUrls?: Set<string>;
    /** When false, keep existing products/ files and only add new downloads (post-audit refresh). */
    clearProductFolder?: boolean;
  }
): Promise<RefreshAssetsResult & { rejectedUrls: string[] }> {
  const productMax = options?.productMaxResults ?? braveProductTargetCount();
  const excludeUrls = options?.excludeUrls ?? new Set<string>();
  const allRejected: string[] = [];

  const logoQueries = resolveRefreshLogoQueries(queries, context);
  const productQueries = resolveRefreshProductQueries(queries, context);

  let logoDownload = {
    downloadedUrls: [] as string[],
    count: 0,
    rejectedUrls: [] as string[]
  };
  if (logoQueries.length > 0) {
    console.log(`${imageSearchLogPrefix()} Refresh — single transparent logo (official → Wikipedia → image search)…`);
    const { collectSingleTransparentLogo } = await import('./logo-pipeline.mts');
    logoDownload = await collectSingleTransparentLogo(directoryPath, context, logoQueries, {
      excludeUrls
    });
    allRejected.push(...logoDownload.rejectedUrls);
    for (const url of logoDownload.rejectedUrls) {
      excludeUrls.add(url);
    }
  }

  let productDownload = { downloadedUrls: [] as string[], count: 0, rejectedUrls: [] as string[] };
  if (productQueries.length > 0) {
    console.log(`${imageSearchLogPrefix()} Refresh — collecting product candidates…`);
    const { extractOfficialProductImageUrls } = await import('./official-site-logo-extract.mts');
    const officialProductCandidates = await extractOfficialProductImageUrls(context, {
      minimumCandidates: Math.max(productMax * 2, braveProductCandidatePool())
    });
    const referenceListingUrls = resolveReferenceListingUrls({
      ...(context.campaignReferenceUrl !== undefined && context.campaignReferenceUrl.length > 0
        ? { campaignReferenceUrl: context.campaignReferenceUrl }
        : {}),
      ...(context.campaignUrls !== undefined && context.campaignUrls.length > 0
        ? { campaignUrls: context.campaignUrls }
        : {})
    });
    productDownload = await collectAndDownloadValidAssetUrls(
      'products',
      directoryPath,
      productQueries,
      {
        targetCount: productMax,
        candidatePool: braveProductCandidatePool(),
        excludeUrls,
        clearFolder: options?.clearProductFolder !== false,
        officialHosts: officialHostsFromContext(context),
        prioritizeCandidates: officialProductCandidates,
        skipBraveWhenPrioritizedFilled: true,
        ...(referenceListingUrls.length > 0 ? { referenceListingUrls } : {}),
        ...(() => {
          const profile = resolveCampaignAssetProfile(buildProductMatchFields({
            campaignContext: context.campaignContext ?? null,
            productName: context.productName,
            brandName: context.brandName,
            brandContext: context.brandContext,
            brandURL: context.brandURL
          }));
          if (profile === 'entertainment') {
            return { entertainmentMode: true as const };
          }
          if (profile === 'experience') {
            return { experienceMode: true as const };
          }
          return {};
        })(),
        ...(context.productMatchTerms !== undefined && context.productMatchTerms.length > 0
          ? { productMatchTerms: context.productMatchTerms }
          : {})
      }
    );
    allRejected.push(...productDownload.rejectedUrls);
  }

  return {
    logoFileUrls: logoDownload.downloadedUrls,
    productPictureUrls: productDownload.downloadedUrls,
    downloaded: {
      logos: logoDownload.count,
      products: productDownload.count
    },
    rejectedUrls: allRejected
  };
}

export function mergeRefreshIntoStyleGuideFile<T extends {
  logoFileUrls: string[];
  productPictureUrls: string[];
}>(
  directoryPath: string,
  styleGuide: T,
  refresh: RefreshAssetsResult
): T {
  const next = {
    ...styleGuide,
    logoFileUrls:
      refresh.logoFileUrls.length > 0 ? refresh.logoFileUrls : styleGuide.logoFileUrls,
    productPictureUrls:
      refresh.productPictureUrls.length > 0
        ? refresh.productPictureUrls
        : styleGuide.productPictureUrls
  };
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(next, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  return next;
}
