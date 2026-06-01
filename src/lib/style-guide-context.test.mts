import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductMatchTerms,
  extractCampaignContextFromPrompt,
  filterPrioritizeProductUrls,
  isCatalogCampaign,
  isListingPageCampaign,
  isOfficialBrandProductImageUrl,
  isOfficialHostCampaignOrProductImageUrl,
  isProductAssetFromReferenceListing,
  resolveReferenceListingUrls,
  parseStyleGuideContextPrompt,
  scoreProductContextRelevance,
  wouldPassListingProductAsset
} from './style-guide-context.mts';
import { extractHttpsUrlsFromText } from './style-guide-urls.mts';

test('extractCampaignContextFromPrompt', () => {
  assert.equal(
    extractCampaignContextFromPrompt('The brand is BYD and the context is the new SEAL U SUV launch'),
    'the new SEAL U SUV launch'
  );
});

test('buildProductMatchTerms prioritizes product name', () => {
  const terms = buildProductMatchTerms({
    campaignContext: 'the new EV GTI 208 they are launching',
    productName: '208 GTI',
    brandName: 'Peugeot',
    brandURL: 'https://www.peugeot.fr/modeles/208-gti'
  });
  assert.ok(terms.some((t) => /208/iu.test(t)));
  assert.ok(terms[0]!.toLowerCase().includes('208') || terms[0]!.toLowerCase().includes('gti'));
});

test('scoreProductContextRelevance accepts IKEA SÖDERHAMN packshot despite promotion in campaign', () => {
  const terms = buildProductMatchTerms({
    campaignContext: 'promotion de la série SÖDERHAMN',
    productName: 'SÖDERHAMN',
    brandName: 'IKEA',
    brandURL: 'https://www.ikea.com/fr/fr/cat/soederhamn-serie-22178/'
  });
  const packshot = scoreProductContextRelevance(
    'soederhamn-module-3-places-viarp-beige-brun__0802813_pe768605_s5.jpg',
    '',
    terms
  );
  assert.ok(
    packshot >= 12,
    `expected packshot score >= 12, got ${String(packshot)}`
  );
});

test('scoreProductContextRelevance penalizes wrong BYD model', () => {
  const terms = buildProductMatchTerms({
    campaignContext: 'promoting the SEAL U family SUV',
    productName: 'BYD SEAL U',
    brandName: 'BYD Auto',
    brandURL: 'https://www.byd.com/fr/voitures-electriques/seal-u'
  });
  const sealU = scoreProductContextRelevance(
    'https://www.byd.com/material/seal_u_maggio.webp',
    'SEAL U promo',
    terms
  );
  const sealion = scoreProductContextRelevance(
    'https://www.byd.com/material/byd-sealion-7-1stBanner-xl.jpg',
    'Sealion 7',
    terms
  );
  assert.ok(sealU > sealion);
});

test('isCatalogCampaign detects collection-style productName', () => {
  assert.equal(
    isCatalogCampaign({
      productName: "La collection d'été",
      campaignContext: 'summer swimwear push',
      brandName: 'Petit Bateau'
    }),
    true
  );
  assert.equal(
    isCatalogCampaign({
      productName: 'BYD SEAL U',
      campaignContext: 'SUV launch',
      brandName: 'BYD'
    }),
    false
  );
});

test('isCatalogCampaign detects promotions / weekly offers (Lidl-style)', () => {
  assert.equal(
    isCatalogCampaign({
      productName: 'Promotions Lidl (mise en avant des produits en promotion)',
      campaignContext: 'mise en avant des produits en promotions',
      brandName: 'Lidl France'
    }),
    true
  );
});

test('isListingPageCampaign is true when campaignReferenceUrl is set (no catalog keywords)', () => {
  assert.equal(
    isListingPageCampaign({
      productName: 'Hero offer',
      campaignContext: 'Spring push',
      brandName: 'Example',
      campaignReferenceUrl: 'https://shop.example.com/offers/spring'
    }),
    true
  );
  assert.deepEqual(
    resolveReferenceListingUrls({
      campaignReferenceUrl: 'https://www.lidl.fr/q/query/promotions',
      campaignUrls: [ 'https://www.lidl.fr/other/' ]
    }),
    [ 'https://www.lidl.fr/q/query/promotions', 'https://www.lidl.fr/other/' ]
  );
});

test('isProductAssetFromReferenceListing uses fromReferencePage and sourcePageUrl', () => {
  const refs = [ 'https://www.lidl.fr/q/query/promotions' ];
  assert.equal(
    isProductAssetFromReferenceListing(
      {
        fileName: 'x7f2.jpg',
        sourceUrl: 'https://www.lidl.fr/static/assets/x7f2.jpg',
        fromReferencePage: true
      },
      refs
    ),
    true
  );
  assert.equal(
    isProductAssetFromReferenceListing(
      {
        fileName: 'x7f2.jpg',
        sourceUrl: 'https://www.lidl.fr/static/assets/x7f2.jpg',
        sourcePageUrl: 'https://www.lidl.fr/q/query/promotions'
      },
      refs
    ),
    true
  );
  assert.equal(
    isProductAssetFromReferenceListing(
      {
        fileName: 'x7f2.jpg',
        sourceUrl: 'https://press.example/photo.jpg'
      },
      refs
    ),
    false
  );
});

