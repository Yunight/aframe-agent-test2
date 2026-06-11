import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOfficialLogoSvgUrl,
  officialUrlsIncludeSvg
} from './logo-asset-rules.mts';

test('isOfficialLogoSvgUrl detects svg paths', () => {
  assert.equal(isOfficialLogoSvgUrl('https://brand.com/logo.svg'), true);
  assert.equal(isOfficialLogoSvgUrl('https://brand.com/logo.png'), false);
});

test('officialUrlsIncludeSvg', () => {
  assert.equal(officialUrlsIncludeSvg([ 'https://x.com/a.png' ]), false);
  assert.equal(officialUrlsIncludeSvg([ 'https://x.com/logo.svg' ]), true);
});
