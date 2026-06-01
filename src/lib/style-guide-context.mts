/**
 * Parse STYLE_GUIDE_CONTEXT / studio contextPrompt and derive product image match terms.
 */

import { pageUrlsMatchForBoost, resolveReferenceListingUrls } from './reference-listing-urls.mts';
import type { ProductAssetSourceEntry } from './product-asset-sources.mts';

const CONTEXT_IS_RE =
  /\bthe context is\s+(.+?)(?:\.\s*|$)/ius;
const CONTEXT_ONLY_RE =
  /\bNo commercial brand[^.]*\.\s*The context is\s+(.+?)(?:\.\s*|$)/ius;

const PRODUCT_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'new',
  'they',
  'are',
  'was',
  'were',
  'will',
  'has',
  'have',
  'its',
  'their',
  'our',
  'your',
  'not',
  'but',
  'into',
  'about',
  'launching',
  'launch',
  'officiel',
  'official',
  'photo',
  'image',
  'visuel',
  'marketing',
  'packshot',
  'produit',
  'product',
  'brand',
  'marque',
  'context',
  'specified',
  'beyond',
  'infer',
  'electric',
  'electrique',
  'hybrid',
  'hybride',
  'vehicle',
  'voiture',
  'car',
  'auto',
  'ev',
  'neu',
  'neue',
  'nouveau',
  'nouvelle'
]);

export type ParsedStyleGuideContext = {
  raw: string;
  /** Text after "the context is …" when present. */
  campaignContext: string | null;
  /** HTTPS URLs found in the full prompt (user-provided collection pages, etc.). */
  campaignUrls: string[];
};

const CATALOG_CAMPAIGN_RE =
  /\b(collection|campagne|campaign|lookbook|catalogue|catalog|saison|season|été|ete|summer|spring|winter|holiday|plage|beach|promotion|promotions|offres?|coupons?|soldes|imbattable|deals|prospectus|arrivages?|hebdomadaire|weekly)\b/iu;

export type ProductMatchFields = {
  campaignContext?: string | null;
  productName?: string;
  brandName?: string;
  brandContext?: string;
  brandURL?: string;
  campaignReferenceUrl?: string | null;
  campaignUrls?: readonly string[];
};

/** Extract campaign clause from a composed context prompt. */
export function extractCampaignContextFromPrompt (prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const m1 = CONTEXT_IS_RE.exec(trimmed);
  if (m1?.[1] !== undefined) {
    return m1[1].trim();
  }
  const m2 = CONTEXT_ONLY_RE.exec(trimmed);
  if (m2?.[1] !== undefined) {
    return m2[1].trim();
  }
  return null;
}

/** Listing / multi-product campaign: reference URL and/or catalog-style context text. */
export function isListingPageCampaign (fields: ProductMatchFields): boolean {
  if (resolveReferenceListingUrls(fields).length > 0) {
    return true;
  }
  const hay = [
    fields.productName ?? '',
    fields.campaignContext ?? '',
    fields.brandContext ?? ''
  ]
    .join(' ')
    .trim();
  if (hay.length === 0) {
    return false;
  }
  return CATALOG_CAMPAIGN_RE.test(hay);
}

/** @deprecated Use isListingPageCampaign — kept for existing imports. */
export function isCatalogCampaign (fields: ProductMatchFields): boolean {
  return isListingPageCampaign(fields);
}

export { resolveReferenceListingUrls };

export function isProductAssetFromReferenceListing (
  entry: ProductAssetSourceEntry,
  referenceUrls: readonly string[]
): boolean {
  if (referenceUrls.length === 0) {
    return false;
  }
  if (entry.fromReferencePage === true) {
    return true;
  }
  const page = entry.sourcePageUrl?.trim() ?? '';
  if (page.length > 0) {
    return referenceUrls.some((ref) => pageUrlsMatchForBoost(ref, page));
  }
  return false;
}

/** Same rules as listing-mode product review in creative-native-assets-deterministic. */
export function wouldPassListingProductAsset (params: {
  entry: ProductAssetSourceEntry | undefined;
  sourceUrl: string;
  referenceListingUrls: readonly string[];
  officialHosts: readonly string[];
  terms: readonly string[];
  minScore?: number;
}): boolean {
  const sourceUrl = params.sourceUrl.trim();
  if (sourceUrl.length === 0) {
    return false;
  }
  const minScore = params.minScore ?? productMinRelevanceScore();
  const hostOk = hostOnOfficialList(sourceUrl, params.officialHosts);
  const trustedOfficialVisual = isOfficialHostCampaignOrProductImageUrl(
    sourceUrl,
    params.officialHosts
  );
  const referenceProvenance =
    params.entry !== undefined &&
    isProductAssetFromReferenceListing(params.entry, params.referenceListingUrls);
  const contextOk = scoreProductContextRelevance(sourceUrl, '', params.terms) >= minScore;
  return referenceProvenance || (hostOk && trustedOfficialVisual) || contextOk;
}

