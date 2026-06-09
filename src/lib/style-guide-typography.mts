/** Google Fonts CDN substitutes for proprietary / system brand typefaces. */

export type StyleGuideTypographyEntry = {
  fontFamily: string;
  fontWeight?: number;
  fontUses?: string;
};

export type StyleGuideTypography = {
  typography: StyleGuideTypographyEntry[];
};

export type GoogleFontSubstitute = {
  googleFamily: string;
  weights: string;
};

export const CSS_GENERIC_FONT_FALLBACKS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace'
]);

/** Google Fonts families that may appear as-is when listed in the style guide. */
const GOOGLE_FONTS_NATIVE = new Set([
  'inter',
  'roboto',
  'open sans',
  'lato',
  'montserrat',
  'poppins',
  'oswald',
  'raleway',
  'nunito',
  'work sans',
  'source sans 3',
  'barlow',
  'barlow condensed',
  'jost',
  'lora',
  'eb garamond',
  'playfair display',
  'merriweather',
  'pt serif',
  'bebas neue',
  'fredoka',
  'ibm plex mono',
  'roboto mono',
  'press start 2p',
  'bowlby one'
]);

const BRAND_FONT_RULES: ReadonlyArray<{ pattern: RegExp; substitute: GoogleFontSubstitute }> = [
  {
    pattern: /trade\s+gothic|franklin\s+gothic|news\s+gothic|alternate\s+gothic/i,
    substitute: { googleFamily: 'Barlow Condensed', weights: '600;700' }
  },
  {
    pattern: /futura|avant\s+garde|avenir|gotham|neue\s+haas/i,
    substitute: { googleFamily: 'Jost', weights: '600;700;800' }
  },
  {
    pattern: /helvetica|arial|univers|neue\s+helvetica|san\s+francisco|segoe/i,
    substitute: { googleFamily: 'Inter', weights: '400;500;600;700' }
  },
  {
    pattern: /palatino|georgia|times(\s+new\s+roman)?|garamond|baskerville/i,
    substitute: { googleFamily: 'Lora', weights: '400;500;600;700' }
  },
  {
    pattern: /playfair|didot|bodoni|libre\s+baskerville/i,
    substitute: { googleFamily: 'Playfair Display', weights: '400;500;600;700' }
  },
  {
    pattern: /roboto(?!\s+mono)/i,
    substitute: { googleFamily: 'Roboto', weights: '400;500;700' }
  },
  {
    pattern: /montserrat/i,
    substitute: { googleFamily: 'Montserrat', weights: '500;600;700' }
  },
  {
    pattern: /open\s+sans/i,
    substitute: { googleFamily: 'Open Sans', weights: '400;600;700' }
  }
];

export function normalizeFontFamilyName (name: string): string {
  return name.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/gu, ' ').toLowerCase();
}

function encodeGoogleFontFamilyParam (family: string, weights: string): string {
  const encoded = family.trim().replace(/\s+/gu, '+');
  if (weights.trim().length === 0) {
    return `family=${encoded}`;
  }
  return `family=${encoded}:wght@${weights}`;
}

/** Resolve a style-guide or CSS font name to a free Google Font substitute. */
export function resolveGoogleFontSubstitute (brandFontFamily: string): GoogleFontSubstitute {
  const normalized = normalizeFontFamilyName(brandFontFamily);
  if (GOOGLE_FONTS_NATIVE.has(normalized)) {
    const titleCase = brandFontFamily.trim().replace(/\s+/gu, ' ');
    return { googleFamily: titleCase, weights: '400;600;700' };
  }

  for (const rule of BRAND_FONT_RULES) {
    if (rule.pattern.test(brandFontFamily) || rule.pattern.test(normalized)) {
      return rule.substitute;
    }
  }

  if (/serif|palatino|times|georgia|garamond/i.test(normalized)) {
    return { googleFamily: 'Lora', weights: '400;600' };
  }

  return { googleFamily: 'Inter', weights: '400;500;600;700' };
}

