import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Legacy sidecar names that may still exist under logos/ or products/ from older runs. */
export const LEGACY_LOGO_LOCK_FILE_NAME = 'logo-approved.json';
export const LEGACY_PRODUCT_SOURCES_FILE_NAME = 'asset-sources.json';

const ASSET_SIDECAR_FILE_NAMES = new Set([
  LEGACY_LOGO_LOCK_FILE_NAME,
  LEGACY_PRODUCT_SOURCES_FILE_NAME
]);

export function isAssetSidecarFileName (fileName: string): boolean {
  return ASSET_SIDECAR_FILE_NAMES.has(fileName);
}

/** True when the file name looks like a raster/vector image asset (not JSON sidecars). */
export function isAssetImageFileName (fileName: string): boolean {
  if (fileName.startsWith('.') || isAssetSidecarFileName(fileName)) {
    return false;
  }
  return /\.(svg|jpe?g|png|webp|gif|avif)$/iu.test(fileName);
}

export function filterAssetImageFileNames (fileNames: readonly string[]): string[] {
  return fileNames.filter((name) => isAssetImageFileName(name));
}

export function listAssetImageFiles (
  directoryPath: string,
  fileType: 'logos' | 'products'
): string[] {
  const subdirectoryPath = join(directoryPath, fileType);
  if (!existsSync(subdirectoryPath)) {
    return [];
  }
  return filterAssetImageFileNames(readdirSync(subdirectoryPath));
}
