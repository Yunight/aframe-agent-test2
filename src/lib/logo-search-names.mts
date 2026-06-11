import { normalizeForTermMatch } from './style-guide-context.mts';

export type LogoSearchNameContext = {
  brandName: string;
  companyName: string;
  productName: string;
  brandContext?: string;
  campaignContext?: string;
  campaignReferenceUrl?: string;
  campaignUrls?: readonly string[];
};

const LEGAL_ENTITY_SUFFIX_RE =
  /(?:,\s*|\s+)(Inc\.?|LLC|Ltd\.?|L\.?L\.?C\.?|GmbH|AG|S\.?A\.?|Corp\.?|Corporation|S\.?A\.?S\.?|B\.?V\.?)\s*$/iu;

const COLLABORATION_CONTEXT_RE =
  /\b(collaboration|partnership|co-?brand(?:ed|ing)?|joint\s+venture|between\s+.+\s+and\s+)\b/iu;

const COMPANY_NOISE_TOKENS = new Set([
  'the',
  'group',
  'international',
  'company',
  'inc',
  'corp',
  'entertainment',
  'studios'
]);

/** Strip legal suffixes (Inc., GmbH, etc.) from a company name. */
export function normalizeLegalEntityName (name: string): string {
  let out = name.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEGAL_ENTITY_SUFFIX_RE, '').trim();
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

/**
 * Brand name(s) allowed in logo search queries.
 * Division lines (Nike Football) → parent only; independent sub-brands → brand + company.
 */
export function resolveLogoSearchNames (context: LogoSearchNameContext): string[] {
  const brand = context.brandName.trim();
  const company = normalizeLegalEntityName(context.companyName.trim());

  if (brand.length === 0 && company.length === 0) {
    return [];
  }
  if (brand.length === 0) {
    return company.length > 0 ? [ company ] : [];
  }
  if (company.length === 0) {
    return [ brand ];
  }

  if (brand.toLowerCase() === company.toLowerCase()) {
    return [ brand ];
  }

  const companyToken = company.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (companyToken.length >= 3 && brand.toLowerCase().startsWith(companyToken)) {
    return [ company ];
  }

  return [ brand, company ];
}

function extractCompanyBrandStem (companyName: string): string {
  const tokens = normalizeLegalEntityName(companyName.trim())
    .split(/\s+/u)
    .filter((t) => t.length > 0 && !COMPANY_NOISE_TOKENS.has(t.toLowerCase()));
  return tokens[0]?.toLowerCase() ?? '';
}

/** Product line / division (Nike Football) — not a multi-brand collaboration. */
export function isDivisionLineBrand (brandName: string, companyName: string): boolean {
  const brand = brandName.trim().toLowerCase();
  const company = normalizeLegalEntityName(companyName.trim()).toLowerCase();
  if (brand.length === 0 || company.length === 0) {
    return false;
  }
  if (brand === company) {
    return true;
  }
  const companyToken = company.split(/\s+/u)[0]?.toLowerCase() ?? '';
  if (companyToken.length >= 3 && brand.startsWith(companyToken)) {
    return true;
  }
  const stem = extractCompanyBrandStem(companyName);
  return stem.length >= 3 && brand.startsWith(stem);
}

function parseExplicitCollaborationParties (brandName: string): string[] {
  const cleaned = brandName.replace(/[®™]/gu, '').trim();
  const parts = cleaned
    .split(/\s*(?:×|x|&|\/)\s*/iu)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length >= 2 ? parts : [];
}

