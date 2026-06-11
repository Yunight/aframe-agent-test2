import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditDistinctProducts,
  buildRetailCampaignRelevanceTerms,
  deterministicFindingsFromAssetDescriptions,
  deterministicFindingsFromEntertainmentDescriptions,
  deterministicFindingsFromExperienceDescriptions,
  deterministicFindingsFromRetailDescriptions,
  maxValidProductAssets,
  minPhysicalProductAssets,
  minValidProductAssets,
  normalizeProductName,
  pruneExcessProductAssets
} from './asset-descriptions-audit.mts';
import type { AssetDescriptionsFile } from './creative-asset-descriptions.mts';
import { pruneVisionBlockedProducts } from './creative-native-assets-deterministic.mts';
import { recordProductAssetSource } from './product-asset-sources.mts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const kusmiMenuTile: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [
    {
      asset_id: 'products/MENU_vp_access_fr_ete_26.jpg',
      fileName: 'MENU_vp_access_fr_ete_26.jpg',
      fileType: 'products',
      description:
        'Bannière promotionnelle avec fond dégradé orange et texte « VENTE PRIVILÈGE » / « ACCESSOIRES ».',
      layout_hints: [ 'hero-promo', 'categorie-banner', 'texte-lisible' ],
      dominant_colors: [ '#F5A623', '#000000' ],
      shows_physical_product: false,
      asset_kind: 'text_only_banner'
    },
    {
      asset_id: 'products/sommeil_glace.jpg',
      fileName: 'sommeil_glace.jpg',
      fileType: 'products',
      description: 'Mise en scène produit : boîte, verre de thé glacé, menthe.',
      layout_hints: [ 'product-packshot', 'lifestyle-usage' ],
      dominant_colors: [ '#E8D7C3' ],
      shows_physical_product: true,
      asset_kind: 'lifestyle_scene',
      primary_product_name: 'Sommeil',
      is_generic_collection: false
    }
  ]
};

function physicalProduct (
  asset_id: string,
  primary_product_name: string,
  is_generic_collection = false
): AssetDescriptionsFile['assets'][number] {
  const fileName = asset_id.replace(/^products\//u, '');
  return {
    asset_id,
    fileName,
    fileType: 'products',
    description: `Packshot ${primary_product_name}.`,
    layout_hints: [ 'packshot-centre' ],
    dominant_colors: [ '#ffffff' ],
    shows_physical_product: true,
    asset_kind: 'product_packshot',
    primary_product_name,
    is_generic_collection
  };
}

const threeSommeilDuplicates: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [
    physicalProduct('products/a.jpg', 'Sommeil'),
    physicalProduct('products/b.jpg', 'Sommeil'),
    physicalProduct('products/c.jpg', 'Sommeil')
  ]
};

const sommeilAndDrainant: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [
    physicalProduct('products/sommeil.jpg', 'Sommeil'),
    physicalProduct('products/drainant.jpg', 'Drainant'),
    physicalProduct('products/minceur.jpg', 'Minceur')
  ]
};

const emptySkuProduct: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [ physicalProduct('products/hero.jpg', '') ]
};

test('deterministicFindingsFromAssetDescriptions blocks text_only_banner', () => {
  const findings = deterministicFindingsFromAssetDescriptions(kusmiMenuTile, 2);
  const menuBlocker = findings.find((f) => f.asset_id === 'products/MENU_vp_access_fr_ete_26.jpg');
  assert.ok(menuBlocker !== undefined);
  assert.equal(menuBlocker?.severity, 'blocker');
  assert.match(menuBlocker?.issue ?? '', /text-only/iu);
});

test('deterministicFindingsFromAssetDescriptions accepts enough usable products', () => {
  const findings = deterministicFindingsFromAssetDescriptions(sommeilAndDrainant, 3, {
    profile: 'retail',
    campaignTerms: [ 'sommeil', 'drainant', 'minceur' ]
  });
  const folderBlocker = findings.find(
    (f) => f.asset_id === 'products' && f.severity === 'blocker' && /Need at least/iu.test(f.issue)
  );
  assert.equal(folderBlocker, undefined);
});

