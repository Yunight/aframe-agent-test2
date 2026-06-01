import assert from 'node:assert/strict';
import test from 'node:test';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { validateCreativeSkillCompliance } from './creative-native-skills.mts';
import {
  buildComplianceRetryHint,
  buildStyleGuideColorConstraintText,
  collectStyleGuideAllowedHex
} from './style-guide-colors.mts';

const minimalGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'> = {
  companyName: 'Test Co',
  companyContext: 'Test company',
  companyURL: 'https://example.com',
  brandName: 'Test Brand',
  brandContext: 'Test brand',
  brandURL: 'https://example.com',
  productName: 'Test Product',
  primaryColorPalette: [ '#111111', '#222222' ],
  secondaryColorPalette: [ '#333333' ],
  typography: [
    {
      fontFamily: 'Arial',
      fontWeight: 400,
      fontEffect: [],
      fontUses: 'body'
    }
  ],
  brandVision: 'Test vision',
  brandValues: 'Test values',
  logoImageSearchQueries: [],
  productImageSearchQueries: []
};

test('validateCreativeSkillCompliance rejects missing index.html', () => {
  const result = validateCreativeSkillCompliance(
    [ { fileName: 'styles.css', fileContent: 'body {}' } ],
    minimalGuide,
    []
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.issues.join(' '), /index\.html/iu);
  }
});

test('validateCreativeSkillCompliance accepts minimal valid bundle', () => {
  const files = [
    {
      fileName: 'index.html',
      fileContent:
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head>'
        + '<body><img src="./logo.svg"><img src="./prod.jpg"><script src="app.js" defer></script></body></html>'
    },
    { fileName: 'styles.css', fileContent: 'body { color: #111111; font-family: Arial, sans-serif; }' },
    { fileName: 'app.js', fileContent: 'document.querySelector("body");' }
  ];
  const assets = [
    { fileName: 'logo.svg', filePath: '/tmp/logo.svg', fileType: 'logos' as const },
    { fileName: 'prod.jpg', filePath: '/tmp/prod.jpg', fileType: 'products' as const }
  ];
  const result = validateCreativeSkillCompliance(files, minimalGuide, assets);
  assert.equal(result.ok, true);
});

function minimalValidFiles (cssExtra = ''): Array<{ fileName: string; fileContent: string }> {
  return [
    {
      fileName: 'index.html',
      fileContent:
        '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head>'
        + '<body><img src="./logo.svg"><img src="./prod.jpg"><script src="app.js" defer></script></body></html>'
    },
    {
      fileName: 'styles.css',
      fileContent: `body { color: #111111; font-family: Arial, sans-serif; }${cssExtra}`
    },
    { fileName: 'app.js', fileContent: 'document.querySelector("body");' }
  ];
}

const minimalAssets = [
  { fileName: 'logo.svg', filePath: '/tmp/logo.svg', fileType: 'logos' as const },
  { fileName: 'prod.jpg', filePath: '/tmp/prod.jpg', fileType: 'products' as const }
];

test('validateCreativeSkillCompliance rejects invented hex colors', () => {
  const files = minimalValidFiles('\n.hero { background: linear-gradient(#111111, #222244); }');
  const result = validateCreativeSkillCompliance(files, minimalGuide, minimalAssets);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.issues.join(' '), /222244/iu);
    assert.match(result.issues.join(' '), /colors outside style guide palettes/iu);
  }
});

test('validateCreativeSkillCompliance accepts palette-only hex colors', () => {
  const files = minimalValidFiles('\n.hero { background: #222222; border-color: #333333; }');
  const result = validateCreativeSkillCompliance(files, minimalGuide, minimalAssets);
  assert.equal(result.ok, true);
});

test('collectStyleGuideAllowedHex dedupes and normalizes palettes', () => {
  const allowed = collectStyleGuideAllowedHex({
    primaryColorPalette: [ '#111', '#111111' ],
    secondaryColorPalette: [ '#333333' ]
  });
  assert.deepEqual(allowed, [ '#111111', '#333333' ]);
});

test('buildStyleGuideColorConstraintText lists every allowed hex', () => {
  const text = buildStyleGuideColorConstraintText(minimalGuide);
  assert.match(text, /#111111/iu);
  assert.match(text, /#222222/iu);
  assert.match(text, /#333333/iu);
  assert.match(text, /never invent new hex codes/iu);
});

test('buildComplianceRetryHint includes allowed list for color issues', () => {
  const issues = [ 'Contains colors outside style guide palettes: 222244, 223333' ];
  const hint = buildComplianceRetryHint(issues, minimalGuide);
  assert.match(hint, /#111111/iu);
  assert.match(hint, /#333333/iu);
  assert.match(hint, /rgba\(\)/iu);
});

test('buildComplianceRetryHint is empty when no color issue', () => {
  const hint = buildComplianceRetryHint([ 'Missing index.html at project root.' ], minimalGuide);
  assert.equal(hint, '');
});

test('validateCreativeSkillCompliance rejects unselected companion formats on arche-only job', () => {
  const archeFormat = {
    id: 'arche-1600x960',
    width: 1600,
    height: 960,
    arche: {
      headerPx: 200,
      gutterPx: 230,
      mainFocusWidthPx: 1280,
      maxTotalWeightKB: 150,
      allowedRasterMime: [ 'image/jpeg' ],
      trackingNote: 'Tracking OK',
      companionPresetIds: [ '300x250', '300x600' ]
    }
  };
  const files = minimalValidFiles();
  files[0] = {
    fileName: 'index.html',
    fileContent:
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body>'
      + '<div id="ad-arche-1600x960" data-format="arche"><img src="./logo.svg"><img src="./prod.jpg"></div>'
      + '<div id="ad-companion-300x250" data-format="300x250"></div>'
      + '<script src="app.js" defer></script></body></html>'
  };
  const result = validateCreativeSkillCompliance(files, minimalGuide, minimalAssets, [ archeFormat ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.issues.join(' '), /300x250/iu);
    assert.match(result.issues.join(' '), /not requested/iu);
  }
});
