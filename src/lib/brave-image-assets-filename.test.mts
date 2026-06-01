import assert from 'node:assert/strict';
import test from 'node:test';
import { fileNameFromImageUrl } from './brave-image-assets.mts';

test('fileNameFromImageUrl uses pathname not query string', () => {
  const name = fileNameFromImageUrl(
    'https://www.petit-bateau.fr/dw/image/v2/BCKL_PRD/on/demandware.static/-/Sites-PB_master/default/dwf2b35dd2/PB/A09O301Z1.jpg?sw=800&sh=900&sm=fit'
  );
  assert.equal(name, 'A09O301Z1.jpg');
});
