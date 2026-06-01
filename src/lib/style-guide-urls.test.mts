import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractHttpsUrlsFromText,
  normalizeBrandAndCompanyUrls,
  resolveCampaignReferenceUrl,
  sanitizeModelUrl
} from './style-guide-urls.mts';

test('sanitizeModelUrl strips trailing JSON punctuation', () => {
  assert.equal(
    sanitizeModelUrl("https://www.ikea.com/fr/fr/cat/soederhamn-series-22178/',"),
    'https://www.ikea.com/fr/fr/cat/soederhamn-series-22178/'
  );
});

test('extractHttpsUrlsFromText finds collection URL', () => {
  const urls = extractHttpsUrlsFromText(
    'Collection été: https://www.petit-bateau.fr/collection/collection-ete/ — marine mood.'
  );
  assert.ok(urls.some((u) => u.includes('collection-ete')));
});

test('resolveCampaignReferenceUrl prefers explicit API URL', () => {
  const resolved = resolveCampaignReferenceUrl({
    explicit: 'https://www.petit-bateau.fr/collection/collection-ete/',
    fromPromptUrls: [ 'https://example.com/other' ]
  });
  assert.ok(resolved?.includes('collection-ete'));
});

test('normalizeBrandAndCompanyUrls strips suspect Bleu200 segment', async () => {
  const result = await normalizeBrandAndCompanyUrls({
    brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/Bleu200',
    companyURL: 'https://www.petit-bateau.fr/',
    campaignReferenceUrl: 'https://www.petit-bateau.fr/collection/collection-ete/',
    campaignUrlsFromPrompt: [ 'https://www.petit-bateau.fr/collection/collection-ete/' ]
  });
  assert.ok(!result.brandURL.includes('Bleu200'));
  assert.ok(result.brandURL.includes('collection-ete'));
});
