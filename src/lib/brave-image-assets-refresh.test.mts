import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveRefreshLogoQueries,
  resolveRefreshProductQueries,
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
