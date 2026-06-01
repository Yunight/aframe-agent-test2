/**
 * One-shot migration: flat output/<run>/code/* → output/<run>/code/V1/*
 *
 * Usage (from repo root):
 *   node build/src/scripts/migrate-output-code-to-v1.mjs
 *   node build/src/scripts/migrate-output-code-to-v1.mjs --dry-run
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  migrateLegacyCodeBundleToV1,
  patchReviewManifestsAfterCodeV1Migration
} from '../lib/creative-code-versions.mts';
import { repoRootFromModuleDir } from '../lib/repo-paths.mts';

function resolveRepoRoot (): string {
  const candidate = repoRootFromModuleDir(import.meta.dirname);
  if (existsSync(join(candidate, 'output'))) {
    return candidate;
  }
  const parent = join(candidate, '..');
  if (existsSync(join(parent, 'output'))) {
    return parent;
  }
  return candidate;
}

const repoRoot = resolveRepoRoot();
const outputDir = join(repoRoot, 'output');
const dryRun = process.argv.includes('--dry-run');

function listOutputRunDirs (): string[] {
  if (!existsSync(outputDir)) {
    return [];
  }
  const names: string[] = [];
  for (const ent of readdirSync(outputDir, { withFileTypes: true })) {
    if (ent.isDirectory() && !ent.name.startsWith('.')) {
      names.push(ent.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function needsCodeV1Migration (runPath: string): boolean {
  const codeRoot = join(runPath, 'code');
  if (!existsSync(codeRoot)) {
    return false;
  }
  return existsSync(join(codeRoot, 'index.html'));
}

let migratedRuns = 0;
let skippedRuns = 0;
let manifestPatches = 0;

for (const folderName of listOutputRunDirs()) {
  const runPath = join(outputDir, folderName);
  if (!needsCodeV1Migration(runPath)) {
    continue;
  }

  if (dryRun) {
    console.log(`[dry-run] would migrate: ${folderName}`);
    migratedRuns += 1;
    continue;
  }

  const result = migrateLegacyCodeBundleToV1(runPath);
  if (result.migrated) {
    const patched = patchReviewManifestsAfterCodeV1Migration(runPath);
    manifestPatches += patched;
    console.log(`[ok] ${folderName}: ${result.message}${patched > 0 ? `; ${String(patched)} manifest(s) patched` : ''}`);
    migratedRuns += 1;
  } else {
    console.log(`[skip] ${folderName}: ${result.message}`);
    skippedRuns += 1;
  }
}

console.log(
  dryRun
    ? `\nDry run: ${String(migratedRuns)} folder(s) would be migrated.`
    : `\nDone: ${String(migratedRuns)} migrated, ${String(skippedRuns)} skipped, ${String(manifestPatches)} manifest(s) updated.`
);
