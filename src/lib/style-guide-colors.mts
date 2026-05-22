/** Normalize palette entries to `#RRGGBB` for style-guide.json and CSS consumers. */

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
