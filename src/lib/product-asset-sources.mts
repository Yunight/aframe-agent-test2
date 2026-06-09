import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PRODUCT_SOURCES_FILE_NAME } from './asset-sidecar-files.mts';

export type ProductAssetSourceEntry = {
  fileName: string;
  sourceUrl: string;
  sourcePageUrl?: string;
  fromReferencePage?: boolean;
  /** Brave/search result title — used for entertainment poster relevance when URL is opaque. */
  sourceTitle?: string;
};

export type ProductAssetSourceProvenance = {
  sourcePageUrl?: string;
  fromReferencePage?: boolean;
  sourceTitle?: string;
};

export type ProductAssetSourcesFile = {
  updated_at: string;
  entries: ProductAssetSourceEntry[];
};

export function productAssetSourcesPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'product-asset-sources.json');
}

function legacyProductAssetSourcesPath (directoryPath: string): string {
  return join(directoryPath, 'products', LEGACY_PRODUCT_SOURCES_FILE_NAME);
}

function readSourcesFile (path: string): Map<string, ProductAssetSourceEntry> {
  const map = new Map<string, ProductAssetSourceEntry>();
  if (!existsSync(path)) {
    return map;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ProductAssetSourcesFile;
    for (const e of raw.entries ?? []) {
      if (typeof e.fileName === 'string' && typeof e.sourceUrl === 'string') {
        map.set(e.fileName, {
          fileName: e.fileName,
          sourceUrl: e.sourceUrl,
          ...(typeof e.sourcePageUrl === 'string' && e.sourcePageUrl.length > 0
            ? { sourcePageUrl: e.sourcePageUrl }
            : {}),
          ...(e.fromReferencePage === true ? { fromReferencePage: true } : {}),
          ...(typeof e.sourceTitle === 'string' && e.sourceTitle.length > 0
            ? { sourceTitle: e.sourceTitle }
            : {})
        });
      }
    }
  } catch {
    /* ignore corrupt file */
  }
  return map;
}

export function loadProductAssetSources (directoryPath: string): Map<string, ProductAssetSourceEntry> {
  const primaryPath = productAssetSourcesPath(directoryPath);
  if (existsSync(primaryPath)) {
    return readSourcesFile(primaryPath);
  }
  const legacyPath = legacyProductAssetSourcesPath(directoryPath);
  if (existsSync(legacyPath)) {
    return readSourcesFile(legacyPath);
  }
  return new Map();
}

function writeSourcesMap (directoryPath: string, map: Map<string, ProductAssetSourceEntry>): void {
  const reviewDir = join(directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const file: ProductAssetSourcesFile = {
    updated_at: new Date().toISOString(),
    entries: [ ...map.values() ]
  };
  writeFileSync(productAssetSourcesPath(directoryPath), `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8'
  });
  const legacy = legacyProductAssetSourcesPath(directoryPath);
  if (existsSync(legacy)) {
    unlinkSync(legacy);
  }
}

export function recordProductAssetSource (
  directoryPath: string,
  fileName: string,
  sourceUrl: string,
  provenance?: ProductAssetSourceProvenance
): void {
  const map = loadProductAssetSources(directoryPath);
  const prev = map.get(fileName);
  map.set(fileName, {
    fileName,
    sourceUrl,
    ...(provenance?.sourcePageUrl !== undefined && provenance.sourcePageUrl.length > 0
      ? { sourcePageUrl: provenance.sourcePageUrl }
      : prev?.sourcePageUrl !== undefined
        ? { sourcePageUrl: prev.sourcePageUrl }
        : {}),
    ...(provenance?.fromReferencePage === true
      ? { fromReferencePage: true }
      : prev?.fromReferencePage === true
        ? { fromReferencePage: true }
        : {}),
    ...(provenance?.sourceTitle !== undefined && provenance.sourceTitle.length > 0
      ? { sourceTitle: provenance.sourceTitle }
      : prev?.sourceTitle !== undefined
        ? { sourceTitle: prev.sourceTitle }
        : {})
  });
  writeSourcesMap(directoryPath, map);
}

export function clearProductAssetSources (directoryPath: string): void {
  writeSourcesMap(directoryPath, new Map());
}

export function removeProductAssetSource (directoryPath: string, fileName: string): void {
  const map = loadProductAssetSources(directoryPath);
  if (!map.delete(fileName)) {
    return;
  }
  writeSourcesMap(directoryPath, map);
}
