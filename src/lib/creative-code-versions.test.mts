import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  allocateNextCodeVersionDirectory,
  listCodeVersions,
  migrateLegacyCodeBundleToV1,
  resolveCodeDirectory,
  versionLabelFromNumber
} from './creative-code-versions.mts';

test('versionLabelFromNumber', () => {
  assert.equal(versionLabelFromNumber(1), 'Version 1');
  assert.equal(versionLabelFromNumber(3), 'Version 3');
});

test('listCodeVersions legacy flat code/index.html as Version 1', () => {
  const root = join(tmpdir(), `code-versions-${Date.now()}`);
  const codeRoot = join(root, 'code');
  mkdirSync(codeRoot, { recursive: true });
  writeFileSync(join(codeRoot, 'index.html'), '<title>Legacy</title>', 'utf8');
  try {
    const versions = listCodeVersions(root);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.versionId, 'V1');
    assert.equal(versions[0]!.isLegacyLayout, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrateLegacyCodeBundleToV1 moves flat code/ into code/V1/', () => {
  const root = join(tmpdir(), `code-versions-${Date.now()}-migrate`);
  const codeRoot = join(root, 'code');
  mkdirSync(codeRoot, { recursive: true });
  writeFileSync(join(codeRoot, 'index.html'), '<title>Flat</title>', 'utf8');
  writeFileSync(join(codeRoot, 'app.js'), 'console.log(1)', 'utf8');
  try {
    const result = migrateLegacyCodeBundleToV1(root);
    assert.equal(result.migrated, true);
    assert.equal(existsSync(join(codeRoot, 'index.html')), false);
    assert.equal(existsSync(join(codeRoot, 'V1', 'index.html')), true);
    assert.equal(existsSync(join(codeRoot, 'V1', 'app.js')), true);
    const versions = listCodeVersions(root);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.isLegacyLayout, false);
    assert.equal(versions[0]!.directoryPath, join(codeRoot, 'V1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('migrateLegacyCodeBundleToV1 removes duplicate root files when V1 exists', () => {
  const root = join(tmpdir(), `code-versions-${Date.now()}-dedupe`);
  const codeRoot = join(root, 'code');
  const v1Dir = join(codeRoot, 'V1');
  mkdirSync(v1Dir, { recursive: true });
  writeFileSync(join(v1Dir, 'index.html'), '<title>V1</title>', 'utf8');
  writeFileSync(join(v1Dir, 'app.js'), 'const v1 = true', 'utf8');
  writeFileSync(join(codeRoot, 'index.html'), '<title>dup</title>', 'utf8');
  writeFileSync(join(codeRoot, 'styles.css'), 'body{}', 'utf8');
  try {
    const result = migrateLegacyCodeBundleToV1(root);
    assert.equal(result.migrated, true);
    assert.equal(existsSync(join(codeRoot, 'index.html')), false);
    assert.equal(existsSync(join(codeRoot, 'styles.css')), false);
    assert.equal(existsSync(join(v1Dir, 'index.html')), true);
    assert.equal(readFileSync(join(v1Dir, 'app.js'), 'utf8'), 'const v1 = true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allocateNextCodeVersionDirectory creates V1 then V2', () => {
  const root = join(tmpdir(), `code-versions-${Date.now()}-alloc`);
  try {
    const v1 = allocateNextCodeVersionDirectory(root);
    assert.equal(v1.versionId, 'V1');
    writeFileSync(v1.indexHtmlPath, '<title>V1</title>', 'utf8');

    const v2 = allocateNextCodeVersionDirectory(root);
    assert.equal(v2.versionId, 'V2');
    writeFileSync(v2.indexHtmlPath, '<title>V2</title>', 'utf8');
    assert.equal(listCodeVersions(root).length, 2);

    assert.equal(resolveCodeDirectory(root, 'V1'), v1.directoryPath);
    assert.equal(resolveCodeDirectory(root, null), v2.directoryPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