test('isOfficialHostCampaignOrProductImageUrl trusts Lidl promo assets on static CDN', () => {
  const hosts = [ 'lidl.fr' ];
  const won =
    'https://www.lidl.fr/static/assets/WON_FL-2239964.jpg';
  const visa = 'https://www.lidl.fr/static/assets/visa-2022-58947.svg';
  assert.equal(isOfficialHostCampaignOrProductImageUrl(won, hosts), true);
  assert.equal(isOfficialHostCampaignOrProductImageUrl(visa, hosts), false);
});

test('filterPrioritizeProductUrls keeps Lidl static promo URLs without term match', () => {
  const hosts = [ 'lidl.fr' ];
  const promoUrl = 'https://www.lidl.fr/static/assets/WON-2224544.jpg';
  const filtered = filterPrioritizeProductUrls(
    [ promoUrl ],
    [ 'Promotions Lidl (mise en avant des produits en promotion)' ],
    12,
    hosts
  );
  assert.deepEqual(filtered, [ promoUrl ]);
});

test('parseStyleGuideContextPrompt extracts campaign URLs', () => {
  const parsed = parseStyleGuideContextPrompt(
    'The brand is Petit Bateau and the context is collection https://www.petit-bateau.fr/collection/collection-ete/',
    extractHttpsUrlsFromText
  );
  assert.ok(parsed.campaignUrls.some((u) => u.includes('collection-ete')));
});

test('scoreProductContextRelevance matches été in URL as ETE', () => {
  const terms = buildProductMatchTerms({
    campaignContext: "Promotion de la collection d'été",
    productName: 'Collection Été Petit Bateau',
    brandName: 'Petit Bateau',
    brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/'
  });
  const packshot = scoreProductContextRelevance(
    'https://www.petit-bateau.fr/dw/image/v2/BCKL_PRD/on/demandware.static/-/Library/default/MACARON_PLEIN_ETE_tshirt.jpg',
    '',
    terms
  );
  assert.ok(packshot >= 12);
});

test('filterPrioritizeProductUrls keeps official /dw/image/ without term match', () => {
  const hosts = [ 'petit-bateau.fr' ];
  const officialUrl =
    'https://www.petit-bateau.fr/dw/image/v2/BCKL_PRD/on/demandware.static/MACARON_PLEIN_ETE_robe.jpg';
  const pressUrl = 'https://cdn.leparisien.fr/editorial/unrelated.jpg';
  assert.equal(isOfficialBrandProductImageUrl(officialUrl, hosts), true);
  const filtered = filterPrioritizeProductUrls(
    [ pressUrl, officialUrl ],
    [ 'Collection Été Petit Bateau' ],
    12,
    hosts
  );
  assert.ok(filtered.includes(officialUrl));
  assert.equal(filtered.includes(pressUrl), false);
});

test('buildProductMatchTerms includes collection slug from brandURL', () => {
  const terms = buildProductMatchTerms({
    productName: 'Collection Été',
    brandName: 'Petit Bateau',
    brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/'
  });
  assert.ok(terms.some((t) => /collection-ete|collection ete/iu.test(t)));
});

test('wouldPassListingProductAsset rejects Wikipedia cover, accepts Lord of Hatred CDN URL', () => {
  const refs = [ 'https://diablo4.blizzard.com/en-us/lord-of-hatred' ];
  const hosts = [ 'blizzard.com', 'diablo4.blizzard.com' ];
  const terms = buildProductMatchTerms({
    campaignContext: 'Lord of Hatred expansion launch',
    productName: 'Diablo IV: Lord of Hatred',
    brandName: 'Diablo IV',
    brandURL: 'https://diablo4.blizzard.com/en-us/lord-of-hatred'
  });
  assert.equal(
    wouldPassListingProductAsset({
      entry: {
        fileName: 'Diablo_IV_cover_art.png',
        sourceUrl: 'https://upload.wikimedia.org/wikipedia/en/8/8e/Diablo_IV_cover_art.png'
      },
      sourceUrl: 'https://upload.wikimedia.org/wikipedia/en/8/8e/Diablo_IV_cover_art.png',
      referenceListingUrls: refs,
      officialHosts: hosts,
      terms
    }),
    false
  );
  assert.equal(
    wouldPassListingProductAsset({
      entry: {
        fileName: 'lord-hatred.jpg',
        sourceUrl:
          'https://bnetcmsus-a.akamaihd.net/cms/page_media/9G/9G4VZQZ0P1K31710234567890-lord-of-hatred-key-art.jpg'
      },
      sourceUrl:
        'https://bnetcmsus-a.akamaihd.net/cms/page_media/9G/9G4VZQZ0P1K31710234567890-lord-of-hatred-key-art.jpg',
      referenceListingUrls: refs,
      officialHosts: hosts,
      terms
    }),
    true
  );
});

test('buildProductMatchTerms extracts slug from brandURL without brand-specific regex', () => {
  const terms = buildProductMatchTerms({
    productName: 'Summer drop',
    brandName: 'Example',
    brandURL: 'https://shop.example.com/en/categories/summer-drop-2026'
  });
  assert.ok(terms.some((t) => /summer-drop|summer drop/iu.test(t)));
  assert.equal(terms.some((t) => t === 'en'), false);
  assert.equal(terms.some((t) => t === 'categories'), false);
});
