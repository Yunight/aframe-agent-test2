import { officialPageFetchHeaders } from './official-fetch.mts';

const URL_CHECK_TIMEOUT_MS = 12_000;

const HTTPS_URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/giu;

/** Color/filter path segments models invent (e.g. /Bleu200) — not valid listing pages. */
const SUSPECT_PATH_SEGMENT_RE =
  /^[A-Z][a-z]{2,15}\d{0,3}$/u;

export function extractHttpsUrlsFromText (text: string): string[] {
  const matches = text.match(HTTPS_URL_RE) ?? [];
  const out: string[] = [];
  for (let raw of matches) {
    raw = raw.replace(/[.,;:!?)]+$/u, '');
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        out.push(u.href);
      }
    } catch {
      // skip
    }
  }
  return [ ...new Set(out) ];
}

export async function checkUrlReachable (url: string): Promise<{
  ok: boolean;
  status: number | null;
  timedOut: boolean;
}> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: officialPageFetchHeaders(),
      signal: AbortSignal.timeout(URL_CHECK_TIMEOUT_MS)
    });
    if (res.status === 405 || res.status === 501) {
      const getRes = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: officialPageFetchHeaders(),
        signal: AbortSignal.timeout(URL_CHECK_TIMEOUT_MS)
      });
      return { ok: getRes.ok, status: getRes.status, timedOut: false };
    }
    return { ok: res.ok, status: res.status, timedOut: false };
  } catch (err: unknown) {
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout/iu.test(err.message));
    return { ok: false, status: null, timedOut };
  }
}

function stripSuspectTrailingSegment (url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) {
      return null;
    }
    const last = parts[parts.length - 1];
    if (last === undefined || !SUSPECT_PATH_SEGMENT_RE.test(last)) {
      return null;
    }
    parts.pop();
    u.pathname = parts.length > 0 ? `/${parts.join('/')}/` : '/';
    return u.href;
  } catch {
    return null;
  }
}

function parentPathUrl (url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length <= 1) {
      return u.origin + '/';
    }
    parts.pop();
    u.pathname = `/${parts.join('/')}/`;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * User/API URL wins; else first HTTPS URL extracted from the prompt.
 */
export function resolveCampaignReferenceUrl (params: {
  explicit?: string | null;
  fromPromptUrls?: readonly string[];
}): string | null {
  const explicit = params.explicit?.trim() ?? '';
  if (explicit.length > 0) {
    try {
      return new URL(explicit).href;
    } catch {
      // fall through
    }
  }
  for (const raw of params.fromPromptUrls ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      return new URL(trimmed).href;
    } catch {
      continue;
    }
  }
  return null;
}

/** HEAD/GET preflight for the campaign reference URL before style-guide generation. */
export async function preflightCampaignReferenceUrl (url: string): Promise<{
  reachable: boolean;
  blocked: boolean;
  status: number | null;
  normalizedUrl: string;
  logLine: string;
  timedOut: boolean;
}> {
  const trimmed = url.trim();
  let normalizedUrl = trimmed;
  let anyTimedOut = false;
  const first = await checkUrlReachable(trimmed);
  anyTimedOut = anyTimedOut || first.timedOut;
  if (!first.ok) {
    const stripped = stripSuspectTrailingSegment(trimmed);
    if (stripped !== null) {
      const retry = await checkUrlReachable(stripped);
      anyTimedOut = anyTimedOut || retry.timedOut;
      if (retry.ok) {
        normalizedUrl = stripped;
        return {
          reachable: true,
          blocked: false,
          status: retry.status,
          normalizedUrl,
          logLine: `[style-guide] reference URL normalized: ${trimmed} → ${normalizedUrl}`,
          timedOut: false
        };
      }
    }
    const parent = parentPathUrl(trimmed);
    if (parent !== null && !anyTimedOut) {
      const retry = await checkUrlReachable(parent);
      anyTimedOut = anyTimedOut || retry.timedOut;
      if (retry.ok) {
        normalizedUrl = parent;
        return {
          reachable: true,
          blocked: false,
          status: retry.status,
          normalizedUrl,
          logLine: `[style-guide] reference URL normalized: ${trimmed} → ${normalizedUrl}`,
          timedOut: false
        };
      }
    }
    const status = first.status;
    const blocked = status === 401 || status === 403 || status === 406 || status === 451;
    return {
      reachable: false,
      blocked,
      status,
      normalizedUrl: trimmed,
      timedOut: anyTimedOut,
      logLine: anyTimedOut
        ? '[style-guide] reference URL check timed out — fallback to search/scrape'
        : blocked
          ? `[style-guide] reference URL blocked (HTTP ${String(status)}) — fallback to search/scrape`
          : `[style-guide] reference URL not reachable (HTTP ${String(status)}) — fallback to search/scrape`
    };
  }
  return {
    reachable: true,
    blocked: false,
    status: first.status,
    normalizedUrl,
    timedOut: false,
    logLine: `[style-guide] reference URL reachable: ${normalizedUrl}`
  };
}

