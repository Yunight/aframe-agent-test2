import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOfficialLogoSvgUrl,
  looksLikeProductPackshotInLogosFolder,
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

test('looksLikeProductPackshotInLogosFolder', () => {
  assert.equal(looksLikeProductPackshotInLogosFolder('logo-petit-bateau.svg'), false);
  assert.equal(looksLikeProductPackshotInLogosFolder('brand-logo.png'), false);
  assert.equal(looksLikeProductPackshotInLogosFolder('A04P501D.jpg'), true);
  assert.equal(looksLikeProductPackshotInLogosFolder('5093200.jpg'), true);
});
