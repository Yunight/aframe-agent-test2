import { join } from 'node:path';

/** Repository root (parent of `src/`). Pass `import.meta.dirname` from any file under `src/`. */
export function repoRootFromModuleDir (moduleDirname: string): string {
  return join(moduleDirname, '..', '..');
}

/** Safe segment for `output/<name>/` (must match studio `isSafeOutputFolderSegment`). */
export function slugifyBrandForOutputDir (brandName: string): string {
  const trimmed = brandName.trim();
  if (trimmed.length === 0) {
    return 'brand';
  }
  const slug = trimmed
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'brand';
}

/** `output/<brand-slug>-<uuid>/` — easier to spot runs in the studio and on disk. */
export function buildOutputDirectoryName (brandName: string, uuid: string): string {
  return `${slugifyBrandForOutputDir(brandName)}-${uuid}`;
}
