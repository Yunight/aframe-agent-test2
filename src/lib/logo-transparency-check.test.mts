import assert from 'node:assert/strict';
import test from 'node:test';
import { logoRequireTransparency, validateLogoAssetBuffer } from './logo-transparency-check.mts';

test('logoRequireTransparency is strict by default', () => {
  const prev = process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  delete process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  assert.equal(logoRequireTransparency(), true);
  process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'] = '1';
  assert.equal(logoRequireTransparency(), false);
  if (prev === undefined) {
    delete process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  } else {
    process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'] = prev;
  }
});

test('validateLogoAssetBuffer accepts minimal SVG', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'utf8');
  const result = validateLogoAssetBuffer(svg);
  assert.equal(result.ok, true);
});

test('validateLogoAssetBuffer rejects JPEG by default', () => {
  const jpeg = Buffer.from([ 0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10 ]);
  const result = validateLogoAssetBuffer(jpeg);
  assert.equal(result.ok, false);
  assert.match(result.issue, /JPEG/iu);
});
