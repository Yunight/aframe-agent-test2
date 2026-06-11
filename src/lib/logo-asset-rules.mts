/**
 * Canonical logo file rules for logos/ (one file; Haiku vision audit validates identity).
 */

import { listAssetImageFiles } from './asset-sidecar-files.mts';
import { existsSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Exactly one logo file lives in logos/ until Haiku vision audit approves it. */
export const CANONICAL_LOGO_COUNT = 1;

export function isOfficialLogoSvgUrl (url: string): boolean {
  return /\.svg($|[?#])/iu.test(url.trim());
}

export function officialUrlsIncludeSvg (urls: readonly string[]): boolean {
  return urls.some((u) => isOfficialLogoSvgUrl(u));
}

function scoreCanonicalLogoFile (filePath: string): number {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.svg') {
    return 300;
  }
  if (ext === '.png') {
    return 200;
  }
  if (ext === '.webp') {
    return 150;
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    return 100;
  }
  if (ext === '.gif') {
    return 50;
  }
  return 0;
}

/** Keep the best logo file by format; remove any extras in logos/. */
export async function enforceSingleCanonicalLogo (
  directoryPath: string
): Promise<{ kept: string | null; removed: string[] }> {
  const logosDir = join(directoryPath, 'logos');
  if (!existsSync(logosDir)) {
    return { kept: null, removed: [] };
  }

  const files = listAssetImageFiles(directoryPath, 'logos');
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
