import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectLocalAssetRefsFromSource } from './bundle-asset-refs.mts';
import {
  collectReferencedAssetFileNamesFromBundleSource,
  collectReferencedAssetFileNamesFromCodeFiles,
  copyReferencedCodegenAssets,
  healBundleAssetsFromRunDirectory,
  pruneUnreferencedBundleImageAssets,
  syncBundleAssetsFromBundleSource
} from './creative-bundle-assets.mts';
import type { AssetFile } from './creative-native-skills.mts';

const KUSMI_LIKE_HTML = `<!DOCTYPE html><html><body><div id="ad-300x250">
  <img src="./Kusmi_Tea_logo.png" alt="Kusmi Tea" class="logo">
  <img src="./KITBBTEAPECHEPASSION-10FR_packshot.png" alt="Kit" class="product-img">
</div></body></html>`;

const WALIBI_LIKE_HTML = `<!DOCTYPE html><html><body><div id="ad-320x480">
  <div class="bg-slides">
    <div class="slide slide-1" style="background-image:url('./04-parcnov2021.jpg')"></div>
    <div class="slide slide-2" style="background-image:url('./07-parcnov2021.jpg')"></div>
  </div>
  <img src="./walibi-shooting-pub-2025---0031.jpg" alt="hero">
</div></body></html>`;

test('collectLocalAssetRefsFromSource parses inline background-image urls', () => {
  const refs = collectLocalAssetRefsFromSource({ html: WALIBI_LIKE_HTML });
  assert.ok(refs.some((r) => r.includes('04-parcnov2021.jpg')));
  assert.ok(refs.some((r) => r.includes('07-parcnov2021.jpg')));
  assert.ok(refs.some((r) => r.includes('walibi-shooting-pub-2025---0031.jpg')));
});

test('collectReferencedAssetFileNamesFromCodeFiles kusmi-like html', () => {
  const names = collectReferencedAssetFileNamesFromCodeFiles([
    { fileName: 'index.html', fileContent: KUSMI_LIKE_HTML },
    { fileName: 'styles.css', fileContent: '#ad-300x250{width:300px;height:250px}' },
    { fileName: 'app.js', fileContent: 'const ad = document.getElementById("ad-300x250");' }
  ]);
  assert.equal(names.size, 2);
  assert.ok(names.has('Kusmi_Tea_logo.png'));
  assert.ok(names.has('KITBBTEAPECHEPASSION-10FR_packshot.png'));
});

test('collectReferencedAssetFileNamesFromBundleSource walibi-like html', () => {
  const names = collectReferencedAssetFileNamesFromBundleSource({ html: WALIBI_LIKE_HTML });
  assert.equal(names.size, 3);
  assert.ok(names.has('04-parcnov2021.jpg'));
  assert.ok(names.has('07-parcnov2021.jpg'));
  assert.ok(names.has('walibi-shooting-pub-2025---0031.jpg'));
});

test('copyReferencedCodegenAssets copies only referenced files', () => {
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-copy-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'bundle-src-'));
  try {
    const makeSrc = (name: string): string => {
      const path = join(srcDir, name);
      writeFileSync(path, 'x');
      return path;
    };
    const assetFiles: AssetFile[] = [
      { fileName: 'logo.png', filePath: makeSrc('logo.png'), fileType: 'logos' },
      { fileName: 'hero.jpg', filePath: makeSrc('hero.jpg'), fileType: 'products' },
      { fileName: 'extra.jpg', filePath: makeSrc('extra.jpg'), fileType: 'products' }
    ];
    const referenced = new Set([ 'logo.png', 'hero.jpg' ]);
    const { copied, missing } = copyReferencedCodegenAssets({ bundleDir, assetFiles, referencedNames: referenced });
    assert.deepEqual(copied.sort(), [ 'hero.jpg', 'logo.png' ]);
    assert.deepEqual(missing, []);
    assert.ok(existsSync(join(bundleDir, 'logo.png')));
    assert.ok(existsSync(join(bundleDir, 'hero.jpg')));
    assert.equal(existsSync(join(bundleDir, 'extra.jpg')), false);
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
});

