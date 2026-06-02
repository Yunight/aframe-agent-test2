import assert from 'node:assert/strict';
import test from 'node:test';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { runDeterministicAssetsCheck } from './creative-native-assets-deterministic.mts';
import { recordProductAssetSource } from './product-asset-sources.mts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const minimalPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const catalogStyleGuide: StyleGuide = {
  companyName: 'Petit Bateau',
  companyContext: 'Marque française',
  companyURL: 'https://www.petit-bateau.fr/',
  brandName: 'Petit Bateau',
  brandContext: 'Mode enfant',
  brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/',
  productName: "La collection d'été",
  campaignContext: 'Campagne été 2026',
  primaryColorPalette: [ '#003366' ],
  secondaryColorPalette: [ '#ffffff' ],
  typography: [
    {
      fontFamily: 'Arial',
      fontWeight: 400,
      fontEffect: [],
      fontUses: 'body'
    }
  ],
  brandVision: 'Test',
  brandValues: 'Test',
  logoFileUrls: [],
  productPictureUrls: [],
  logoImageSearchQueries: [],
  productImageSearchQueries: []
};

test('catalog campaign accepts official SKU via asset-sources sidecar', async (t) => {
  const prevMinW = process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
  const prevMinH = process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
  const prevLogoW = process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
  const prevLogoH = process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = '1';
  t.after(() => {
    if (prevMinW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = prevMinW;
    }
    if (prevMinH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = prevMinH;
    }
    if (prevLogoW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = prevLogoW;
    }
    if (prevLogoH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = prevLogoH;
    }
  });

  const directoryPath = mkdtempSync(join(tmpdir(), 'assets-det-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  writeFileSync(
    join(directoryPath, 'logos', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="30">PB</text></svg>',
    'utf8'
  );
  writeFileSync(join(directoryPath, 'products', 'A09O301Z1.jpg'), minimalPng);
  recordProductAssetSource(
    directoryPath,
    'A09O301Z1.jpg',
    'https://www.petit-bateau.fr/dw/image/v2/ABCD/on/demandware.static/-/Sites-pb-master/default/dw123/A09O301Z1.jpg?sw=800'
  );
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(catalogStyleGuide, null, 2)}\n`,
    'utf8'
  );

  const result = await runDeterministicAssetsCheck(directoryPath, catalogStyleGuide);
  const contextBlockers = result.findings.filter((f) => f.severity === 'blocker');
  assert.equal(contextBlockers.length, 0, `unexpected blockers: ${JSON.stringify(contextBlockers)}`);
});

test('promotions catalog accepts Lidl WON_* assets with official sidecar URL', async (t) => {
  const prevMinW = process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
  const prevMinH = process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
  const prevLogoW = process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
  const prevLogoH = process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = '1';
  t.after(() => {
    if (prevMinW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = prevMinW;
    }
    if (prevMinH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = prevMinH;
    }
    if (prevLogoW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = prevLogoW;
    }
    if (prevLogoH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = prevLogoH;
    }
  });

  const lidlGuide: StyleGuide = {
    ...catalogStyleGuide,
    companyName: 'Lidl France',
    brandName: 'Lidl France',
    brandURL: 'https://www.lidl.fr/q/query/promotions',
    campaignReferenceUrl: 'https://www.lidl.fr/q/query/promotions',
    productName: 'Promotions Lidl (mise en avant des produits en promotion)',
    campaignContext: 'mise en avant des produits en promotions'
  };

  const directoryPath = mkdtempSync(join(tmpdir(), 'assets-det-lidl-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  writeFileSync(
    join(directoryPath, 'logos', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="30">L</text></svg>',
    'utf8'
  );
  writeFileSync(join(directoryPath, 'products', 'WON_FL-2239964.jpg'), minimalPng);
  recordProductAssetSource(
    directoryPath,
    'WON_FL-2239964.jpg',
    'https://www.lidl.fr/static/assets/WON_FL-2239964.jpg',
    {
      sourcePageUrl: 'https://www.lidl.fr/q/query/promotions',
      fromReferencePage: true
    }
  );
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(lidlGuide, null, 2)}\n`,
    'utf8'
  );

  const result = await runDeterministicAssetsCheck(directoryPath, lidlGuide);
  const contextBlockers = result.findings.filter((f) => f.severity === 'blocker');
  assert.equal(contextBlockers.length, 0, `unexpected blockers: ${JSON.stringify(contextBlockers)}`);
});

