/**
 * Heuristics: logos/ should contain brand wordmarks only, not product packshots.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { validateLogoAssetFile } from './logo-transparency-check.mts';

/** Exactly one transparent logo (SVG or PNG/WebP with alpha) lives in logos/. */
export const CANONICAL_LOGO_COUNT = 1;

export function isOfficialLogoSvgUrl (url: string): boolean {
  return /\.svg($|[?#])/iu.test(url.trim());
}

export function officialUrlsIncludeSvg (urls: readonly string[]): boolean {
  return urls.some((u) => isOfficialLogoSvgUrl(u));
}

/** True when filename looks like a product SKU / packshot misplaced in logos/. */
export function looksLikeProductPackshotInLogosFolder (fileName: string): boolean {
  const base = fileName.replace(/\\/gu, '/').split('/').pop() ?? fileName;
  const lower = base.toLowerCase();

  if (lower.endsWith('.svg')) {
    return false;
  }

  if (/logo|wordmark|marque|brand|lockup|sigle/iu.test(lower)) {
    return false;
  }

  if (/packshot|product|prod_|_prod|catalogue|thumb|sku/iu.test(lower)) {
    return true;
  }

  // Fashion e-commerce refs: A04P501D.jpg, 5093200.jpg
  if (/^[a-z]?\d{2,}[a-z0-9]*\.(jpe?g|png|webp|gif)$/iu.test(lower)) {
    return true;
  }

  if (/^[a-z]{1,3}\d{3,}[a-z]?\d*\.(jpe?g|png|webp)$/iu.test(lower)) {
    return true;
  }

  return false;
}

function scoreCanonicalLogoFile (filePath: string): number {
  const ext = extname(filePath).toLowerCase();
  const validation = validateLogoAssetFile(filePath);
  if (!validation.ok) {
    return -10_000;
  }
  let score = 0;
  if (ext === '.svg') {
    score += 300;
  } else if (ext === '.png') {
    score += 200 + (validation.transparentRatio ?? 0) * 100;
  } else if (ext === '.webp') {
    score += 150 + (validation.transparentRatio ?? 0) * 80;
  }
  return score;
}

/** Keep the best valid logo file; remove any extras in logos/. */
export async function enforceSingleCanonicalLogo (
  directoryPath: string
): Promise<{ kept: string | null; removed: string[] }> {
  const logosDir = join(directoryPath, 'logos');
  if (!existsSync(logosDir)) {
    return { kept: null, removed: [] };
  }

  const files = readdirSync(logosDir).filter((name) => !name.startsWith('.'));
  if (files.length <= CANONICAL_LOGO_COUNT) {
    return { kept: files[0] ?? null, removed: [] };
  }

  const scored = files.map((fileName) => ({
    fileName,
    score: scoreCanonicalLogoFile(join(logosDir, fileName))
  }));
  scored.sort((a, b) => b.score - a.score);

  const kept = scored[0]?.fileName ?? null;
  const removed: string[] = [];
  for (let i = 1; i < scored.length; i += 1) {
    const entry = scored[i];
    if (entry === undefined) {
      continue;
    }
    unlinkSync(join(logosDir, entry.fileName));
    removed.push(entry.fileName);
  }
  return { kept, removed };
}
