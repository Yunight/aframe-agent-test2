import type { ImageSearchContext } from './brave-image-assets.mts';
import { isUntrustedLogoUrl } from './logo-transparency-check.mts';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 2_500_000;

/** HTTP statuses that usually mean the site blocks automated fetch (not a transient 5xx). */
const CRAWL_BLOCKED_HTTP_STATUSES = new Set([ 401, 403, 406, 451 ]);

const FALLBACK_IMAGE_HOSTS = [ 'upload.wikimedia.org', 'wikimedia.org' ] as const;

type ScoredLogoUrl = { url: string; score: number; reason: string };

type PageFetchResult = {
  html: string | null;
  status: number | null;
  blocked: boolean;
};

const LOGO_CLASS_HINTS = [
  'primary-logo',
  'logo-container',
  'logo-simple',
  'site-logo',
  'header-logo',
  'brand-logo',
  'main-logo',
  'nav-logo',
  'logo__image',
  'logo-image'
] as const;

function parseEnvEnabled (): boolean {
  return process.env['CREATIVE_OFFICIAL_LOGO_FETCH']?.trim() !== '0';
}

function parseFallbackEnabled (): boolean {
  return process.env['CREATIVE_OFFICIAL_FETCH_FALLBACK']?.trim() !== '0';
}

export function isCrawlBlockedHttpStatus (status: number): boolean {
  return CRAWL_BLOCKED_HTTP_STATUSES.has(status);
}

/** Wikipedia article slug from brand or company name (spaces → underscores). */
export function wikipediaSlugFromBrandName (name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return '';
  }
  return trimmed.replace(/\s+/gu, '_');
}

export function buildFallbackPageUrls (context: ImageSearchContext): string[] {
  const label =
    context.brandName.trim() || context.companyName.trim();
  const slug = wikipediaSlugFromBrandName(label);
  if (slug.length === 0) {
    return [];
  }
  const urls = [
    `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`,
    `https://fr.wikipedia.org/wiki/${encodeURIComponent(slug)}`
  ];
  return [ ...new Set(urls) ];
}

function urlHostAllowedForFallbackImage (url: string): boolean {
  try {
    const h = normalizeHost(new URL(url).hostname);
    return FALLBACK_IMAGE_HOSTS.some(
      (fh) => h === fh || h.endsWith(`.${fh}`) || fh.endsWith(`.${h}`)
    );
  } catch {
    return false;
  }
}

function normalizeHost (hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, '');
}

function hostsFromContext (ctx: ImageSearchContext): string[] {
  const hosts: string[] = [];
  for (const raw of [ ctx.brandURL, ctx.companyURL ]) {
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    try {
      const h = normalizeHost(new URL(raw.trim()).hostname);
      if (!hosts.includes(h)) {
        hosts.push(h);
      }
    } catch {
      // skip
    }
  }
  return hosts;
}

function resolveAbsoluteUrl (basePageUrl: string, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith('data:')) {
    return null;
  }
  try {
    if (trimmed.startsWith('//')) {
      return new URL(`https:${trimmed}`).href;
    }
    return new URL(trimmed, basePageUrl).href;
  } catch {
    return null;
  }
}

