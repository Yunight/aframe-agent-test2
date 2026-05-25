import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOutputDirectoryName, slugifyBrandForOutputDir } from './repo-paths.mts';

test('slugifyBrandForOutputDir', () => {
  assert.equal(slugifyBrandForOutputDir('Petit Bateau'), 'petit-bateau');
  assert.equal(slugifyBrandForOutputDir('  '), 'brand');
  assert.equal(slugifyBrandForOutputDir('LEGO®'), 'lego');
});

test('buildOutputDirectoryName', () => {
  const id = '5629c8bd-2ae0-4fdf-b35c-2ed2cbfdd144';
  assert.equal(
    buildOutputDirectoryName('Petit Bateau', id),
    `petit-bateau-${id}`
  );
});