test('pruneVisionBlockedProducts removes blocked product files', () => {
  const directoryPath = mkdtempSync(join(tmpdir(), 'prune-vision-'));
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  mkdirSync(join(directoryPath, 'review'), { recursive: true });
  writeFileSync(join(directoryPath, 'products', 'bad.jpg'), 'fake');
  writeFileSync(join(directoryPath, 'products', 'good.jpg'), 'fake');
  recordProductAssetSource(directoryPath, 'bad.jpg', 'https://example.com/bad.jpg');

  const { removed, excludedSourceUrls } = pruneVisionBlockedProducts(directoryPath, [
    {
      asset_id: 'products/bad.jpg',
      severity: 'blocker'
    }
  ]);

  assert.deepEqual(removed, [ 'products/bad.jpg' ]);
  assert.deepEqual(excludedSourceUrls, [ 'https://example.com/bad.jpg' ]);
  assert.equal(existsSync(join(directoryPath, 'products', 'bad.jpg')), false);
  assert.equal(existsSync(join(directoryPath, 'products', 'good.jpg')), true);
});

test('auditDistinctProducts blocks 3 assets with same SKU', () => {
  const findings = auditDistinctProducts(threeSommeilDuplicates);
  const dupBlocker = findings.find(
    (f) => f.severity === 'blocker' && f.asset_id === 'products' && /same SKU/iu.test(f.issue)
  );
  assert.ok(dupBlocker !== undefined);
});

test('auditDistinctProducts accepts Sommeil and Drainant as distinct', () => {
  const findings = auditDistinctProducts(sommeilAndDrainant);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0);
});

test('auditDistinctProducts blocks empty primary_product_name', () => {
  const findings = auditDistinctProducts(emptySkuProduct);
  assert.ok(
    findings.some(
      (f) => f.severity === 'blocker' && f.asset_id === 'products/hero.jpg' && /primary_product_name/iu.test(f.issue)
    )
  );
});

test('auditDistinctProducts accepts multi-SKU Kusmi-like portfolio', () => {
  const kusmiMultiSku: AssetDescriptionsFile = {
    generated_at: '2026-06-05T00:00:00.000Z',
    model: 'test',
    assets: [
      physicalProduct('products/drainant.jpg', 'Drainant - Rituel'),
      physicalProduct('products/minceur.png', 'Minceur - Rituel'),
      physicalProduct('products/sommeil.jpg', 'Sommeil - Rituel'),
      {
        ...physicalProduct('products/lot.png', 'Kusmi Tea Rituel Collection'),
        is_generic_collection: true
      }
    ]
  };
  const findings = auditDistinctProducts(kusmiMultiSku);
  const dupBlocker = findings.find((f) => f.severity === 'blocker' && /same SKU/iu.test(f.issue));
  assert.equal(dupBlocker, undefined);
  assert.equal(findings.filter((f) => f.severity === 'blocker').length, 0);
});

test('normalizeProductName strips accents and lowercases', () => {
  assert.equal(normalizeProductName('  Sommeil  '), 'sommeil');
  assert.equal(normalizeProductName('Thé Vert'), 'the vert');
});

test('minPhysicalProductAssets defaults to 1', () => {
  const prev = process.env['CREATIVE_ASSETS_MIN_PHYSICAL_PRODUCTS'];
  delete process.env['CREATIVE_ASSETS_MIN_PHYSICAL_PRODUCTS'];
  assert.equal(minPhysicalProductAssets(), 1);
  if (prev !== undefined) {
    process.env['CREATIVE_ASSETS_MIN_PHYSICAL_PRODUCTS'] = prev;
  }
});