test('copyReferencedCodegenAssets resolves from run products/ when not in assetFiles', () => {
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-run-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-dir-'));
  try {
    mkdirSync(join(runDir, 'products'), { recursive: true });
    writeFileSync(join(runDir, 'products', 'slide-a.jpg'), 'a');
    writeFileSync(join(runDir, 'products', 'slide-b.jpg'), 'b', { flag: 'w' });
    const { copied, missing } = copyReferencedCodegenAssets({
      bundleDir,
      assetFiles: [],
      referencedNames: new Set([ 'slide-a.jpg', 'slide-b.jpg', 'missing.jpg' ]),
      runDirectoryPath: runDir
    });
    assert.deepEqual(copied.sort(), [ 'slide-a.jpg', 'slide-b.jpg' ]);
    assert.deepEqual(missing, [ 'missing.jpg' ]);
    assert.ok(existsSync(join(bundleDir, 'slide-a.jpg')));
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('healBundleAssetsFromRunDirectory copies background-image refs', () => {
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-heal-'));
  const runDir = mkdtempSync(join(tmpdir(), 'run-heal-'));
  try {
    mkdirSync(join(runDir, 'products'), { recursive: true });
    writeFileSync(join(runDir, 'products', '04-parcnov2021.jpg'), 'img');
    writeFileSync(join(bundleDir, 'index.html'), WALIBI_LIKE_HTML);
    writeFileSync(join(bundleDir, 'styles.css'), '');
    writeFileSync(join(bundleDir, 'app.js'), '');
    const { copied } = healBundleAssetsFromRunDirectory({ bundleDir, runDirectoryPath: runDir });
    assert.ok(copied.includes('04-parcnov2021.jpg'));
    assert.ok(existsSync(join(bundleDir, '04-parcnov2021.jpg')));
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('pruneUnreferencedBundleImageAssets removes orphan images only', () => {
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-prune-'));
  try {
    writeFileSync(join(bundleDir, 'index.html'), '<html></html>');
    writeFileSync(join(bundleDir, 'styles.css'), 'body{}');
    writeFileSync(join(bundleDir, 'app.js'), '');
    writeFileSync(join(bundleDir, 'logo.png'), 'x');
    writeFileSync(join(bundleDir, 'hero.jpg'), 'x');
    writeFileSync(join(bundleDir, 'unused.png'), 'x');
    writeFileSync(join(bundleDir, 'notes.txt'), 'keep');

    const removed = pruneUnreferencedBundleImageAssets(
      bundleDir,
      new Set([ 'logo.png', 'hero.jpg' ])
    );
    assert.deepEqual(removed, [ 'unused.png' ]);
    assert.ok(existsSync(join(bundleDir, 'logo.png')));
    assert.ok(existsSync(join(bundleDir, 'hero.jpg')));
    assert.equal(existsSync(join(bundleDir, 'unused.png')), false);
    assert.ok(existsSync(join(bundleDir, 'notes.txt')));
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test('syncBundleAssetsFromBundleSource kusmi V5 keeps only referenced images', () => {
  const runDir = join(
    import.meta.dirname,
    '..',
    '..',
    'output',
    'kusmi-tea-ef487823-9c9e-4a4d-b3b9-6c39c80c9717'
  );
  const bundleDir = join(runDir, 'code', 'V5');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const bundleCopy = mkdtempSync(join(tmpdir(), 'kusmi-v5-bundle-'));
  try {
    for (const name of readdirSync(bundleDir)) {
      copyFileSync(join(bundleDir, name), join(bundleCopy, name));
    }
    const html = KUSMI_LIKE_HTML;
    syncBundleAssetsFromBundleSource({
      bundleDir: bundleCopy,
      html,
      css: '#ad-300x250{width:300px;height:250px}',
      js: ''
    });
    const imageFiles = readdirSync(bundleCopy).filter((n) => /\.(png|jpe?g|webp|gif|svg)$/iu.test(n));
    assert.deepEqual(imageFiles.sort(), [
      'KITBBTEAPECHEPASSION-10FR_packshot.png',
      'Kusmi_Tea_logo.png'
    ]);
    const referenced = collectReferencedAssetFileNamesFromBundleSource({
      html,
      css: '',
      js: ''
    });
    assert.equal(referenced.size, 2);
  } finally {
    rmSync(bundleCopy, { recursive: true, force: true });
  }
});
