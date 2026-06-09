import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_LOGO_LOCK_FILE_NAME } from './asset-sidecar-files.mts';

export type LogoLockFile = {
  approved_at: string;
  source: string;
};

export function logoLockPath (directoryPath: string): string {
  return join(directoryPath, 'review', 'logo-lock.json');
}

export function legacyLogoLockPath (directoryPath: string): string {
  return join(directoryPath, 'logos', LEGACY_LOGO_LOCK_FILE_NAME);
}

export function logoLockExists (directoryPath: string): boolean {
  return existsSync(logoLockPath(directoryPath)) || existsSync(legacyLogoLockPath(directoryPath));
}

export function loadLogoLock (directoryPath: string): LogoLockFile | null {
  const candidates = [ logoLockPath(directoryPath), legacyLogoLockPath(directoryPath) ];
  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as LogoLockFile;
    } catch {
      return null;
    }
  }
  return null;
}

export function writeLogoLock (
  directoryPath: string,
  payload: LogoLockFile
): void {
  const reviewDir = join(directoryPath, 'review');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(logoLockPath(directoryPath), `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8'
  });
  const legacy = legacyLogoLockPath(directoryPath);
  if (existsSync(legacy)) {
    unlinkSync(legacy);
  }
}

export function clearLogoLock (directoryPath: string): void {
  const path = logoLockPath(directoryPath);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  const legacy = legacyLogoLockPath(directoryPath);
  if (existsSync(legacy)) {
    unlinkSync(legacy);
  }
}