test('minValidProductAssets defaults to 3', () => {
  const prev = process.env['CREATIVE_ASSETS_MIN_VALID_PRODUCTS'];
  delete process.env['CREATIVE_ASSETS_MIN_VALID_PRODUCTS'];
  assert.equal(minValidProductAssets(), 3);
  if (prev !== undefined) {
    process.env['CREATIVE_ASSETS_MIN_VALID_PRODUCTS'] = prev;
  }
});

test('maxValidProductAssets defaults to 5', () => {
  const prev = process.env['CREATIVE_ASSETS_MAX_VALID_PRODUCTS'];
  delete process.env['CREATIVE_ASSETS_MAX_VALID_PRODUCTS'];
  assert.equal(maxValidProductAssets(), 5);
  if (prev !== undefined) {
    process.env['CREATIVE_ASSETS_MAX_VALID_PRODUCTS'] = prev;
  }
});

const legoPokemonTerms = buildRetailCampaignRelevanceTerms({
  campaignContext: 'mise en avant des produits pokemon',
  productName: 'LEGO® Pokémon™ collection (2026 collaboration)',
  brandName: 'LEGO® Pokémon™',
  companyName: 'The LEGO Group',
  brandURL: 'https://www.lego.com/fr-fr/themes/pokemon'
});

const legoPokemonPortfolio: AssetDescriptionsFile = {
  generated_at: '2026-06-10T00:00:00.000Z',
  model: 'test',
  assets: [
    {
      asset_id: 'products/40892_Prod.jpg',
      fileName: '40892_Prod.jpg',
      fileType: 'products',
      description: 'LEGO Pokémon 40892 Kanto Region Badge Collection packshot.',
      layout_hints: [ 'packshot-centre' ],
      dominant_colors: [ '#0066CC' ],
      shows_physical_product: true,
      asset_kind: 'product_packshot',
      primary_product_name: '40892 Kanto Region Badge Collection',
      is_generic_collection: false
    },
    {
      asset_id: 'products/fifa.jpg',
      fileName: 'fifa.jpg',
      fileType: 'products',
      description: 'LEGO sculpture of FIFA World Cup Trophy in multicolor bricks.',
      layout_hints: [ 'lifestyle-scene' ],
      dominant_colors: [ '#FFD700' ],
      shows_physical_product: true,
      asset_kind: 'lifestyle_scene',
      primary_product_name: 'FIFA World Cup Trophy LEGO Set',
      is_generic_collection: false
    },
    {
      asset_id: 'products/squirtle.jpg',
      fileName: 'squirtle.jpg',
      fileType: 'products',
      description: 'LEGO Pokémon 72156 Squirtle SMART Play set lifestyle scene.',
      layout_hints: [ 'packshot-hero-product' ],
      dominant_colors: [ '#0066CC' ],
      shows_physical_product: true,
      asset_kind: 'lifestyle_scene',
      primary_product_name: '72156 Squirtle',
      is_generic_collection: false
    }
  ]
};

test('retail audit blocks off-topic FIFA asset on LEGO Pokémon campaign', () => {
  const findings = deterministicFindingsFromRetailDescriptions(legoPokemonPortfolio, 3, legoPokemonTerms);
  const fifaBlocker = findings.find(
    (f) => f.asset_id === 'products/fifa.jpg' && f.severity === 'blocker'
  );
  assert.ok(fifaBlocker !== undefined, JSON.stringify(findings));
  assert.match(fifaBlocker?.issue ?? '', /off-topic/iu);
});

test('retail audit blocks when fewer than 3 on-campaign products', () => {
  const twoPokemon: AssetDescriptionsFile = {
    ...legoPokemonPortfolio,
    assets: legoPokemonPortfolio.assets.filter((a) => a.fileName !== 'fifa.jpg')
  };
  const findings = deterministicFindingsFromRetailDescriptions(twoPokemon, 2, legoPokemonTerms);
  const countBlocker = findings.find(
    (f) => f.asset_id === 'products' && f.severity === 'blocker' && /at least 3/iu.test(f.issue)
  );
  assert.ok(countBlocker !== undefined, JSON.stringify(findings));
});

