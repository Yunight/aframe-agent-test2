/** Normalize palette entries to `#RRGGBB` for style-guide.json and CSS consumers. */

import { appendFontComplianceRetryHint, type StyleGuideTypography } from './style-guide-typography.mts';

export function toStyleGuideHex (value: string): string {
  const bare = value.trim().replace(/^#+/u, '').toUpperCase();
  if (/^[0-9A-F]{3}$/u.test(bare)) {
    return `#${bare.split('').map((c) => `${c}${c}`).join('')}`;
  }
  if (/^[0-9A-F]{6}$/u.test(bare)) {
    return `#${bare}`;
  }
  if (/^[0-9A-F]{8}$/u.test(bare)) {
    return `#${bare}`;
  }
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

export function normalizeStyleGuidePalettes<T extends {
  primaryColorPalette: string[];
  secondaryColorPalette: string[];
}> (styleGuide: T): T {
  return {
    ...styleGuide,
    primaryColorPalette: styleGuide.primaryColorPalette.map(toStyleGuideHex),
    secondaryColorPalette: styleGuide.secondaryColorPalette.map(toStyleGuideHex)
  };
}

export function palettesNeedHexNormalization (styleGuide: {
  primaryColorPalette: string[];
  secondaryColorPalette: string[];
}): boolean {
  const all = [ ...styleGuide.primaryColorPalette, ...styleGuide.secondaryColorPalette ];
  return all.some((hex) => !hex.trim().startsWith('#'));
}

/** Bare 6-digit uppercase hex (no `#`) for compliance comparison. */
export function normalizeHexColorBare (value: string): string {
  const bare = toStyleGuideHex(value).replace(/^#/u, '').toUpperCase();
  if (bare.length === 3) {
    return bare.split('').map((char) => `${char}${char}`).join('');
  }
  return bare.slice(0, 6);
}

export type StyleGuidePalettes = {
  primaryColorPalette: string[];
  secondaryColorPalette: string[];
};

/** Deduped `#RRGGBB` list from primary + secondary palettes. */
export function collectStyleGuideAllowedHex (styleGuide: StyleGuidePalettes): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hex of [ ...styleGuide.primaryColorPalette, ...styleGuide.secondaryColorPalette ]) {
    const normalized = `#${normalizeHexColorBare(hex)}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function styleGuideAllowedHexBareSet (styleGuide: StyleGuidePalettes): Set<string> {
  return new Set(collectStyleGuideAllowedHex(styleGuide).map((hex) => hex.replace(/^#/u, '')));
}

export function buildStyleGuideColorConstraintText (styleGuide: StyleGuidePalettes): string {
  const allowed = collectStyleGuideAllowedHex(styleGuide);
  return (
    'CSS hex colors — use ONLY these (no other #hex anywhere in styles.css/index.html/app.js):\n'
    + `${allowed.join(', ')}\n`
    + 'For darker/lighter variants: use opacity, rgba() from a palette hex, or mix two palette colors — never invent new hex codes.'
  );
}

const COLOR_COMPLIANCE_ISSUE = /colors outside style guide palettes/iu;

export type StyleGuideCodegenHints = StyleGuidePalettes & StyleGuideTypography;

/** Extra retry hint when compliance failed on off-palette hex colors or fonts. */
export function buildComplianceRetryHint (
  issues: readonly string[],
  styleGuide: StyleGuideCodegenHints
): string {
  let hint = '';
  if (issues.some((issue) => COLOR_COMPLIANCE_ISSUE.test(issue))) {
    const allowed = collectStyleGuideAllowedHex(styleGuide);
    hint += (
      ` Allowed hex colors ONLY: ${allowed.join(', ')}. `
      + 'Replace every non-allowed #hex in styles.css; use rgba() with a palette base for transparency — '
      + 'never invent new hex codes for gradients or shadows.'
    );
  }
  hint += appendFontComplianceRetryHint(issues, styleGuide);
  return hint;
}
