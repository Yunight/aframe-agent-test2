import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isAssetImageFileName } from './asset-sidecar-files.mts';
import type { AssetFile, CreativeNativeCodeFileList } from './creative-native-skills.mts';
import {
  collectLocalAssetRefsFromSource,
  normalizeLocalAssetFileName
} from './bundle-asset-refs.mts';

const GENERIC_CONFIG_FILENAME = 'generic-config.json';

const PROTECTED_BUNDLE_FILES = new Set([
  'index.html',
  'styles.css',
  'app.js',
  GENERIC_CONFIG_FILENAME
]);

const RUN_ASSET_SUBDIRS = [ 'products', 'logos' ] as const;

function normalizeComparableName (fileName: string): string {
  return fileName.replace(/\\/g, '/').toLowerCase();
}

function leafFileName (filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? normalized;
}

function codeFileContentsByLeaf (
  files: CreativeNativeCodeFileList
): { html?: string; css?: string; js?: string } {
  const out: { html?: string; css?: string; js?: string } = {};
  for (const file of files) {
    const leaf = normalizeComparableName(leafFileName(file.fileName));
    if (leaf === 'index.html') {
      out.html = file.fileContent;
    } else if (leaf === 'styles.css') {
      out.css = file.fileContent;
    } else if (leaf === 'app.js') {
      out.js = file.fileContent;
    }
  }
  return out;
}

function referencedNameMatches (fileName: string, referencedNames: Set<string>): boolean {
  const normalized = normalizeComparableName(fileName);
  for (const ref of referencedNames) {
    if (normalizeComparableName(ref) === normalized) {
      return true;
    }
  }
  return false;
}

function refsToFileNameSet (refs: string[]): Set<string> {
  const out = new Set<string>();
  for (const ref of refs) {
    out.add(normalizeLocalAssetFileName(ref));
  }
  return out;
}

function resolveAssetSourcePath (
  fileName: string,
  assetFiles: AssetFile[],
  runDirectoryPath?: string
): string | null {
  const normalized = normalizeComparableName(fileName);
  for (const assetFile of assetFiles) {
    if (normalizeComparableName(assetFile.fileName) === normalized) {
      return assetFile.filePath;
    }
  }
  if (runDirectoryPath === undefined) {
    return null;
  }
  for (const subdir of RUN_ASSET_SUBDIRS) {
    const candidate = join(runDirectoryPath, subdir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function collectReferencedAssetFileNamesFromCodeFiles (
  files: CreativeNativeCodeFileList
): Set<string> {
  return refsToFileNameSet(collectLocalAssetRefsFromSource(codeFileContentsByLeaf(files)));
}

export function collectReferencedAssetFileNamesFromBundleSource (parts: {
  html: string;
  css?: string;
  js?: string;
}): Set<string> {
  return refsToFileNameSet(collectLocalAssetRefsFromSource(parts));
}

export function copyReferencedCodegenAssets (params: {
  bundleDir: string;
  assetFiles: AssetFile[];
  referencedNames: Set<string>;
  runDirectoryPath?: string;
}): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const refName of params.referencedNames) {
    const sourcePath = resolveAssetSourcePath(refName, params.assetFiles, params.runDirectoryPath);
    if (sourcePath === null) {
      missing.push(refName);
      console.warn(`[creative-native] Referenced asset missing from bundle sources: ${refName}`);
      continue;
    }
    copyFileSync(sourcePath, join(params.bundleDir, refName));
    copied.push(refName);
  }
  return { copied, missing };
}

export function pruneUnreferencedBundleImageAssets (
  bundleDir: string,
  referencedNames: Set<string>
): string[] {
  const removed: string[] = [];
  if (!existsSync(bundleDir)) {
    return removed;
  }
  for (const fileName of readdirSync(bundleDir)) {
    if (PROTECTED_BUNDLE_FILES.has(fileName) || !isAssetImageFileName(fileName)) {
      continue;
    }
    if (referencedNameMatches(fileName, referencedNames)) {
      continue;
    }
    unlinkSync(join(bundleDir, fileName));
    console.log(`[creative-native] Pruned unused bundle asset: ${fileName}`);
    removed.push(fileName);
  }
  return removed;
}

export function syncBundleAssetsFromCodeFiles (params: {
  bundleDir: string;
  codeFiles: CreativeNativeCodeFileList;
  assetFiles: AssetFile[];
  runDirectoryPath?: string;
}): { copied: string[]; removed: string[]; missing: string[] } {
  const referencedNames = collectReferencedAssetFileNamesFromCodeFiles(params.codeFiles);
  const copyParams: Parameters<typeof copyReferencedCodegenAssets>[0] = {
    bundleDir: params.bundleDir,
    assetFiles: params.assetFiles,
    referencedNames
  };
  if (params.runDirectoryPath !== undefined) {
    copyParams.runDirectoryPath = params.runDirectoryPath;
  }
  const { copied, missing } = copyReferencedCodegenAssets(copyParams);
  const removed = pruneUnreferencedBundleImageAssets(params.bundleDir, referencedNames);
  return { copied, removed, missing };
}

export function syncBundleAssetsFromBundleSource (params: {
  bundleDir: string;
  html: string;
  css: string;
  js: string;
}): string[] {
  const referencedNames = collectReferencedAssetFileNamesFromBundleSource(params);
  return pruneUnreferencedBundleImageAssets(params.bundleDir, referencedNames);
}

/** Re-copy referenced assets from run products/logos into an existing bundle (e.g. before UI review). */
export function healBundleAssetsFromRunDirectory (params: {
  bundleDir: string;
  runDirectoryPath: string;
  assetFiles?: AssetFile[];
}): { copied: string[]; missing: string[] } {
  const indexPath = join(params.bundleDir, 'index.html');
  if (!existsSync(indexPath)) {
    return { copied: [], missing: [] };
  }
  const html = readFileSync(indexPath, { encoding: 'utf8' });
  const stylesPath = join(params.bundleDir, 'styles.css');
  const jsPath = join(params.bundleDir, 'app.js');
  const css = existsSync(stylesPath) ? readFileSync(stylesPath, { encoding: 'utf8' }) : '';
  const js = existsSync(jsPath) ? readFileSync(jsPath, { encoding: 'utf8' }) : '';
  const referencedNames = collectReferencedAssetFileNamesFromBundleSource({ html, css, js });
  return copyReferencedCodegenAssets({
    bundleDir: params.bundleDir,
    assetFiles: params.assetFiles ?? [],
    referencedNames,
    runDirectoryPath: params.runDirectoryPath
  });
}