test('listing accepts random local file name when reference provenance is recorded', async (t) => {
  const prevMinW = process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
  const prevMinH = process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
  const prevLogoW = process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
  const prevLogoH = process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = '1';
  t.after(() => {
    if (prevMinW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = prevMinW;
    }
    if (prevMinH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = prevMinH;
    }
    if (prevLogoW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = prevLogoW;
    }
    if (prevLogoH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = prevLogoH;
    }
  });

  const guide: StyleGuide = {
    ...catalogStyleGuide,
    brandURL: 'https://shop.example.com/promo',
    campaignReferenceUrl: 'https://shop.example.com/promo',
    productName: 'Weekly promo',
    campaignContext: 'Weekly promo'
  };

  const directoryPath = mkdtempSync(join(tmpdir(), 'assets-det-rand-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  writeFileSync(
    join(directoryPath, 'logos', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="30">E</text></svg>',
    'utf8'
  );
  writeFileSync(join(directoryPath, 'products', 'x7f2.jpg'), minimalPng);
  recordProductAssetSource(directoryPath, 'x7f2.jpg', 'https://shop.example.com/static/x7f2.jpg', {
    sourcePageUrl: 'https://shop.example.com/promo',
    fromReferencePage: true
  });
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(guide, null, 2)}\n`,
    'utf8'
  );

  const result = await runDeterministicAssetsCheck(directoryPath, guide);
  const blockers = result.findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('single SKU accepts mismatched file name when sourceUrl matches product', async (t) => {
  const prevMinW = process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
  const prevMinH = process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
  const prevLogoW = process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
  const prevLogoH = process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = '1';
  t.after(() => {
    if (prevMinW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = prevMinW;
    }
    if (prevMinH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = prevMinH;
    }
    if (prevLogoW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = prevLogoW;
    }
    if (prevLogoH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = prevLogoH;
    }
  });

  const skuGuide: StyleGuide = {
    ...catalogStyleGuide,
    productName: '208 GTI',
    campaignContext: '208 GTI launch',
    brandName: 'Peugeot',
    brandURL: 'https://www.peugeot.fr/modeles/208-gti'
  };

  const directoryPath = mkdtempSync(join(tmpdir(), 'assets-det-sku-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  writeFileSync(
    join(directoryPath, 'logos', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="30">P</text></svg>',
    'utf8'
  );
  writeFileSync(join(directoryPath, 'products', 'random-hash.jpg'), minimalPng);
  recordProductAssetSource(
    directoryPath,
    'random-hash.jpg',
    'https://www.peugeot.fr/modeles/208-gti/hero-packshot.jpg'
  );
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(skuGuide, null, 2)}\n`,
    'utf8'
  );

  const result = await runDeterministicAssetsCheck(directoryPath, skuGuide);
  const blockers = result.findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('decathlon listing blocks non-official media hosts', async (t) => {
  const prevMinW = process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
  const prevMinH = process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
  const prevLogoW = process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
  const prevLogoH = process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = '1';
  process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = '1';
  t.after(() => {
    if (prevMinW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_W'] = prevMinW;
    }
    if (prevMinH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_PRODUCT_H'] = prevMinH;
    }
    if (prevLogoW === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_W'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_W'] = prevLogoW;
    }
    if (prevLogoH === undefined) {
      delete process.env['CREATIVE_ASSETS_MIN_LOGO_H'];
    } else {
      process.env['CREATIVE_ASSETS_MIN_LOGO_H'] = prevLogoH;
    }
  });

  const guide: StyleGuide = {
    ...catalogStyleGuide,
    brandName: 'Decathlon',
    companyName: 'Decathlon S.A.',
    companyURL: 'https://www.decathlon.com',
    brandURL: 'https://www.decathlon.com',
    campaignReferenceUrl: 'https://www.decathlon.com',
    productName: "Bons plans été 2026 — Indispensables de l'été",
    campaignContext: "Promotions des produits adaptés pour l'été 2026"
  };

  const directoryPath = mkdtempSync(join(tmpdir(), 'assets-det-decathlon-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  writeFileSync(
    join(directoryPath, 'logos', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text y="30">D</text></svg>',
    'utf8'
  );
  writeFileSync(join(directoryPath, 'products', 'third-party.jpg'), minimalPng);
  recordProductAssetSource(
    directoryPath,
    'third-party.jpg',
    'https://media.ouest-france.fr/v1/pictures/random?width=1260'
  );
  writeFileSync(
    join(directoryPath, 'style-guide.json'),
    `${JSON.stringify(guide, null, 2)}\n`,
    'utf8'
  );

  const result = await runDeterministicAssetsCheck(directoryPath, guide);
  const productBlockers = result.findings.filter(
    (f) => f.severity === 'blocker' && f.asset_id.startsWith('products/')
  );
  assert.equal(productBlockers.length, 1, JSON.stringify(productBlockers));
  assert.match(
    productBlockers[0]?.issue ?? '',
    /official brand visual host/iu
  );
});