async function firstReachableUrl (candidates: readonly string[]): Promise<string | null> {
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const { ok } = await checkUrlReachable(trimmed);
    if (ok) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Ensure brandURL (and optionally companyURL) respond with HTTP success.
 * Prefers user-provided campaign URLs from the prompt when model URL fails.
 */
/** Strip JSON/LLM junk after URLs (e.g. trailing `','` from malformed model output). */
export function sanitizeModelUrl (url: string): string {
  let s = url.trim();
  s = s.replace(/^['"]+|['"]+$/gu, '');
  s = s.replace(/[,;'"]+$/u, '');
  return s.trim();
}

export async function normalizeBrandAndCompanyUrls (params: {
  brandURL: string;
  companyURL: string;
  campaignReferenceUrl?: string | null;
  campaignUrlsFromPrompt?: readonly string[];
}): Promise<{
  brandURL: string;
  companyURL: string;
  changed: boolean;
  logLine: string | null;
}> {
  let brandURL = sanitizeModelUrl(params.brandURL);
  let companyURL = sanitizeModelUrl(params.companyURL);
  const originalBrand = brandURL;
  const promptUrls = (params.campaignUrlsFromPrompt ?? []).map((u) => sanitizeModelUrl(u));
  const referenceUrl = sanitizeModelUrl(params.campaignReferenceUrl?.trim() ?? '');

  const tryNormalizeBrand = async (start: string): Promise<string> => {
    const candidates: string[] = [];
    if (referenceUrl.length > 0) {
      candidates.push(referenceUrl);
      const refStripped = stripSuspectTrailingSegment(referenceUrl);
      if (refStripped !== null) {
        candidates.push(refStripped);
      }
      const refParent = parentPathUrl(referenceUrl);
      if (refParent !== null) {
        candidates.push(refParent);
      }
    }
    candidates.push(start);
    const stripped = stripSuspectTrailingSegment(start);
    if (stripped !== null) {
      candidates.push(stripped);
    }
    const parent = parentPathUrl(start);
    if (parent !== null) {
      candidates.push(parent);
    }
    for (const u of promptUrls) {
      candidates.push(u);
      const p = parentPathUrl(u);
      if (p !== null) {
        candidates.push(p);
      }
    }
    if (companyURL.length > 0) {
      candidates.push(companyURL);
    }

    const unique = [ ...new Set(candidates) ];
    const hit = await firstReachableUrl(unique);
    return hit ?? start;
  };

  if (referenceUrl.length > 0) {
    const { ok: refOk } = await checkUrlReachable(referenceUrl);
    if (refOk) {
      brandURL = referenceUrl;
    } else {
      brandURL = await tryNormalizeBrand(brandURL);
    }
  } else {
    const { ok: brandOk } = await checkUrlReachable(brandURL);
    if (!brandOk) {
      brandURL = await tryNormalizeBrand(brandURL);
    }
  }

  const { ok: companyOk } = await checkUrlReachable(companyURL);
  if (!companyOk && companyURL.length > 0) {
    const fallback = await firstReachableUrl([
      brandURL,
      ...promptUrls,
      parentPathUrl(brandURL) ?? ''
    ].filter((u) => u.length > 0));
    if (fallback !== null) {
      try {
        companyURL = new URL(fallback).origin + '/';
      } catch {
        // keep
      }
    }
  }

  const changed = brandURL !== originalBrand;
  const logLine = changed
    ? `[style-guide] brandURL normalized: ${originalBrand} → ${brandURL}`
    : null;

  return { brandURL, companyURL, changed, logLine };
}
