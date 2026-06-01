import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { join, sep } from 'node:path';

const VERSION_DIR_RE = /^V(\d+)$/iu;

export type CodeVersionInfo = {
  versionId: string;
  versionNumber: number;
  versionLabel: string;
  directoryPath: string;
  indexHtmlPath: string;
  mtimeMs: number;
  /** True when bundle lives at `code/index.html` (pre-versioning layout). */
  isLegacyLayout: boolean;
};

export function versionLabelFromNumber (n: number): string {
  return `Version ${String(n)}`;
}

export function parseVersionDirName (name: string): number | null {
  const m = VERSION_DIR_RE.exec(name);
  if (m === null || m[1] === undefined) {
    return null;
  }
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readActiveVersionId (codeRoot: string): string | null {
  const activePath = join(codeRoot, 'active-version.json');
  if (!existsSync(activePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(activePath, 'utf8')) as { activeVersion?: unknown };
    return typeof parsed.activeVersion === 'string' && parsed.activeVersion.trim().length > 0
      ? parsed.activeVersion.trim()
      : null;
  } catch {
    return null;
  }
}

export function writeActiveVersionId (outputRunPath: string, versionId: string): void {
  const codeRoot = join(outputRunPath, 'code');
  mkdirSync(codeRoot, { recursive: true });
  writeFileSync(
    join(codeRoot, 'active-version.json'),
    `${JSON.stringify({ activeVersion: versionId }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
}

/** All creative bundles under `output/<run>/code/` (Vn subdirs + optional legacy flat layout). */
export function listCodeVersions (outputRunPath: string): CodeVersionInfo[] {
  const codeRoot = join(outputRunPath, 'code');
  if (!existsSync(codeRoot) || !statSync(codeRoot).isDirectory()) {
    return [];
  }

  const versions: CodeVersionInfo[] = [];

  for (const ent of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      continue;
    }
    const versionNumber = parseVersionDirName(ent.name);
    if (versionNumber === null) {
      continue;
    }
    const directoryPath = join(codeRoot, ent.name);
    const indexHtmlPath = join(directoryPath, 'index.html');
    if (!existsSync(indexHtmlPath)) {
      continue;
    }
    versions.push({
      versionId: ent.name,
      versionNumber,
      versionLabel: versionLabelFromNumber(versionNumber),
      directoryPath,
      indexHtmlPath,
      mtimeMs: statSync(indexHtmlPath).mtimeMs,
      isLegacyLayout: false
    });
  }

  const legacyIndex = join(codeRoot, 'index.html');
  const hasV1Dir = versions.some((v) => v.versionNumber === 1);
  if (existsSync(legacyIndex) && !hasV1Dir) {
    versions.push({
      versionId: 'V1',
      versionNumber: 1,
      versionLabel: versionLabelFromNumber(1),
      directoryPath: codeRoot,
      indexHtmlPath: legacyIndex,
      mtimeMs: statSync(legacyIndex).mtimeMs,
      isLegacyLayout: true
    });
  }

  versions.sort((a, b) => a.versionNumber - b.versionNumber);
  return versions;
}

export function latestCodeVersion (outputRunPath: string): CodeVersionInfo | null {
  const versions = listCodeVersions(outputRunPath);
  if (versions.length === 0) {
    return null;
  }
  const activeId = readActiveVersionId(join(outputRunPath, 'code'));
  if (activeId !== null) {
    const active = versions.find((v) => v.versionId.toLowerCase() === activeId.toLowerCase());
    if (active !== undefined) {
      return active;
    }
  }
  return versions[versions.length - 1] ?? null;
}

export function resolveCodeDirectory (
  outputRunPath: string,
  versionId?: string | null
): string | null {
  const versions = listCodeVersions(outputRunPath);
  if (versions.length === 0) {
    return null;
  }
  const trimmed = versionId?.trim() ?? '';
  if (trimmed.length > 0) {
    const match = versions.find((v) => v.versionId.toLowerCase() === trimmed.toLowerCase());
    return match?.directoryPath ?? null;
  }
  return latestCodeVersion(outputRunPath)?.directoryPath ?? null;
}

function maxAllocatedVersionNumber (outputRunPath: string): number {
  const codeRoot = join(outputRunPath, 'code');
  let max = 0;
  for (const v of listCodeVersions(outputRunPath)) {
    max = Math.max(max, v.versionNumber);
  }
  if (!existsSync(codeRoot) || !statSync(codeRoot).isDirectory()) {
    return max;
  }
  for (const ent of readdirSync(codeRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) {
      continue;
    }
    const n = parseVersionDirName(ent.name);
    if (n !== null) {
      max = Math.max(max, n);
    }
  }
  return max;
}

/** Creates `code/V{n}/` and sets it as the active version. */
export function allocateNextCodeVersionDirectory (outputRunPath: string): CodeVersionInfo {
  const nextNumber = maxAllocatedVersionNumber(outputRunPath) + 1;
  const versionId = `V${String(nextNumber)}`;
  const directoryPath = join(outputRunPath, 'code', versionId);
  mkdirSync(directoryPath, { recursive: true });
  writeActiveVersionId(outputRunPath, versionId);

  const indexHtmlPath = join(directoryPath, 'index.html');
  return {
    versionId,
    versionNumber: nextNumber,
    versionLabel: versionLabelFromNumber(nextNumber),
    directoryPath,
    indexHtmlPath,
    mtimeMs: Date.now(),
    isLegacyLayout: false
  };
}

export function codeVersionCount (outputRunPath: string): number {
  return listCodeVersions(outputRunPath).length;
}

export type MigrateLegacyCodeResult = {
  migrated: boolean;
  message: string;
};

const ACTIVE_VERSION_FILE = 'active-version.json';

function isReservedCodeRootEntry (name: string): boolean {
  if (name === ACTIVE_VERSION_FILE) {
    return true;
  }
  return parseVersionDirName(name) !== null;
}

/** Moves flat `code/*` into `code/V1/`; cleans duplicate root files when V1 already exists. */
export function migrateLegacyCodeBundleToV1 (outputRunPath: string): MigrateLegacyCodeResult {
  const codeRoot = join(outputRunPath, 'code');
  if (!existsSync(codeRoot) || !statSync(codeRoot).isDirectory()) {
    return { migrated: false, message: 'no code/ directory' };
  }

  const legacyIndex = join(codeRoot, 'index.html');
  const v1Dir = join(codeRoot, 'V1');
  const v1Index = join(v1Dir, 'index.html');
  const hasLegacy = existsSync(legacyIndex);
  const hasV1 = existsSync(v1Index);

  if (!hasLegacy && hasV1) {
    return { migrated: false, message: 'already in code/V1/' };
  }
  if (!hasLegacy && !hasV1) {
    return { migrated: false, message: 'no creative bundle (no index.html)' };
  }

  mkdirSync(v1Dir, { recursive: true });

  let changedCount = 0;
  for (const ent of readdirSync(codeRoot, { withFileTypes: true })) {
    if (isReservedCodeRootEntry(ent.name)) {
      continue;
    }
    const fromPath = join(codeRoot, ent.name);
    const toPath = join(v1Dir, ent.name);
    if (existsSync(toPath)) {
      rmSync(fromPath, { recursive: true, force: true });
      changedCount += 1;
      continue;
    }
    renameSync(fromPath, toPath);
    changedCount += 1;
  }

  if (!existsSync(v1Index)) {
    return { migrated: false, message: 'aborted: code/V1/index.html missing after migration' };
  }

  writeActiveVersionId(outputRunPath, 'V1');
  const verb = hasV1 ? 'cleaned' : 'moved';
  return {
    migrated: true,
    message: `${verb} ${String(changedCount)} item(s) into code/V1/`
  };
}

/** Updates review screenshot manifests that still point at flat `code/index.html`. */
export function patchReviewManifestsAfterCodeV1Migration (outputRunPath: string): number {
  const reviewRoot = join(outputRunPath, 'review');
  if (!existsSync(reviewRoot)) {
    return 0;
  }

  const legacyNeedle = `code${sep}index.html`;
  const versionedNeedle = `code${sep}V1${sep}index.html`;
  let patched = 0;

  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (ent.name !== 'manifest.json') {
        continue;
      }
      const raw = readFileSync(abs, 'utf8');
      if (!raw.includes('code/index.html') && !raw.includes(legacyNeedle)) {
        continue;
      }
      const updated = raw
        .replaceAll('code/index.html', 'code/V1/index.html')
        .replaceAll(legacyNeedle, versionedNeedle);
      if (updated !== raw) {
        writeFileSync(abs, updated, { encoding: 'utf8' });
        patched += 1;
      }
    }
  };

  walk(reviewRoot);
  return patched;
}
