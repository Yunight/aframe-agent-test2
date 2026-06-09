import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isListingBraveProductCandidateAllowed,
  resolveRefreshLogoQueries,
  resolveRefreshProductQueries,
  shouldRelaxProductListingBraveFilter,
  type ImageSearchContext
} from './brave-image-assets.mts';

const context: ImageSearchContext = {
  brandName: 'Petit Bateau',
  companyName: 'Petit Bateau',
  productName: "La collection d'été",
  brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/',
  companyURL: 'https://www.petit-bateau.fr/'
};

test('resolveRefreshLogoQueries: logos [] skips fallback', () => {
  const queries = resolveRefreshLogoQueries({ logos: [] }, context);
  assert.deepEqual(queries, []);
});

test('resolveRefreshLogoQueries: omitted logos uses buildLogoSearchQueries', () => {
  const queries = resolveRefreshLogoQueries({}, context);
  assert.ok(queries.length > 0);
  assert.match(queries.join(' '), /Petit Bateau/iu);
});

test('resolveRefreshProductQueries: products [] skips fallback', () => {
  const queries = resolveRefreshProductQueries({ products: [] }, context);
  assert.deepEqual(queries, []);
});

test('listing mode rejects non-official Brave candidates', () => {
  const hosts = [ 'decathlon.com' ];
  assert.equal(
    isListingBraveProductCandidateAllowed(
      'https://cache.marieclaire.fr/data/photo/w1000_ci/79/soldes-deco-2026.jpg',
      hosts
    ),
    false
  );
});

test('listing mode allows official brand visual hosts', () => {
  const hosts = [ 'decathlon.com' ];
  assert.equal(
    isListingBraveProductCandidateAllowed(
      'https://www.decathlon.com/cdn/shop/files/8618759-product_image-p2315780.jpg?v=1',
      hosts
    ),
    true
  );
});

test('shouldRelaxProductListingBraveFilter when no products downloaded in listing mode', () => {
  assert.equal(
    shouldRelaxProductListingBraveFilter({
      fileType: 'products',
      listingMode: true,
      downloadedCount: 0
    }),
    true
  );
  assert.equal(
    shouldRelaxProductListingBraveFilter({
      fileType: 'products',
      listingMode: true,
      downloadedCount: 1
    }),
    false
  );
  assert.equal(
    shouldRelaxProductListingBraveFilter({
      fileType: 'logos',
      listingMode: true,
      downloadedCount: 0
    }),
    false
  );
  assert.equal(
    shouldRelaxProductListingBraveFilter({
      fileType: 'products',
      listingMode: false,
      downloadedCount: 0
    }),
    false
  );
});