function urlHostAllowed (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0) {
    return true;
  }
  try {
    const h = normalizeHost(new URL(url).hostname);
    return officialHosts.some((oh) => h === oh || h.endsWith(`.${oh}`) || oh.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function scoreLogoUrl (url: string, hints: { classHint?: string; inHeader?: boolean }): number {
  const lower = url.toLowerCase();
  let score = 0;

  if (hints.classHint !== undefined) {
    const idx = LOGO_CLASS_HINTS.indexOf(hints.classHint as (typeof LOGO_CLASS_HINTS)[number]);
    score += idx >= 0 ? 90 - idx * 3 : 40;
  }

  if (hints.inHeader === true) {
    score += 25;
  }

  if (/\.svg($|[?#])/iu.test(lower)) {
    score += 35;
  } else if (/\.png($|[?#])/iu.test(lower)) {
    score += 20;
  }

  if (/\/logo|logo-|wordmark|brand-logo|site-logo/iu.test(lower)) {
    score += 18;
  }

  if (/favicon|apple-touch|sprite|icon-16|icon-32|emoji|avatar|1x1/iu.test(lower)) {
    score -= 120;
  }

  if (isUntrustedLogoUrl(url)) {
    score -= 500;
  }

  return score;
}

function extractSrcFromImgTag (tag: string): string | null {
  const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/iu);
  if (srcMatch !== null && srcMatch[1] !== undefined) {
    return srcMatch[1];
  }
  const srcsetMatch = tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/iu);
  if (srcsetMatch !== null && srcsetMatch[1] !== undefined) {
    const first = srcsetMatch[1].split(',')[0]?.trim().split(/\s+/u)[0];
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  for (const attr of [ 'data-src', 'data-lazy-src', 'data-original' ] as const) {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'iu'));
    if (m !== null && m[1] !== undefined) {
      return m[1];
    }
  }
  return null;
}

function classListFromTag (tag: string): string {
  const m = tag.match(/\bclass\s*=\s*["']([^"']+)["']/iu);
  return m?.[1]?.toLowerCase() ?? '';
}

function pushCandidate (
  bucket: Map<string, ScoredLogoUrl>,
  pageUrl: string,
  rawSrc: string,
  officialHosts: readonly string[],
  hints: { classHint?: string; inHeader?: boolean }
): void {
  const absolute = resolveAbsoluteUrl(pageUrl, rawSrc);
  if (absolute === null || !/^https?:\/\//iu.test(absolute)) {
    return;
  }
  if (!urlHostAllowed(absolute, officialHosts)) {
    return;
  }
  const score = scoreLogoUrl(absolute, hints);
  if (score < 10) {
    return;
  }
  const existing = bucket.get(absolute);
  if (existing === undefined || score > existing.score) {
    bucket.set(absolute, {
      url: absolute,
      score,
      reason: hints.classHint ?? (hints.inHeader === true ? 'header' : 'img.logo')
    });
  }
}

/** Parse homepage HTML for header lockup patterns (primary-logo, logo-container, img.logo-simple, etc.). */
export function extractLogoCandidatesFromHtml (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[]
): ScoredLogoUrl[] {
  const bucket = new Map<string, ScoredLogoUrl>();

  for (const hint of LOGO_CLASS_HINTS) {
    const containerRe = new RegExp(
      `<(?:div|a|span|figure)[^>]*class="[^"]*\\b${hint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b[^"]*"[^>]*>[\\s\\S]{0,4000}?<img[^>]+>`,
      'giu'
    );
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = containerRe.exec(html)) !== null) {
      const block = blockMatch[0];
      const imgMatch = block.match(/<img[^>]+>/iu);
      if (imgMatch !== null) {
        const src = extractSrcFromImgTag(imgMatch[0]);
        if (src !== null) {
          pushCandidate(bucket, pageUrl, src, officialHosts, { classHint: hint });
        }
      }
    }
  }

  const imgTagRe = /<img\b[^>]*>/giu;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgTagRe.exec(html)) !== null) {
    const tag = imgMatch[0];
    const classes = classListFromTag(tag);
    if (!/\blogo\b/iu.test(classes) && !/\bwordmark\b/iu.test(classes)) {
      continue;
    }
    const src = extractSrcFromImgTag(tag);
    if (src === null) {
      continue;
    }
    let classHint: string | undefined;
    for (const hint of LOGO_CLASS_HINTS) {
      if (classes.includes(hint)) {
        classHint = hint;
        break;
      }
    }
    const pos = imgMatch.index ?? 0;
    const headerSlice = html.slice(Math.max(0, pos - 8000), pos + 200);
    const inHeader = /<header\b/iu.test(headerSlice) || /\bprimary-logo\b/iu.test(headerSlice);
    pushCandidate(
      bucket,
      pageUrl,
      src,
      officialHosts,
      {
        ...(classHint !== undefined ? { classHint } : {}),
        ...(inHeader ? { inHeader: true } : {})
      }
    );
  }

  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

