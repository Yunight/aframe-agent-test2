import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFallbackPageUrls,
  extractFallbackLogoCandidatesFromHtml,
  extractLogoCandidatesFromHtml,
  isCrawlBlockedHttpStatus,
  wikipediaSlugFromBrandName
} from './official-site-logo-extract.mts';

const OFFICIAL = [ 'petit-bateau.fr' ];

test('extractLogoCandidatesFromHtml finds primary-logo img', () => {
  const html = `
    <header>
      <div class="primary-logo">
        <img class="logo-simple" src="/static/logo-petit-bateau.svg" alt="Petit Bateau" />
      </div>
    </header>
  `;
  const found = extractLogoCandidatesFromHtml(html, 'https://www.petit-bateau.fr/', OFFICIAL);
  assert.ok(found.length >= 1);
  assert.match(found[0]!.url, /logo-petit-bateau\.svg/iu);
});

test('extractLogoCandidatesFromHtml ignores unrelated images', () => {
  const html = '<img src="/catalog/A04P501D.jpg" class="product-thumb" />';
  const found = extractLogoCandidatesFromHtml(html, 'https://www.petit-bateau.fr/', OFFICIAL);
  const logoHits = found.filter((c) => /A04P501D/iu.test(c.url));
  assert.equal(logoHits.length, 0);
});

test('isCrawlBlockedHttpStatus', () => {
  assert.equal(isCrawlBlockedHttpStatus(403), true);
  assert.equal(isCrawlBlockedHttpStatus(401), true);
  assert.equal(isCrawlBlockedHttpStatus(500), false);
});

test('wikipediaSlugFromBrandName', () => {
  assert.equal(wikipediaSlugFromBrandName('Red Bull'), 'Red_Bull');
});

test('buildFallbackPageUrls', () => {
  const urls = buildFallbackPageUrls({
    brandName: 'Red Bull',
    companyName: 'Red Bull GmbH',
    productName: '',
    brandURL: 'https://www.redbull.com',
    companyURL: 'https://www.redbull.com'
  });
  assert.ok(urls.some((u) => u.includes('en.wikipedia.org/wiki/Red_Bull')));
  assert.ok(urls.some((u) => u.includes('fr.wikipedia.org/wiki/Red_Bull')));
});

test('extractFallbackLogoCandidatesFromHtml infobox', () => {
  const html = `
    <table class="infobox vcard">
      <img src="//upload.wikimedia.org/wikipedia/en/9/9f/Red_Bull_logo.svg" />
    </table>
  `;
  const found = extractFallbackLogoCandidatesFromHtml(
    html,
    'https://en.wikipedia.org/wiki/Red_Bull'
  );
  assert.ok(found.length >= 1);
  assert.match(found[0]!.url, /Red_Bull_logo\.svg/iu);
});