export function parseStyleGuideContextPrompt (
  prompt: string,
  extractUrls: (text: string) => string[] = () => []
): ParsedStyleGuideContext {
  const raw = prompt.trim();
  const fromRaw = extractUrls(raw);
  const campaign = extractCampaignContextFromPrompt(prompt);
  const fromCampaign = campaign !== null ? extractUrls(campaign) : [];
  return {
    raw,
    campaignContext: campaign,
    campaignUrls: [ ...new Set([ ...fromRaw, ...fromCampaign ]) ]
  };
}

function slugVariants (slug: string): string[] {
  const lower = slug.toLowerCase();
  const out = new Set<string>([ lower, lower.replace(/-/g, ' '), lower.replace(/-/g, '_') ]);
  for (const part of lower.split(/[-_]+/u)) {
    if (part.length >= 3 && !/^\d+$/u.test(part)) {
      out.add(part);
      for (const alias of scandinavianSlugAliases(part)) {
        out.add(alias);
      }
    }
  }
  return [ ...out ];
}

/** ö/ø in names vs oe in URL slugs (e.g. SÖDERHAMN → soderhamn vs soederhamn). */
function scandinavianSlugAliases (slugPart: string): string[] {
  const base = normalizeForTermMatch(slugPart);
  const out = new Set<string>();
  if (/^soder/iu.test(base)) {
    out.add(base.replace(/^soder/iu, 'soeder'));
  }
  if (/^soeder/iu.test(base)) {
    out.add(base.replace(/^soeder/iu, 'soder'));
  }
  return [ ...out ];
}

/** Path folder names that rarely identify a product/campaign (locale, taxonomy, shop roots). */
const BRAND_URL_PATH_SKIP = new Set([
  'www',
  'shop',
  'store',
  'boutique',
  'magasin',
  'eshop',
  'e-shop',
  'products',
  'product',
  'produits',
  'produit',
  'collections',
  'collection',
  'categories',
  'category',
  'catalog',
  'catalogue',
  'catalogs',
  'browse',
  'search',
  'modeles',
  'models',
  'model',
  'pages',
  'page',
  'home',
  'index',
  'html',
  'p',
  'c',
  'en',
  'fr',
  'de',
  'es',
  'it',
  'nl',
  'be',
  'ch',
  'uk',
  'us',
  'ca',
  'au',
  'jp',
  'cn'
]);

function isSignificantBrandUrlSegment (segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.length < 3) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (BRAND_URL_PATH_SKIP.has(lower)) {
    return false;
  }
  if (/^[a-z]{2}(-[a-z]{2})?$/iu.test(lower)) {
    return false;
  }
  if (/^\d+$/u.test(lower)) {
    return false;
  }
  return /[\p{L}]/u.test(trimmed);
}

/** Derive match terms from the last meaningful pathname segments of brandURL. */
function termsFromBrandUrlPath (brandURL: string | undefined): string[] {
  if (brandURL === undefined || brandURL.trim().length === 0) {
    return [];
  }
  try {
    const segments = new URL(brandURL.trim()).pathname.split('/').filter((s) => s.length > 0);
    const terms: string[] = [];
    for (const seg of segments) {
      if (!isSignificantBrandUrlSegment(seg)) {
        continue;
      }
      for (const v of slugVariants(seg)) {
        terms.push(v);
      }
    }
    return terms;
  } catch {
    return [];
  }
}

function tokensFromText (text: string, brandName: string): string[] {
  const brandLower = brandName.trim().toLowerCase();
  const stop = new Set(PRODUCT_STOPWORDS);
  if (brandLower.length > 0) {
    for (const part of brandLower.split(/\s+/u)) {
      stop.add(part);
    }
  }

  const phrases: string[] = [];
  const normalized = text.replace(/[_/]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    return [];
  }

  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const significant = words.filter((w) => w.length >= 2 && !stop.has(w.toLowerCase()));

  for (let len = Math.min(4, significant.length); len >= 2; len -= 1) {
    for (let i = 0; i <= significant.length - len; i += 1) {
      const slice = significant.slice(i, i + len);
      if (slice.some((w) => w.length >= 3 || /\d/u.test(w))) {
        phrases.push(slice.join(' '));
      }
    }
  }

  for (const w of significant) {
    if (w.length >= 3 || /\d/u.test(w)) {
      phrases.push(w);
    }
  }

  return phrases;
}

