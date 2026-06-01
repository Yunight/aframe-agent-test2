import { z } from 'zod';

export const FONT_EFFECT_CANONICAL = [ 'bold', 'italic', 'underline', 'strikethrough' ] as const;
export type FontEffect = (typeof FONT_EFFECT_CANONICAL)[number];

const DROP = '__drop__' as const;
type FontEffectOrDrop = FontEffect | typeof DROP;

/** Maps model tokens to canonical effects; unknown / text-transform values are dropped. */
export function normalizeFontEffectToken (raw: unknown): FontEffectOrDrop {
  if (typeof raw !== 'string') {
    return DROP;
  }
  const k = raw.trim().toLowerCase();
  const aliases: Record<string, FontEffectOrDrop> = {
    bold: 'bold',
    b: 'bold',
    strong: 'bold',
    semibold: 'bold',
    italic: 'italic',
    italics: 'italic',
    oblique: 'italic',
    underline: 'underline',
    underlined: 'underline',
    strikethrough: 'strikethrough',
    'line-through': 'strikethrough',
    none: DROP,
    normal: DROP,
    regular: DROP,
    uppercase: DROP,
    lowercase: DROP,
    capitalize: DROP
  };
  return aliases[k] ?? DROP;
}

export function normalizeFontEffectArray (raw: unknown): FontEffect[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: FontEffect[] = [];
  for (const item of raw) {
    const token = normalizeFontEffectToken(item);
    if (token !== DROP) {
      out.push(token);
    }
  }
  return out;
}

/** JSON Schema–compatible (no `.transform()`); sanitizes via preprocess for zodOutputFormat. */
export const fontEffectSchema = z.preprocess(
  (raw) => normalizeFontEffectArray(raw),
  z.array(z.enum(FONT_EFFECT_CANONICAL))
).describe(
  'Font effects only: bold, italic, underline, strikethrough (lowercase). Empty array [] if none. '
  + 'Never put fontWeight, uppercase, capitalize, semibold, or normal here.'
);

export type TypographyRowLike = {
  fontFamily: string;
  fontWeight: number;
  fontEffect: unknown;
  fontUses: string;
};

export function sanitizeStyleGuideTypography<T extends { typography: TypographyRowLike[] }> (
  styleGuide: T
): T {
  return {
    ...styleGuide,
    typography: styleGuide.typography.map((row) => ({
      ...row,
      fontEffect: normalizeFontEffectArray(row.fontEffect)
    }))
  };
}

export function isStructuredOutputParseError (err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /Failed to parse structured output/iu.test(err.message);
}