async function fetchPageHtmlDetailed (url: string, logTag: string): Promise<PageFetchResult> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (compatible; AframeCreativeAssetBot/1.0; +https://github.com/)'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) {
      const blocked = isCrawlBlockedHttpStatus(res.status);
      const suffix = blocked ? ' — crawler blocked, fallback sources may be used' : '';
      console.warn(`[${logTag}] HTTP ${String(res.status)} for ${url}${suffix}`);
      return { html: null, status: res.status, blocked };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const html =
      buf.length > MAX_HTML_BYTES
        ? buf.subarray(0, MAX_HTML_BYTES).toString('utf8')
        : buf.toString('utf8');
    return { html, status: res.status, blocked: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${logTag}] Fetch failed ${url}: ${msg}`);
    return { html: null, status: null, blocked: false };
  }
}

function officialPageUrlsFromContext (context: ImageSearchContext): string[] {
  const pageUrls: string[] = [];
  for (const raw of [ context.brandURL, context.companyURL ]) {
    if (raw === undefined || raw.trim().length === 0) {
      continue;
    }
    try {
      const u = new URL(raw.trim());
      pageUrls.push(u.origin + '/');
      pageUrls.push(u.href);
    } catch {
      // skip
    }
  }
  return [ ...new Set(pageUrls) ];
}

function mergeCandidates (allCandidates: ScoredLogoUrl[]): string[] {
  const byUrl = new Map<string, ScoredLogoUrl>();
  for (const c of allCandidates) {
    const prev = byUrl.get(c.url);
    if (prev === undefined || c.score > prev.score) {
      byUrl.set(c.url, c);
    }
  }
  return [ ...byUrl.values() ]
    .sort((a, b) => b.score - a.score)
    .map((c) => c.url);
}

async function scrapePagesForCandidates (params: {
  pageUrls: readonly string[];
  logTag: string;
  allowedHosts: readonly string[];
  extract: (html: string, pageUrl: string, hosts: readonly string[]) => ScoredLogoUrl[];
}): Promise<{ candidates: ScoredLogoUrl[]; allOfficialBlocked: boolean }> {
  const seenPages = new Set<string>();
  const allCandidates: ScoredLogoUrl[] = [];
  let hadFetch = false;
  let allBlocked = true;
  let gotHtml = false;

  for (const pageUrl of params.pageUrls) {
    if (seenPages.has(pageUrl)) {
      continue;
    }
    seenPages.add(pageUrl);
    hadFetch = true;
    console.log(`[${params.logTag}] Fetching: ${pageUrl}`);
    const { html, blocked } = await fetchPageHtmlDetailed(pageUrl, params.logTag);
    if (!blocked) {
      allBlocked = false;
    }
    if (html === null || html.length < 200) {
      continue;
    }
    gotHtml = true;
    const found = params.extract(html, pageUrl, params.allowedHosts);
    for (const c of found) {
      console.log(`[${params.logTag}]   score=${String(c.score)} ${c.reason} → ${c.url}`);
      allCandidates.push(c);
    }
  }

  const allOfficialBlocked = hadFetch && allBlocked && !gotHtml;
  return { candidates: allCandidates, allOfficialBlocked };
}

/** Wikipedia / Wikimedia: infobox image, og:image, logo filenames on upload.wikimedia.org. */
export function extractFallbackLogoCandidatesFromHtml (
  html: string,
  pageUrl: string
): ScoredLogoUrl[] {
  const bucket = new Map<string, ScoredLogoUrl>();

  const push = (rawSrc: string, score: number, reason: string): void => {
    const absolute = resolveAbsoluteUrl(pageUrl, rawSrc);
    if (absolute === null || !urlHostAllowedForFallbackImage(absolute)) {
      return;
    }
    const lower = absolute.toLowerCase();
    let s = score;
    if (/\.svg($|[?#])/iu.test(lower)) {
      s += 30;
    } else if (/\.png($|[?#])/iu.test(lower)) {
      s += 15;
    }
    if (/\/logo|wordmark|brand[_-]?logo/iu.test(lower)) {
      s += 25;
    }
    if (isUntrustedLogoUrl(absolute)) {
      s -= 400;
    }
    if (s < 10) {
      return;
    }
    const prev = bucket.get(absolute);
    if (prev === undefined || s > prev.score) {
      bucket.set(absolute, { url: absolute, score: s, reason });
    }
  };

  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src !== undefined) {
      push(src, 40, 'wikipedia-og:image');
    }
  }

  const infoboxImgRe =
    /<table[^>]*class="[^"]*\binfobox\b[^"]*"[^>]*>[\s\S]*?<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let infoboxMatch: RegExpExecArray | null;
  while ((infoboxMatch = infoboxImgRe.exec(html)) !== null) {
    const src = infoboxMatch[1];
    if (src !== undefined) {
      push(src, 55, 'wikipedia-infobox');
    }
  }

  const imgTagRe = /<img\b[^>]*>/giu;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgTagRe.exec(html)) !== null) {
    const tag = imgMatch[0];
    const src = extractSrcFromImgTag(tag);
    if (src === null) {
      continue;
    }
    if (!/upload\.wikimedia\.org|wikimedia\.org/iu.test(src)) {
      continue;
    }
    push(src, 35, 'wikipedia-img');
  }

  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

function extractProductCandidatesFromHtmlAllowingFallback (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[]
): ScoredLogoUrl[] {
  const fromOfficial = extractProductCandidatesFromHtml(html, pageUrl, officialHosts);
  if (fromOfficial.length > 0) {
    return fromOfficial;
  }
  const bucket = new Map<string, ScoredLogoUrl>();
  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src === undefined) {
      continue;
    }
    const absolute = resolveAbsoluteUrl(pageUrl, src);
    if (absolute === null || !urlHostAllowedForFallbackImage(absolute)) {
      continue;
    }
    const score = scoreProductImageUrl(absolute) + 10;
    if (score >= 10) {
      bucket.set(absolute, { url: absolute, score, reason: 'fallback-og:image' });
    }
  }
  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

/**
 * Fetch brandURL / companyURL homepages and extract header logo image URLs.
 * Prefer SVG/PNG lockups from .primary-logo, .logo-container, img.logo-simple, etc.
 * On HTTP 403 (etc.) from the official site, tries Wikipedia (en/fr) and Wikimedia assets.
 */
export async function extractOfficialHeaderLogoUrls (
  context: ImageSearchContext
): Promise<string[]> {
  if (!parseEnvEnabled()) {
    return [];
  }

  const officialHosts = hostsFromContext(context);
  const { candidates, allOfficialBlocked } = await scrapePagesForCandidates({
    pageUrls: officialPageUrlsFromContext(context),
    logTag: 'official-logo',
    allowedHosts: officialHosts,
    extract: extractLogoCandidatesFromHtml
  });

  let allCandidates = candidates;
  const needFallback =
    parseFallbackEnabled() &&
    (allOfficialBlocked || allCandidates.length === 0);

  if (needFallback) {
    console.log(
      '[official-logo] Official site blocked or empty — trying Wikipedia / Wikimedia fallback…'
    );
    const fallback = await scrapePagesForCandidates({
      pageUrls: buildFallbackPageUrls(context),
      logTag: 'official-logo-fallback',
      allowedHosts: officialHosts,
      extract: (html, pageUrl) => extractFallbackLogoCandidatesFromHtml(html, pageUrl)
    });
    allCandidates = [ ...allCandidates, ...fallback.candidates ];
  }

  return mergeCandidates(allCandidates);
}

function scoreProductImageUrl (url: string): number {
  const lower = url.toLowerCase();
  let score = 20;
  if (/\.(jpe?g|png|webp)(\?|$)/iu.test(lower)) {
    score += 30;
  }
  if (/product|packshot|hero|catalogue|media|cdn/iu.test(lower)) {
    score += 15;
  }
  if (isUntrustedLogoUrl(url)) {
    score -= 400;
  }
  return score;
}

function extractProductCandidatesFromHtml (
  html: string,
  pageUrl: string,
  officialHosts: readonly string[]
): ScoredLogoUrl[] {
  const bucket = new Map<string, ScoredLogoUrl>();

  const ogRe =
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const src = ogMatch[1];
    if (src === undefined) {
      continue;
    }
    const absolute = resolveAbsoluteUrl(pageUrl, src);
    if (absolute === null || !urlHostAllowed(absolute, officialHosts)) {
      continue;
    }
    const score = scoreProductImageUrl(absolute);
    if (score >= 10) {
      bucket.set(absolute, { url: absolute, score, reason: 'og:image' });
    }
  }

  const jsonLdRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = jsonLdRe.exec(html)) !== null) {
    const raw = ldMatch[1]?.trim();
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    try {
      const data: unknown = JSON.parse(raw);
      const nodes = Array.isArray(data) ? data : [ data ];
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) {
          continue;
        }
        const rec = node as Record<string, unknown>;
        const type = String(rec['@type'] ?? '');
        if (!/product/iu.test(type)) {
          continue;
        }
        const image = rec['image'];
        const urls: string[] = [];
        if (typeof image === 'string') {
          urls.push(image);
        } else if (Array.isArray(image)) {
          for (const item of image) {
            if (typeof item === 'string') {
              urls.push(item);
            } else if (typeof item === 'object' && item !== null && typeof (item as { url?: unknown }).url === 'string') {
              urls.push((item as { url: string }).url);
            }
          }
        } else if (typeof image === 'object' && image !== null && typeof (image as { url?: unknown }).url === 'string') {
          urls.push((image as { url: string }).url);
        }
        for (const src of urls) {
          const absolute = resolveAbsoluteUrl(pageUrl, src);
          if (absolute === null || !urlHostAllowed(absolute, officialHosts)) {
            continue;
          }
          const score = scoreProductImageUrl(absolute) + 25;
          bucket.set(absolute, { url: absolute, score, reason: 'json-ld-product' });
        }
      }
    } catch {
      // skip invalid JSON-LD
    }
  }

  return [ ...bucket.values() ].sort((a, b) => b.score - a.score);
}

/**
 * Fetch brandURL / companyURL and extract product hero candidates (og:image, JSON-LD Product).
 * On official HTTP 403, falls back to Wikipedia lead image (og:image on Wikimedia).
 */
export async function extractOfficialProductImageUrls (
  context: ImageSearchContext
): Promise<string[]> {
  if (!parseEnvEnabled()) {
    return [];
  }

  const officialHosts = hostsFromContext(context);
  const { candidates, allOfficialBlocked } = await scrapePagesForCandidates({
    pageUrls: officialPageUrlsFromContext(context),
    logTag: 'official-product',
    allowedHosts: officialHosts,
    extract: extractProductCandidatesFromHtml
  });

  let allCandidates = candidates;
  const needFallback =
    parseFallbackEnabled() &&
    (allOfficialBlocked || allCandidates.length === 0);

  if (needFallback) {
    console.log(
      '[official-product] Official site blocked or empty — trying Wikipedia fallback (og:image)…'
    );
    const fallback = await scrapePagesForCandidates({
      pageUrls: buildFallbackPageUrls(context),
      logTag: 'official-product-fallback',
      allowedHosts: officialHosts,
      extract: extractProductCandidatesFromHtmlAllowingFallback
    });
    allCandidates = [ ...allCandidates, ...fallback.candidates ];
  }

  return mergeCandidates(allCandidates).slice(0, 3);
}
