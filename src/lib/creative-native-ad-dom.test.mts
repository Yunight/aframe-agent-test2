import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdFormatSelection } from './studio-ad-formats.mts';
import { findUnselectedAdUnitsInHtml } from './creative-native-ad-dom.mts';
import { buildCreativeAdFormatInstructions } from './studio-ad-formats.mts';

const archeOnly: AdFormatSelection[] = [
  {
    id: 'arche-1600x960',
    width: 1600,
    height: 960,
    arche: {
      headerPx: 200,
      gutterPx: 230,
      mainFocusWidthPx: 1280,
      maxTotalWeightKB: 150,
      allowedRasterMime: [ 'image/jpeg', 'image/png' ],
      trackingNote: 'Tracking OK',
      companionPresetIds: [ '300x250', '300x600' ]
    }
  }
];

test('findUnselectedAdUnitsInHtml flags companion banners when only arche selected', () => {
  const html =
    '<div id="ad-arche-1600x960" data-format="arche"></div>'
    + '<div id="ad-companion-300x250" data-format="300x250"></div>'
    + '<div id="ad-companion-300x600" data-format="300x600"></div>';
  const extras = findUnselectedAdUnitsInHtml(html, archeOnly);
  assert.deepEqual(extras.sort(), [ '300x250', '300x600' ]);
});

test('findUnselectedAdUnitsInHtml accepts arche-only page', () => {
  const html = '<div id="ad-arche-1600x960" data-format="arche"></div>';
  assert.deepEqual(findUnselectedAdUnitsInHtml(html, archeOnly), []);
});

test('buildCreativeAdFormatInstructions tells model not to generate companions for arche-only', () => {
  const text = buildCreativeAdFormatInstructions(archeOnly);
  assert.match(text, /Ne pas générer de compagnons/iu);
  assert.doesNotMatch(text, /Compagnons demandés/iu);
});

test('buildCreativeAdFormatInstructions requests companions when explicitly selected', () => {
  const formats: AdFormatSelection[] = [
    ...archeOnly,
    { id: '300x250', width: 300, height: 250 }
  ];
  const text = buildCreativeAdFormatInstructions(formats);
  assert.match(text, /300x250/iu);
  assert.doesNotMatch(text, /Ne pas générer de compagnons/iu);
});
