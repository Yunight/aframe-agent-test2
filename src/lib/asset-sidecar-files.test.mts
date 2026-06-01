import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAssetImageFileName,
  isAssetSidecarFileName,
  listAssetImageFiles
} from './asset-sidecar-files.mts';
import { logoLockExists, writeLogoLock } from './logo-lock.mts';
import {
  loadProductAssetSources,
  productAssetSourcesPath,
  recordProductAssetSource
} from './product-asset-sources.mts';

test('isAssetSidecarFileName recognizes legacy sidecar names', () => {
  assert.equal(isAssetSidecarFileName('logo-approved.json'), true);
  assert.equal(isAssetSidecarFileName('asset-sources.json'), true);
  assert.equal(isAssetSidecarFileName('logo-petit-bateau.svg'), false);
});

test('listAssetImageFiles excludes JSON sidecars in logos and products', () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-sidecar-'));
  mkdirSync(join(root, 'logos'), { recursive: true });
  mkdirSync(join(root, 'products'), { recursive: true });
  writeFileSync(join(root, 'logos', 'logo-approved.json'), '{}');
  writeFileSync(join(root, 'logos', 'brand.svg'), '<svg/>');
  writeFileSync(join(root, 'products', 'asset-sources.json'), '{}');
  writeFileSync(join(root, 'products', 'hero.jpg'), Buffer.from([ 0xff, 0xd8, 0xff ]));

  assert.deepEqual(listAssetImageFiles(root, 'logos'), [ 'brand.svg' ]);
  assert.deepEqual(listAssetImageFiles(root, 'products'), [ 'hero.jpg' ]);
});

test('writeLogoLock uses review/logo-lock.json not logos/', () => {
  const root = mkdtempSync(join(tmpdir(), 'logo-lock-'));
  mkdirSync(join(root, 'logos'), { recursive: true });
  writeFileSync(join(root, 'logos', 'logo-approved.json'), '{"legacy":true}');

  writeLogoLock(root, { approved_at: '2026-01-01T00:00:00.000Z', source: 'test' });

  assert.equal(logoLockExists(root), true);
  assert.equal(isAssetImageFileName('logo-lock.json'), false);
  assert.deepEqual(listAssetImageFiles(root, 'logos'), []);
});

test('recordProductAssetSource uses review/product-asset-sources.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'product-sources-'));
  mkdirSync(join(root, 'products'), { recursive: true });
  writeFileSync(join(root, 'products', 'asset-sources.json'), '{"updated_at":"","entries":[]}');

  recordProductAssetSource(root, 'sku.jpg', 'https://brand.example/dw/image/sku.jpg', {
    sourcePageUrl: 'https://brand.example/collection/summer',
    fromReferencePage: true
  });

  const map = loadProductAssetSources(root);
  const entry = map.get('sku.jpg');
  assert.equal(entry?.sourceUrl, 'https://brand.example/dw/image/sku.jpg');
  assert.equal(entry?.sourcePageUrl, 'https://brand.example/collection/summer');
  assert.equal(entry?.fromReferencePage, true);

  assert.ok(productAssetSourcesPath(root).includes('review'));
  assert.equal(listAssetImageFiles(root, 'products').length, 0);
});