test('retail audit passes with three on-campaign Pokémon products', () => {
  const threePokemon: AssetDescriptionsFile = {
    ...legoPokemonPortfolio,
    assets: [
      ...legoPokemonPortfolio.assets.filter((a) => a.fileName !== 'fifa.jpg'),
      {
        ...physicalProduct('products/eevee.jpg', '72151 Eevee'),
        description: 'LEGO Pokémon 72151 Eevee display set packshot on white background.'
      }
    ]
  };
  const findings = deterministicFindingsFromRetailDescriptions(threePokemon, 3, legoPokemonTerms);
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('pruneExcessProductAssets keeps at most max valid products', () => {
  const directoryPath = mkdtempSync(join(tmpdir(), 'prune-excess-'));
  mkdirSync(join(directoryPath, 'products'), { recursive: true });
  for (let i = 1; i <= 6; i += 1) {
    writeFileSync(join(directoryPath, 'products', `p${String(i)}.jpg`), 'fake');
  }
  const { removed } = pruneExcessProductAssets(directoryPath, { max: 5, campaignTerms: [] });
  assert.equal(removed.length, 1);
  assert.equal(
    [ 'p1.jpg', 'p2.jpg', 'p3.jpg', 'p4.jpg', 'p5.jpg', 'p6.jpg' ].filter((f) =>
      existsSync(join(directoryPath, 'products', f))
    ).length,
    5
  );
});

const walibiExperiencePortfolio: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [
    physicalProduct('products/abonnement-saison.jpg', 'Abonnement Saison Walibi'),
    physicalProduct('products/carte-cadeau-walibi.jpg', 'Carte Cadeau Walibi'),
    {
      asset_id: 'products/walibi-shooting-pub-2025---0031.jpg',
      fileName: 'walibi-shooting-pub-2025---0031.jpg',
      fileType: 'products',
      description: 'Wide-angle roller coaster action shot with riders against blue sky.',
      layout_hints: [ 'lifestyle-scene', 'roller-coaster-action' ],
      dominant_colors: [ '#FFC600' ],
      shows_physical_product: false,
      asset_kind: 'attraction_photo'
    }
  ]
};

test('experience portfolio accepts lifestyle_scene without physical product flag', () => {
  const findings = deterministicFindingsFromAssetDescriptions(walibiExperiencePortfolio, 4, {
    profile: 'experience',
    campaignTerms: [ 'walibi', 'ete' ]
  });
  const lifestyleBlocker = findings.find(
    (f) => f.asset_id === 'products/walibi-shooting-pub-2025---0031.jpg' && f.severity === 'blocker'
  );
  assert.equal(lifestyleBlocker, undefined, JSON.stringify(findings));
});

test('experience portfolio passes with lifestyle and ticket assets', () => {
  const walibiTerms = [ 'walibi', 'ete', 'rhone alpes', 'parc attraction' ];
  const findings = deterministicFindingsFromExperienceDescriptions(
    walibiExperiencePortfolio,
    4,
    walibiTerms
  );
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('experience audit via profile accepts shooting and passes', () => {
  const walibiTerms = [ 'walibi', 'ete', 'rhone alpes' ];
  const findings = deterministicFindingsFromAssetDescriptions(walibiExperiencePortfolio, 4, {
    profile: 'experience',
    campaignTerms: walibiTerms
  });
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('experience audit blocks text-only nav tile', () => {
  const withNav: AssetDescriptionsFile = {
    ...walibiExperiencePortfolio,
    assets: [
      ...walibiExperiencePortfolio.assets,
      {
        asset_id: 'products/MENU_vp_access.jpg',
        fileName: 'MENU_vp_access.jpg',
        fileType: 'products',
        description: 'Bannière promotionnelle avec texte « ACCESSOIRES » sur fond dégradé.',
        layout_hints: [ 'hero-promo', 'categorie-banner', 'texte-lisible' ],
        dominant_colors: [ '#F5A623' ],
        shows_physical_product: false,
        asset_kind: 'text_only_banner'
      }
    ]
  };
  const findings = deterministicFindingsFromExperienceDescriptions(withNav, 5, [ 'walibi' ]);
  const navBlocker = findings.find((f) => f.asset_id === 'products/MENU_vp_access.jpg');
  assert.ok(navBlocker !== undefined);
  assert.equal(navBlocker?.severity, 'blocker');
});

const scaryMovieTerms = [ 'scary movie', 'scary movie 6', '2026' ];

function entertainmentPoster (
  asset_id: string,
  asset_kind: 'theatrical_poster' | 'key_art' | 'film_still' | 'promotional_photo' = 'theatrical_poster'
): AssetDescriptionsFile['assets'][number] {
  const fileName = asset_id.replace(/^products\//u, '');
  return {
    asset_id,
    fileName,
    fileType: 'products',
    description: 'Affiche officielle Scary Movie 6 (2026) avec titre et casting.',
    layout_hints: [ 'theatrical-poster' ],
    dominant_colors: [ '#C8102E', '#000000' ],
    shows_physical_product: false,
    asset_kind,
    primary_product_name: 'Scary Movie (2026)',
    is_generic_collection: false
  };
}

const threeScaryMoviePosters: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [
    entertainmentPoster('products/poster1.jpg'),
    entertainmentPoster('products/poster2.jpg', 'key_art'),
    entertainmentPoster('products/still1.jpg', 'film_still')
  ]
};

const scaryMoviePosterAndStills: AssetDescriptionsFile = {
  generated_at: '2026-06-05T00:00:00.000Z',
  model: 'test',
  assets: [
    entertainmentPoster('products/poster.jpg'),
    {
      ...entertainmentPoster('products/still.jpg', 'film_still'),
      description: 'Plan rapproché du personnage Ghostface dans une scène du film Scary Movie 6.',
      layout_hints: [ 'character-close-up' ],
      shows_physical_product: false
    }
  ]
};

test('entertainment audit accepts multiple posters with same film title', () => {
  const findings = deterministicFindingsFromAssetDescriptions(threeScaryMoviePosters, 3, {
    profile: 'entertainment',
    campaignTerms: scaryMovieTerms
  });
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('entertainment audit accepts stills with shows_physical_product=false', () => {
  const findings = deterministicFindingsFromEntertainmentDescriptions(
    scaryMoviePosterAndStills,
    2,
    scaryMovieTerms
  );
  const blockers = findings.filter((f) => f.severity === 'blocker');
  assert.equal(blockers.length, 0, JSON.stringify(blockers));
});

test('entertainment audit blocks text-only nav tile', () => {
  const withNavTile: AssetDescriptionsFile = {
    generated_at: '2026-06-05T00:00:00.000Z',
    model: 'test',
    assets: [
      entertainmentPoster('products/poster.jpg'),
      {
        asset_id: 'products/MENU_nav.jpg',
        fileName: 'MENU_nav.jpg',
        fileType: 'products',
        description: 'Tuile de catégorie avec texte seul « ACCESSOIRES » sur fond dégradé.',
        layout_hints: [ 'categorie-banner', 'texte-lisible' ],
        dominant_colors: [ '#F5A623' ],
        shows_physical_product: false,
        asset_kind: 'text_only_banner'
      }
    ]
  };
  const findings = deterministicFindingsFromEntertainmentDescriptions(withNavTile, 2, scaryMovieTerms);
  const navBlocker = findings.find((f) => f.asset_id === 'products/MENU_nav.jpg');
  assert.ok(navBlocker !== undefined);
  assert.equal(navBlocker?.severity, 'blocker');
  assert.match(navBlocker?.issue ?? '', /text-only navigation/iu);
});
