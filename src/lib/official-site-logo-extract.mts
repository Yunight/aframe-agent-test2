import type { ImageSearchContext } from './brave-image-assets.mts';
import { isUntrustedLogoUrl } from './logo-transparency-check.mts';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_HTML_BYTES = 2_500_000;

type ScoredLogoUrl = { url: string; score: number; reason: string };

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

async function fetchPageHtml (url: string): Promise<string | null> {
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
      console.warn(`[official-logo] HTTP ${String(res.status)} for ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) {
      return buf.subarray(0, MAX_HTML_BYTES).toString('utf8');
    }
    return buf.toString('utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[official-logo] Fetch failed ${url}: ${msg}`);
    return null;
  }
}

/**
 * Fetch brandURL / companyURL homepages and extract header logo image URLs.
 * Prefer SVG/PNG lockups from .primary-logo, .logo-container, img.logo-simple, etc.
 */
export async function extractOfficialHeaderLogoUrls (
  context: ImageSearchContext
): Promise<string[]> {
  if (!parseEnvEnabled()) {
    return [];
  }

  const officialHosts = hostsFromContext(context);
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

  const seenPages = new Set<string>();
  const allCandidates: ScoredLogoUrl[] = [];

  for (const pageUrl of pageUrls) {
    if (seenPages.has(pageUrl)) {
      continue;
    }
    seenPages.add(pageUrl);
    console.log(`[official-logo] Fetching homepage: ${pageUrl}`);
    const html = await fetchPageHtml(pageUrl);
    if (html === null || html.length < 200) {
      continue;
    }
    const found = extractLogoCandidatesFromHtml(html, pageUrl, officialHosts);
    for (const c of found) {
      console.log(`[official-logo]   score=${String(c.score)} ${c.reason} → ${c.url}`);
      allCandidates.push(c);
    }
  }

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
