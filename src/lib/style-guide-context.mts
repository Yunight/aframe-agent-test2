/**
 * Parse STYLE_GUIDE_CONTEXT / studio contextPrompt and derive product image match terms.
 */

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
};

export type ProductMatchFields = {
  campaignContext?: string | null;
  productName?: string;
  brandName?: string;
  brandContext?: string;
  brandURL?: string;
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

export function parseStyleGuideContextPrompt (prompt: string): ParsedStyleGuideContext {
  return {
    raw: prompt.trim(),
    campaignContext: extractCampaignContextFromPrompt(prompt)
  };
}

function slugVariants (slug: string): string[] {
  const lower = slug.toLowerCase();
  const out = new Set<string>([ lower, lower.replace(/-/g, ' '), lower.replace(/-/g, '_') ]);
  return [ ...out ];
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

  try {
    const path = fields.brandURL !== undefined ? new URL(fields.brandURL.trim()).pathname : '';
    const segments = path.split('/').filter((s) => s.length >= 3);
    for (const seg of segments) {
      if (/seal|dolphin|atto|han|tang|sealion|model|voiture|car|product/iu.test(seg)) {
        for (const v of slugVariants(seg)) {
          terms.add(v);
        }
      }
    }
  } catch {
    /* ignore invalid brandURL */
  }

  return [ ...terms ]
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length);
}

function escapeRegExp (s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function termMatchesHaystack (term: string, haystack: string): boolean {
  const t = term.toLowerCase().trim();
  if (t.length === 0) {
    return false;
  }
  const flexible = escapeRegExp(t).replace(/\s+/gu, '[-_\\s]+');
  return new RegExp(flexible, 'iu').test(haystack);
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

  const hay = `${url} ${title}`.toLowerCase().replace(/[_]+/gu, '-');
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

  const primary = terms[0]?.toLowerCase() ?? '';
  const primaryNorm = primary.replace(/\s+/gu, '');

  const conflictingPatterns: Array<{ whenPrimary: RegExp; conflict: RegExp }> = [
    { whenPrimary: /seal[\s_-]*u|sealu/iu, conflict: /\bsealion|seal-6|seal6|seal_6/iu },
    { whenPrimary: /sealion[\s_-]*7|sealion7/iu, conflict: /\bseal[\s_-]*u|seal-6\b|seal6\b/iu },
    { whenPrimary: /\b208\b|gti/iu, conflict: /\b308\b|\b2008\b|\b3008\b|\b5008\b/iu }
  ];

  for (const rule of conflictingPatterns) {
    if (rule.whenPrimary.test(primary) || rule.whenPrimary.test(hay)) {
      if (rule.conflict.test(hay) && !termMatchesHaystack(primary, hay)) {
        score -= 90;
      }
    }
  }

  return score;
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