export function buildGoogleFontsCss2Url (substitutes: readonly GoogleFontSubstitute[]): string {
  const seen = new Set<string>();
  const params: string[] = [];
  for (const sub of substitutes) {
    const key = `${sub.googleFamily}|${sub.weights}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    params.push(encodeGoogleFontFamilyParam(sub.googleFamily, sub.weights));
  }
  if (params.length === 0) {
    return 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap';
  }
  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}

export function collectTypographySubstitutes (
  styleGuide: StyleGuideTypography
): Array<{ brandFamily: string; substitute: GoogleFontSubstitute }> {
  const seenBrand = new Set<string>();
  const out: Array<{ brandFamily: string; substitute: GoogleFontSubstitute }> = [];
  for (const entry of styleGuide.typography) {
    const brand = entry.fontFamily.trim();
    if (brand.length === 0) {
      continue;
    }
    const key = normalizeFontFamilyName(brand);
    if (seenBrand.has(key)) {
      continue;
    }
    seenBrand.add(key);
    out.push({ brandFamily: brand, substitute: resolveGoogleFontSubstitute(brand) });
  }
  return out;
}

/** All font-family names allowed in generated CSS (brand + Google substitutes + variants). */
export function collectAllowedFontFamilies (styleGuide: StyleGuideTypography): Set<string> {
  const allowed = new Set<string>(CSS_GENERIC_FONT_FALLBACKS);
  for (const { brandFamily, substitute } of collectTypographySubstitutes(styleGuide)) {
    allowed.add(normalizeFontFamilyName(brandFamily));
    allowed.add(normalizeFontFamilyName(substitute.googleFamily));
  }
  return allowed;
}

export function fontIsAllowed (usedFont: string, allowed: Set<string>): boolean {
  const used = normalizeFontFamilyName(usedFont);
  if (allowed.has(used)) {
    return true;
  }
  for (const candidate of allowed) {
    if (candidate.length < 3) {
      continue;
    }
    if (used === candidate || used.startsWith(`${candidate} `) || candidate.startsWith(`${used} `)) {
      return true;
    }
  }
  return false;
}

export function extractFontFamiliesFromCss (content: string): Set<string> {
  const fontFamilyMatches = content.match(/font-family\s*:\s*([^;]+);/gi) ?? [];
  const familySet = new Set<string>();

  for (const declaration of fontFamilyMatches) {
    const declarationMatch = declaration.match(/font-family\s*:\s*([^;]+);/i);
    if (declarationMatch === null) {
      continue;
    }
    const list = declarationMatch[1] ?? '';
    for (const fontName of list.split(',')) {
      const cleaned = normalizeFontFamilyName(fontName);
      if (cleaned.length > 0) {
        familySet.add(cleaned);
      }
    }
  }

  return familySet;
}

/** Parse `family=Inter` / `family=Barlow+Condensed:wght@700` from Google Fonts URLs. */
export function extractFontFamiliesFromGoogleFontsUrls (content: string): Set<string> {
  const families = new Set<string>();
  const urlMatches = content.match(/fonts\.googleapis\.com\/css2\?[^"')\s]+/gi) ?? [];
  for (const url of urlMatches) {
    const familyChunks = url.match(/family=([^&]+)/gi) ?? [];
    for (const chunk of familyChunks) {
      const raw = chunk.replace(/^family=/iu, '');
      const namePart = raw.split(':')[0] ?? raw;
      const decoded = decodeURIComponent(namePart.replace(/\+/gu, ' ')).trim();
      if (decoded.length > 0) {
        families.add(normalizeFontFamilyName(decoded));
      }
    }
  }
  return families;
}

export function collectUsedFontFamilies (content: string): Set<string> {
  return new Set([
    ...extractFontFamiliesFromCss(content),
    ...extractFontFamiliesFromGoogleFontsUrls(content)
  ]);
}

export function filterDisallowedFonts (
  usedFonts: Iterable<string>,
  allowed: Set<string>
): string[] {
  return Array.from(usedFonts).filter((fontName) => !fontIsAllowed(fontName, allowed));
}

export function getFontComplianceIssue (
  content: string,
  styleGuide: StyleGuideTypography
): string | null {
  const allowed = collectAllowedFontFamilies(styleGuide);
  const disallowed = filterDisallowedFonts(collectUsedFontFamilies(content), allowed);
  if (disallowed.length === 0) {
    return null;
  }
  return `Contains font families outside style guide: ${disallowed.join(', ')}`;
}

export function buildStyleGuideFontConstraintText (styleGuide: StyleGuideTypography): string {
  const pairs = collectTypographySubstitutes(styleGuide);
  if (pairs.length === 0) {
    return (
      'Typography: load fonts from https://fonts.googleapis.com (css2). '
      + 'Use font-family names that match the Google Font families in the link — not proprietary system names.'
    );
  }

  const url = buildGoogleFontsCss2Url(pairs.map((p) => p.substitute));
  const lines = pairs.map(({ brandFamily, substitute }) => {
    const gf = substitute.googleFamily;
    return (
      `- Brand "${brandFamily}" → use Google Font "${gf}" only (not "${brandFamily}" or LT Std/Linotype variants in CSS).`
      + `\n  font-family: "${gf}", sans-serif;`
    );
  });

  return (
    'Typography — brand fonts are proprietary; use ONLY these Google Fonts CDN substitutes:\n'
    + `${lines.join('\n')}\n`
    + `Load once in index.html:\n`
    + `  <link rel="preconnect" href="https://fonts.googleapis.com">\n`
    + `  <link rel="stylesheet" href="${url}">\n`
    + 'Do NOT use commercial/system names (Trade Gothic LT Std, Century Gothic, Book Antiqua, Palatino Linotype, etc.) in font-family.'
  );
}

const FONT_COMPLIANCE_ISSUE = /font families outside style guide/iu;

export function buildFontComplianceRetryHint (styleGuide: StyleGuideTypography): string {
  const pairs = collectTypographySubstitutes(styleGuide);
  if (pairs.length === 0) {
    return '';
  }
  const url = buildGoogleFontsCss2Url(pairs.map((p) => p.substitute));
  const mapping = pairs
    .map(({ brandFamily, substitute }) => `"${brandFamily}" → "${substitute.googleFamily}"`)
    .join('; ');
  return (
    ` Allowed fonts via Google Fonts ONLY: ${mapping}. `
    + `Add <link href="${url}"> and use the Google family names in font-family. `
    + 'Remove Trade Gothic LT Std, Century Gothic, Book Antiqua, Palatino Linotype, and other unmapped system names.'
  );
}

export function appendFontComplianceRetryHint (
  issues: readonly string[],
  styleGuide: StyleGuideTypography
): string {
  if (!issues.some((issue) => FONT_COMPLIANCE_ISSUE.test(issue))) {
    return '';
  }
  return buildFontComplianceRetryHint(styleGuide);
}
