import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assetDescriptionsFileSchema,
  buildCodegenAssetPromptBlocks,
  maxProductAssetsForCodegen
} from './creative-asset-descriptions.mts';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('assetDescriptionsFileSchema parses valid file', () => {
  const parsed = assetDescriptionsFileSchema.parse({
    generated_at: '2026-01-01T00:00:00.000Z',
    model: 'claude-haiku-4-5-20251001',
    assets: [
      {
        asset_id: 'products/hero.jpg',
        fileName: 'hero.jpg',
        fileType: 'products',
        description: 'Packshot maillot rayé sur fond blanc.',
        layout_hints: [ 'hero', 'fond-clair' ],
        dominant_colors: [ '#003366', '#ffffff' ]
      }
    ]
  });
  assert.equal(parsed.assets.length, 1);
});

test('buildCodegenAssetPromptBlocks uses precomputed descriptions', async () => {
  const directoryPath = mkdtempSync(join(tmpdir(), 'codegen-assets-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  mkdirSync(join(directoryPath, 'review'), { recursive: true });

  const minimalPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  writeFileSync(join(directoryPath, 'products', 'A09O301Z1.jpg'), minimalPng);
  writeFileSync(
    join(directoryPath, 'review', 'asset-descriptions.json'),
    `${JSON.stringify({
      generated_at: '2026-01-01T00:00:00.000Z',
      model: 'claude-haiku-4-5-20251001',
      assets: [
        {
          asset_id: 'products/A09O301Z1.jpg',
          fileName: 'A09O301Z1.jpg',
          fileType: 'products',
          description: 'Packshot officiel Petit Bateau, cadrage produit centré.',
          layout_hints: [ 'hero' ],
          dominant_colors: [ '#ffffff' ]
        }
      ]
    }, null, 2)}\n`,
    'utf8'
  );

  const styleGuide: StyleGuide = {
    companyName: 'Petit Bateau',
    companyContext: 'Test',
    companyURL: 'https://www.petit-bateau.fr/',
    brandName: 'Petit Bateau',
    brandContext: 'Test',
    brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/',
    productName: "La collection d'été",
    primaryColorPalette: [ '#003366' ],
    secondaryColorPalette: [],
    typography: [
      { fontFamily: 'Arial', fontWeight: 400, fontEffect: [], fontUses: 'body' }
    ],
    brandVision: 'Test',
    brandValues: 'Test',
    logoFileUrls: [],
    productPictureUrls: [],
    logoImageSearchQueries: [],
    productImageSearchQueries: []
  };

  const prevMax = process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'];
  process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'] = '5';
  try {
    const { fileMessages, usedPrecomputedDescriptions } = await buildCodegenAssetPromptBlocks({
      directoryPath,
      styleGuide
    });
    assert.equal(usedPrecomputedDescriptions, true);
    const text = fileMessages.map((m) => m.text).join('\n');
    assert.match(text, /Packshot officiel Petit Bateau/iu);
    assert.doesNotMatch(text, /describe this specific image/iu);
    assert.equal(fileMessages.length, 1);
  } finally {
    if (prevMax === undefined) {
      delete process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'];
    } else {
      process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'] = prevMax;
    }
  }
});

test('buildCodegenAssetPromptBlocks skips logo-approved.json sidecar', async () => {
  const directoryPath = mkdtempSync(join(tmpdir(), 'codegen-sidecar-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });

  const minimalPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  writeFileSync(join(directoryPath, 'logos', 'logo-approved.json'), '{"approved_at":"x"}');
  writeFileSync(join(directoryPath, 'logos', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(directoryPath, 'products', 'hero.jpg'), minimalPng);

  const styleGuide: StyleGuide = {
    companyName: 'Brand',
    companyContext: 'Test',
    companyURL: 'https://example.com/',
    brandName: 'Brand',
    brandContext: 'Test',
    brandURL: 'https://example.com/',
    productName: 'Hero',
    primaryColorPalette: [ '#000000' ],
    secondaryColorPalette: [],
    typography: [
      { fontFamily: 'Arial', fontWeight: 400, fontEffect: [], fontUses: 'body' }
    ],
    brandVision: 'Test',
    brandValues: 'Test',
    logoFileUrls: [],
    productPictureUrls: [],
    logoImageSearchQueries: [],
    productImageSearchQueries: []
  };

  const { fileMessages, assetFiles } = await buildCodegenAssetPromptBlocks({
    directoryPath,
    styleGuide
  });
  const text = fileMessages.map((m) => m.text).join('\n');
  assert.doesNotMatch(text, /logo-approved\.json/iu);
  assert.match(text, /logo\.svg/iu);
  assert.equal(assetFiles.some((a) => a.fileName === 'logo-approved.json'), false);
});

test('maxProductAssetsForCodegen defaults to 5', () => {
  const prev = process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'];
  delete process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'];
  assert.equal(maxProductAssetsForCodegen(), 5);
  if (prev !== undefined) {
    process.env['CREATIVE_CODEGEN_MAX_PRODUCT_ASSETS'] = prev;
  }
});