function parseTrademarkBrandParties (brandName: string): string[] {
  const segments: string[] = [];
  const re = /([\p{L}\p{N}][\p{L}\p{N}'’.\-]*)\s*[®™]/gu;
  let match: RegExpExecArray | null = re.exec(brandName);
  while (match !== null) {
    segments.push(match[1]!.trim());
    match = re.exec(brandName);
  }
  return segments;
}

function parsePartiesFromCollaborationContext (brandContext: string): string[] {
  const betweenMatch = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:[,.]|$)/iu.exec(brandContext.trim());
  if (betweenMatch === null) {
    return [];
  }
  const shortenParty = (raw: string): string => {
    const tokens = raw
      .replace(/[®™]/gu, '')
      .split(/\s+/u)
      .filter((t) => t.length > 0 && !COMPANY_NOISE_TOKENS.has(t.toLowerCase()));
    return tokens[0]?.trim() ?? raw.trim();
  };
  const a = shortenParty(betweenMatch[1] ?? '');
  const b = shortenParty(betweenMatch[2] ?? '');
  return a.length > 0 && b.length > 0 ? [ a, b ] : [];
}

/**
 * True when the campaign is a collaboration between distinct brands (e.g. LEGO × Pokémon),
 * not a retailer sub-brand (Parkside) or product line (Nike Football).
 */
export function isCollaborationCampaign (context: {
  brandName: string;
  companyName: string;
  brandContext?: string;
}): boolean {
  const ctx = (context.brandContext ?? '').trim();
  if (COLLABORATION_CONTEXT_RE.test(ctx)) {
    return true;
  }
  if (parseExplicitCollaborationParties(context.brandName).length >= 2) {
    return true;
  }
  if (parseTrademarkBrandParties(context.brandName).length >= 2) {
    return true;
  }
  if (isDivisionLineBrand(context.brandName, context.companyName)) {
    return false;
  }
  return false;
}

/** Participating brand names that should each have a separate wordmark file in logos/. */
export function resolveCollaborationLogoParties (context: {
  brandName: string;
  brandContext?: string;
}): string[] {
  const explicit = parseExplicitCollaborationParties(context.brandName);
  if (explicit.length >= 2) {
    return explicit;
  }
  const trademark = parseTrademarkBrandParties(context.brandName);
  if (trademark.length >= 2) {
    return trademark;
  }
  const fromContext = parsePartiesFromCollaborationContext(context.brandContext ?? '');
  if (fromContext.length >= 2) {
    return fromContext;
  }
  return explicit.length > 0 ? explicit : trademark;
}

/** System-prompt lines for collaboration logo audits (vision + assets review). */
export function buildCollaborationLogoAuditRules (context: {
  brandName: string;
  companyName: string;
  brandContext?: string;
}): string[] {
  const parties = resolveCollaborationLogoParties(context);
  const partyList = parties.length > 0 ? parties.join(', ') : context.brandName.trim();
  return [
    `- COLLABORATION CAMPAIGN (${partyList}): brandName "${context.brandName}" names the partnership, NOT a single composite logo file.`,
    '  * logos/ must use SEPARATE official wordmark files — one per participating brand when available.',
    '  * NEVER require, source, or BLOCKER because a file lacks a co-branded composite lockup (e.g. "LEGO Pokémon" in one image). Such assets usually do not exist.',
    '  * ACCEPT a file showing only one participating brand wordmark (e.g. LEGO only is valid).',
    `  * WARN (not blocker) when no logos/ file visually matches a listed party (${partyList}) — suggest one brave_retry_queries.logos entry per missing party using that party name only.`,
    '  * BLOCKER if the only logo file is a single composite image bundling multiple brand wordmarks together.',
    '  * BLOCKER for wrong brand, product packshot, or third-party scraper assets (same as standard rules).',
    '  * brave_retry_queries.logos: one query per missing party name only — never "co-branded lockup" or combined campaign brandName strings.'
  ];
}

function tokenizeForLogoFilter (text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 4 && !/^\d+$/u.test(t));
}

function extractForbiddenLogoQueryTokens (context: LogoSearchNameContext): Set<string> {
  const allowed = new Set(
    resolveLogoSearchNames(context).flatMap((n) => tokenizeForLogoFilter(n))
  );
  const forbidden = new Set<string>();

  for (const raw of [
    context.productName,
    context.campaignContext ?? '',
    context.brandContext ?? ''
  ]) {
    for (const t of tokenizeForLogoFilter(raw)) {
      if (!allowed.has(t)) {
        forbidden.add(t);
      }
    }
  }

  for (const rawUrl of [
    context.campaignReferenceUrl,
    ...(context.campaignUrls ?? [])
  ]) {
    if (rawUrl === undefined || rawUrl.trim().length === 0) {
      continue;
    }
    try {
      const segments = new URL(rawUrl.trim()).pathname.split('/').filter((s) => s.length >= 4);
      for (const seg of segments) {
        for (const t of seg.replace(/-/gu, ' ').split(/\s+/u)) {
          const lower = t.toLowerCase();
          if (lower.length >= 4 && !/^\d+$/u.test(lower) && !allowed.has(lower)) {
            forbidden.add(lower);
          }
        }
      }
    } catch {
      // skip invalid URL
    }
  }

  return forbidden;
}

/** Drop logo queries that contain campaign/product/context tokens not in allowed brand names. */
export function filterLogoSearchQueries (
  queries: readonly string[],
  context: LogoSearchNameContext
): string[] {
  const forbidden = extractForbiddenLogoQueryTokens(context);
  if (forbidden.size === 0) {
    return [ ...queries ];
  }
  return queries.filter((q) => {
    const hay = normalizeForTermMatch(q);
    for (const token of forbidden) {
      if (hay.includes(token)) {
        return false;
      }
    }
    return true;
  });
}