/** Terms used to rank/filter product images (longest phrases first). */
export function buildProductMatchTerms (fields: ProductMatchFields): string[] {
  const brand = fields.brandName?.trim() ?? '';
  const terms = new Set<string>();

  const productName = fields.productName?.trim() ?? '';
  if (productName.length > 0) {
    terms.add(productName);
    for (const t of tokensFromText(productName, brand)) {
      terms.add(t);
      for (const alias of scandinavianSlugAliases(t)) {
        terms.add(alias);
      }
    }
    for (const alias of scandinavianSlugAliases(productName)) {
      terms.add(alias);
    }
  }

  const campaign = fields.campaignContext?.trim() ?? '';
  if (campaign.length > 0) {
    for (const t of tokensFromText(campaign, brand)) {
      terms.add(t);
    }
  }

  const brandCtx = fields.brandContext?.trim() ?? '';
  if (brandCtx.length > 0 && productName.length > 0) {
    const productLower = productName.toLowerCase();
    const sentences = brandCtx.split(/[.!?]+/u);
    for (const sentence of sentences) {
      if (sentence.toLowerCase().includes(productLower)) {
        for (const t of tokensFromText(sentence, brand)) {
          terms.add(t);
        }
      }
    }
  }

  for (const t of termsFromBrandUrlPath(fields.brandURL)) {
    terms.add(t);
  }

  return [ ...terms ]
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function escapeRegExp (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Fold accents so URL paths like PLEIN_ETE match campaign terms with « été ». */
export function normalizeForTermMatch (text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[_]+/gu, '-');
}

function termMatchesHaystack (term: string, haystack: string): boolean {
  const t = normalizeForTermMatch(term.trim());
  if (t.length === 0) {
    return false;
  }
  const hay = normalizeForTermMatch(haystack);
  const flexible = escapeRegExp(t).replace(/\s+/gu, '[-_\\s]+');
  return new RegExp(flexible, 'iu').test(hay);
}

function hostOnOfficialList (url: string, officialHosts: readonly string[]): boolean {
  if (officialHosts.length === 0) {
    return false;
  }
  const host = new URL(url).hostname.toLowerCase();
  return officialHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`)
  );
}

/** Paths that are clearly not product/promo visuals on brand CDNs (payments, app UI, guides). */
const OFFICIAL_NON_CAMPAIGN_ASSET_RE =
  /(?:^|\/)(?:logo|footer|payment|visa|mastercard|paypal|apple-store|google-store|dpd-|arrow-|fonctionnalites_|newsletter|whatsapp|blog|guide_|recettes|categorie_visuel|online_shop_icons)(?:[./_-]|$)/iu;

/** Official brand CDN packshots (e.g. Demandware /dw/image/) — trusted without marketing-term match. */
export function isOfficialBrandProductImageUrl (
  url: string,
  officialHosts: readonly string[]
): boolean {
  if (officialHosts.length === 0) {
    return false;
  }
  try {
    if (!hostOnOfficialList(url, officialHosts)) {
      return false;
    }
    const lower = url.toLowerCase();
    return (
      /\/dw\/image\//iu.test(lower) ||
      /\/on\/demandware\.static\//iu.test(lower) ||
      /packshot|product[_-]?image|_prd\/|\/products?\//iu.test(lower)
    );
  } catch {
    return false;
  }
}

/**
 * Official host campaign / promo visuals (e.g. Lidl /static/assets/WON-*.jpg) — trusted like packshots.
 */
export function isOfficialHostCampaignOrProductImageUrl (
  url: string,
  officialHosts: readonly string[]
): boolean {
  if (isOfficialBrandProductImageUrl(url, officialHosts)) {
    return true;
  }
  if (officialHosts.length === 0) {
    return false;
  }
  try {
    if (!hostOnOfficialList(url, officialHosts)) {
      return false;
    }
    const lower = url.toLowerCase();
    if (OFFICIAL_NON_CAMPAIGN_ASSET_RE.test(lower) || /\.svg(?:\?|$)/iu.test(lower)) {
      return false;
    }
    if (
      /\/static\/assets\//iu.test(lower) ||
      /\/cdn\/assets\//iu.test(lower) ||
      /\/assets\/gcp[\da-f]/iu.test(lower)
    ) {
      return /\.(?:jpe?g|png|webp)(?:\?|$)/iu.test(lower);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Filter non-official URLs by context terms; keep all official /dw/image/ packshots.
 */
export function filterPrioritizeProductUrls (
  urls: readonly string[],
  terms: readonly string[],
  minScore: number,
  officialHosts: readonly string[]
): string[] {
  const official: string[] = [];
  const other: string[] = [];
  for (const url of urls) {
    if (isOfficialHostCampaignOrProductImageUrl(url, officialHosts)) {
      official.push(url);
    } else {
      other.push(url);
    }
  }
  const filteredOther =
    terms.length === 0 ? [ ...other ] : filterUrlsByProductRelevance(other, terms, minScore);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [ ...official, ...filteredOther ]) {
    if (!seen.has(url)) {
      seen.add(url);
      merged.push(url);
    }
  }
  return merged;
}

/**
 * Relevance score for a product image URL/title against context-derived terms.
 * Negative when URL clearly names another model than the primary product phrase.
 */
export function scoreProductContextRelevance (
  url: string,
  title: string,
  terms: readonly string[]
): number {
  if (terms.length === 0) {
    return 0;
  }

  const hay = normalizeForTermMatch(`${url} ${title}`);
  let score = 0;
  let matched = false;

  for (const term of terms) {
    if (termMatchesHaystack(term, hay)) {
      matched = true;
      score += Math.min(60, 12 + term.length * 2);
    }
  }

  if (!matched) {
    return -20;
  }

  score -= scoreSiblingProductPenalty(primaryTermForSiblingPenalty(terms, hay), hay);

  return score;
}

/** Prefer the longest term that actually appears in the URL/title — not the longest campaign word (e.g. "promotion"). */
function primaryTermForSiblingPenalty (terms: readonly string[], hay: string): string {
  const matched = terms.filter((t) => termMatchesHaystack(t, hay));
  if (matched.length === 0) {
    return terms[0] ?? '';
  }
  return [ ...matched ].sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * When the primary term and the URL both look like product slugs but disagree on a
 * distinguishing token (e.g. seal-u vs sealion-7), apply a penalty without hard-coded brands.
 */
function scoreSiblingProductPenalty (primaryTerm: string, hay: string): number {
  const primary = normalizeForTermMatch(primaryTerm);
  if (primary.length < 3) {
    return 0;
  }

  const primaryTokens = primary.split(/[-_\s]+/u).filter((t) => t.length >= 2);
  if (primaryTokens.length === 0) {
    return 0;
  }

  const hayTokens = new Set(
    hay.split(/[-_\s./]+/u).filter((t) => t.length >= 2)
  );

  const primaryInHay = primaryTokens.every((t) => hayTokens.has(t) || hay.includes(t));
  if (primaryInHay) {
    return 0;
  }

  const overlap = primaryTokens.filter((t) => hayTokens.has(t) || [ ...hayTokens ].some((h) => h.includes(t) || t.includes(h)));
  if (overlap.length === 0) {
    return 0;
  }

  const distinctivePrimary = primaryTokens.filter((t) => /\d/u.test(t) || t.length >= 4);
  const distinctiveHay = [ ...hayTokens ].filter((t) => /\d/u.test(t) || t.length >= 4);

  if (distinctivePrimary.length === 0 || distinctiveHay.length === 0) {
    return 0;
  }

  const primaryDistinctMatch = distinctivePrimary.some(
    (t) => hayTokens.has(t) || hay.includes(t)
  );
  const hayDistinctMismatch = distinctiveHay.some(
    (t) => !primaryTokens.includes(t) && !primary.includes(t) && (/\d/u.test(t) || t.length >= 5)
  );

  if (primaryDistinctMatch === false && hayDistinctMismatch) {
    return 90;
  }

  return 0;
}

export function filterUrlsByProductRelevance (
  urls: readonly string[],
  terms: readonly string[],
  minScore: number
): string[] {
  if (terms.length === 0) {
    return [ ...urls ];
  }
  return urls
    .map((url) => ({ url, score: scoreProductContextRelevance(url, '', terms) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.url);
}

export function productMinRelevanceScore (): number {
  const raw = process.env['CREATIVE_PRODUCT_MIN_RELEVANCE_SCORE']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 12;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 12;
}
