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
import { isUntrustedLogoUrl, validateLogoAssetFile } from './logo-transparency-check.mts';
import {
  buildProductMatchTerms,
  filterUrlsByProductRelevance,
  productMinRelevanceScore,
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
  brandURL?: string;
  companyURL?: string;
  logoImageSearchQueries?: string[];
  productImageSearchQueries?: string[];
  campaignContext?: string;
  productMatchTerms?: readonly string[];
}

export function imageContextFromStyleGuide (styleGuide: {
  brandName: string;
  companyName: string;
  productName: string;
  brandURL: string;
  companyURL: string;
  brandContext?: string;
  campaignContext?: string;
  logoImageSearchQueries?: string[];
  productImageSearchQueries?: string[];
}): ImageSearchContext {
  const campaignContext = styleGuide.campaignContext?.trim() ?? '';
  const productMatchTerms = buildProductMatchTerms({
    campaignContext: campaignContext.length > 0 ? campaignContext : null,
    productName: styleGuide.productName,
    brandName: styleGuide.brandName,
    brandContext: styleGuide.brandContext,
    brandURL: styleGuide.brandURL
  });
  return {
    brandName: styleGuide.brandName,
    companyName: styleGuide.companyName,
    productName: styleGuide.productName,
    brandURL: styleGuide.brandURL,
    companyURL: styleGuide.companyURL,
    logoImageSearchQueries: styleGuide.logoImageSearchQueries ?? [],
    productImageSearchQueries: styleGuide.productImageSearchQueries ?? [],
    ...(campaignContext.length > 0 ? { campaignContext } : {}),
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
      minW: parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_W', 120),
      minH: parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_H', 40)
    };
  }
  return {
    minW: parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_W', 200),
    minH: parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_H', 200)
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

export async function downloadFileToFileSystem (url: string, destinationPath: string): Promise<void> {
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

export async function resolveRemoteImageMetadata (
  url: string,
  options?: { minContentLength?: number }
): Promise<{ mimeType: string; extension: string; contentLength: number | null }> {
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

  const contentLengthHeader = headResponse.headers.get('content-length');
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

function scoreImageSearchRow (
  url: string,
  row: ImageSearchRow,
  options: {
    assetKind: 'logo' | 'product';
    officialHosts: readonly string[];
    minProductW: number;
    minProductH: number;
    productMatchTerms?: readonly string[];
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
  } else {
    if (/packshot|produit|product|official|officiel|catalogue/iu.test(title)) {
      score += 14;
    }
    if (options.productMatchTerms !== undefined && options.productMatchTerms.length > 0) {
      score += scoreProductContextRelevance(url, title, options.productMatchTerms);
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
};

export async function gatherValidatedImageUrls (
  queries: readonly string[],
  options: GatherImageUrlsOptions
): Promise<string[]> {
  const seen = new Set<string>();
  const skipLowRes = options.skipLowResUrls !== false;
  const assetKind = options.assetKind ?? 'product';
  const officialHosts = options.officialHosts ?? [];
  const ranked: { url: string; score: number }[] = [];
  const provider = resolveImageSearchProvider();
  const logPrefix = imageSearchLogPrefix(provider);

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
          : {})
      });
      if (score < -50) {
        continue;
      }
      if (
        assetKind === 'product' &&
        options.productMatchTerms !== undefined &&
        options.productMatchTerms.length > 0 &&
        scoreProductContextRelevance(candidate, row.title ?? '', options.productMatchTerms) <
          productMinRelevanceScore()
      ) {
        continue;
      }

      if (assetKind === 'logo' && /\.svg($|[?#])/iu.test(candidate)) {
        seen.add(candidate);
        ranked.push({ url: candidate, score });
        continue;
      }

      try {
        await resolveRemoteImageMetadata(candidate, {
          ...(options.minContentLength !== undefined
            ? { minContentLength: options.minContentLength }
            : {})
        });
        seen.add(candidate);
        ranked.push({ url: candidate, score });
      } catch {
        /* URL not a usable image */
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  const urls = ranked.slice(0, options.maxResults).map((r) => r.url);
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
  }
  return urls;
}

function buildLogoSearchQueriesBuiltin (base: ImageSearchContext): string[] {
  const brand = base.brandName.trim();
  const company = base.companyName.trim();
  const queries: string[] = [];
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
      `${brand} logo officiel site:${h}`
    );
  }
  if (companyHost !== null && companyHost !== brandHost) {
    queries.push(`site:${companyHost} ${brand} logo`, `site:${companyHost} logo`);
  }

  if (company.length > 0 && company.toLowerCase() !== brand.toLowerCase()) {
    queries.push(`${company} logo officiel`);
  }

  queries.push(`${brand} identité visuelle logo`, `${brand} charte graphique logo`);

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
    const brandHost = hostFromBrandUrl(base.brandURL);
    const companyHost = hostFromBrandUrl(base.companyURL);
    if (brandHost !== null) {
      queries.unshift(
        `site:${brandHost} logo filetype:svg`,
        `site:${brandHost} inurl:logo`,
        `site:${brandHost} logo officiel`
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

function validateDownloadedLogoAsset (filePath: string): boolean {
  const check = validateLogoAssetFile(filePath);
  if (!check.ok) {
    console.warn(`[download] Rejected logo ${basename(filePath)}: ${check.issue}`);
    return false;
  }
  if (check.warn !== undefined) {
    console.log(`[download] Logo ${basename(filePath)}: ${check.warn}`);
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
  options?: { validateDimensions?: boolean; rejectedUrls?: string[] }
): Promise<{ downloadedUrls: string[]; count: number }> {
  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath, { recursive: true });
  const validateDims = options?.validateDimensions === true;

  const downloadedUrls: string[] = [];

  for (const fileUrl of fileUrls) {
    const logoFileName = basename(fileUrl);
    const logoFileNameSanitized = sanitizeAssetFilename(logoFileName);
    const originalExtension = extname(logoFileNameSanitized).toLowerCase();

    try {
      const { mimeType, extension } = await resolveRemoteImageMetadata(fileUrl);
      const resolvedFileName =
        originalExtension === extension
          ? logoFileNameSanitized
          : `${logoFileNameSanitized.replace(/\.[^.]+$/, '')}${extension}`;
      const filePath = join(subdirectoryPath, resolvedFileName);

      if (originalExtension !== extension) {
        console.warn(
          `[download] Extension mismatch for ${fileUrl}. Original "${originalExtension || 'none'}", remote "${mimeType}". Saving as ${resolvedFileName}.`
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

      if (fileType === 'logos' && !validateDownloadedLogoAsset(filePath)) {
        unlinkSync(filePath);
        options?.rejectedUrls?.push(fileUrl);
        continue;
      }

      downloadedUrls.push(fileUrl);
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
  /** When true and prioritizeUrls filled the target, skip Brave image search entirely. */
  skipBraveWhenPrioritizedFilled?: boolean;
  productMatchTerms?: readonly string[];
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
  } else {
    mkdirSync(subdirectoryPath, { recursive: true });
  }

  const excludeUrls = new Set(options.excludeUrls ?? []);
  const rejectedUrls: string[] = [];
  const downloadedUrls: string[] = [];
  const officialHosts = options.officialHosts ?? [];
  const minContentLength =
    fileType === 'products' ? braveProductMinContentLength() : undefined;

  let prioritize = options.prioritizeUrls ?? [];
  if (
    fileType === 'products' &&
    options.productMatchTerms !== undefined &&
    options.productMatchTerms.length > 0 &&
    prioritize.length > 0
  ) {
    const filtered = filterUrlsByProductRelevance(
      prioritize,
      options.productMatchTerms,
      productMinRelevanceScore()
    );
    if (filtered.length < prioritize.length) {
      console.log(
        `[download] Filtered official product URLs by context: ${String(filtered.length)}/${String(prioritize.length)} kept`
      );
    }
    prioritize = filtered;
  }

  if (fileType === 'logos' && prioritize.length > 0) {
    console.log(`[download] Trying ${String(prioritize.length)} official-site logo URL(s) before Brave…`);
    for (const fileUrl of prioritize) {
      if (downloadedUrls.length >= options.targetCount) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      const batch = await downloadUrlsToAssetFolder(fileType, directoryPath, [ fileUrl ], {
        validateDimensions: true,
        rejectedUrls
      });
      if (batch.count > 0) {
        downloadedUrls.push(...batch.downloadedUrls);
        console.log(`[download] Official header logo saved: ${fileUrl}`);
      } else {
        excludeUrls.add(fileUrl);
        rejectedUrls.push(fileUrl);
      }
    }
  }

  if (
    fileType === 'logos' &&
    options.skipBraveWhenPrioritizedFilled === true &&
    downloadedUrls.length >= options.targetCount
  ) {
    console.log('[download] Official logo satisfied — skipping Brave image search for logos.');
    return { downloadedUrls, count: downloadedUrls.length, rejectedUrls };
  }

  let pass = 0;
  while (downloadedUrls.length < options.targetCount && pass < 4) {
    pass += 1;
    const need = options.targetCount - downloadedUrls.length;
    const poolSize = Math.max(options.candidatePool, need * 3);
    const candidates = await gatherValidatedImageUrls(queries, {
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
        : {})
    });

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
        rejectedUrls
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

export async function refreshAssetsFromQueries (
  directoryPath: string,
  context: ImageSearchContext,
  queries: { logos?: string[]; products?: string[] },
  options?: {
    logoMaxResults?: number;
    productMaxResults?: number;
    excludeUrls?: Set<string>;
  }
): Promise<RefreshAssetsResult & { rejectedUrls: string[] }> {
  const productMax = options?.productMaxResults ?? braveProductTargetCount();
  const excludeUrls = options?.excludeUrls ?? new Set<string>();
  const allRejected: string[] = [];

  const logoQueries =
    queries.logos !== undefined && queries.logos.length > 0
      ? queries.logos
      : buildLogoSearchQueries(context);
  const productQueries =
    queries.products !== undefined && queries.products.length > 0
      ? queries.products
      : buildProductSearchQueries(context);

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
    productDownload = await collectAndDownloadValidAssetUrls(
      'products',
      directoryPath,
      productQueries,
      {
        targetCount: productMax,
        candidatePool: braveProductCandidatePool(),
        excludeUrls,
        clearFolder: true,
        officialHosts: officialHostsFromContext(context),
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
