import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogoValidationContext } from './logo-transparency-check.mts';

export type LogoSourcePhase = 'official' | 'wikipedia' | 'brave' | 'unknown';

export type LogoAssetSourceEntry = {
  fileName: string;
  sourceUrl: string;
  sourcePhase: LogoSourcePhase;
};

export type LogoAssetSourcesFile = {
  updated_at: string;
  entries: LogoAssetSourceEntry[];
};

export function logoAssetSourcesPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'logo-asset-sources.json');
}

function readSourcesFile (path: string): Map<string, LogoAssetSourceEntry> {
  const map = new Map<string, LogoAssetSourceEntry>();
  if (!existsSync(path)) {
    return map;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as LogoAssetSourcesFile;
    for (const e of raw.entries ?? []) {
      if (typeof e.fileName === 'string' && typeof e.sourceUrl === 'string') {
        const phase: LogoSourcePhase =
          e.sourcePhase === 'official' ||
          e.sourcePhase === 'wikipedia' ||
          e.sourcePhase === 'brave'
            ? e.sourcePhase
            : 'unknown';
        map.set(e.fileName, {
          fileName: e.fileName,
          sourceUrl: e.sourceUrl,
          sourcePhase: phase
        });
      }
    }
  } catch {
    /* ignore corrupt file */
  }
  return map;
}

export function loadLogoAssetSources (directoryPath: string): Map<string, LogoAssetSourceEntry> {
  return readSourcesFile(logoAssetSourcesPath(directoryPath));
}

function writeSourcesMap (directoryPath: string, map: Map<string, LogoAssetSourceEntry>): void {
  const reviewDir = join(directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  const file: LogoAssetSourcesFile = {
    updated_at: new Date().toISOString(),
    entries: [ ...map.values() ]
  };
  writeFileSync(logoAssetSourcesPath(directoryPath), `${JSON.stringify(file, null, 2)}\n`, {
    encoding: 'utf8'
  });
}

export function recordLogoAssetSource (
  directoryPath: string,
  fileName: string,
  sourceUrl: string,
  sourcePhase: LogoSourcePhase
): void {
  const map = loadLogoAssetSources(directoryPath);
  map.set(fileName, { fileName, sourceUrl, sourcePhase });
  writeSourcesMap(directoryPath, map);
}

export function removeLogoAssetSource (directoryPath: string, fileName: string): void {
  const map = loadLogoAssetSources(directoryPath);
  if (!map.delete(fileName)) {
    return;
  }
  writeSourcesMap(directoryPath, map);
}

export function clearLogoAssetSources (directoryPath: string): void {
  const path = logoAssetSourcesPath(directoryPath);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export function logoValidationContextFromEntry (
  entry: LogoAssetSourceEntry | undefined,
  officialHosts: readonly string[]
): LogoValidationContext | undefined {
  if (entry === undefined) {
    return undefined;
  }
  return {
    sourceUrl: entry.sourceUrl,
    sourcePhase: entry.sourcePhase,
    officialHosts
  };
}
