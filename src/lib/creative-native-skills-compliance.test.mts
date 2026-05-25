import assert from 'node:assert/strict';
import test from 'node:test';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { validateCreativeSkillCompliance } from './creative-native-skills.mts';

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
