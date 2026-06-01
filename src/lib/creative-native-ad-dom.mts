import type { AdFormatSelection } from './studio-ad-formats.mts';

/** DOM id used by Playwright capture and UI review (must match screenshot selectors). */
export function formatIdToAdDomId (formatId: string): string {
  return `ad-${formatId.replace(/×/g, 'x')}`;
}

export function requiredAdDomIds (formats: readonly AdFormatSelection[]): string[] {
  return formats.map((f) => formatIdToAdDomId(f.id));
}

export function htmlContainsAdDomId (html: string, domId: string): boolean {
  const re = new RegExp(`\\bid=["']${domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'iu');
  return re.test(html);
}

/**
 * Ensures each format has a visible root with id="ad-{formatId}" for Playwright.
 * Adds id to the first `.ad-frame` or dimension-matching wrapper when missing.
 */
export function ensureAdFormatDomIdsInHtml (
  html: string,
  formats: readonly AdFormatSelection[]
): { html: string; fixedFormatIds: string[] } {
  let out = html;
  const fixedFormatIds: string[] = [];

  for (const format of formats) {
    const domId = formatIdToAdDomId(format.id);
    if (htmlContainsAdDomId(out, domId)) {
      continue;
    }

    const adFrameRe =
      /(<(?:div|section|article)\b[^>]*\bclass=["'][^"']*\bad-frame\b[^"']*["'][^>]*)(>)/iu;
    if (adFrameRe.test(out)) {
      out = out.replace(adFrameRe, (match, openTag: string, close: string) => {
        if (/\bid\s*=/iu.test(openTag)) {
          return match.replace(/\bid\s*=\s*["'][^"']*["']/iu, `id="${domId}"`);
        }
        return `${openTag} id="${domId}"${close}`;
      });
      fixedFormatIds.push(format.id);
      continue;
    }

    const wrapperRe = new RegExp(
      `(<(?:div|section|article)\\b[^>]*\\bclass=["'][^"']*\\bad-wrapper\\b[^"']*["'][^>]*)(>)`,
      'iu'
    );
    if (wrapperRe.test(out)) {
      out = out.replace(wrapperRe, (match, openTag: string, close: string) => {
        if (/\bid\s*=/iu.test(openTag)) {
          return match.replace(/\bid\s*=\s*["'][^"']*["']/iu, `id="${domId}"`);
        }
        return `${openTag} id="${domId}"${close}`;
      });
      fixedFormatIds.push(format.id);
    }
  }

  return { html: out, fixedFormatIds };
}

export function appendAdFormatDimensionRules (
  css: string,
  formats: readonly AdFormatSelection[]
): { css: string; appended: boolean } {
  const missing: string[] = [];
  for (const format of formats) {
    const domId = formatIdToAdDomId(format.id);
    const selectorRe = new RegExp(`#${domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'u');
    if (!selectorRe.test(css)) {
      missing.push(
        `#${domId} {\n  width: ${String(format.width)}px;\n  height: ${String(format.height)}px;\n  position: relative;\n  overflow: hidden;\n}\n`
      );
    }
  }
  if (missing.length === 0) {
    return { css, appended: false };
  }
  return {
    css: `${css.trimEnd()}\n\n/* Playwright / IAB capture hooks */\n${missing.join('\n')}`,
    appended: true
  };
}
