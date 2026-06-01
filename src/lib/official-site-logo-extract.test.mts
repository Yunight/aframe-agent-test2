import assert from 'node:assert/strict';
import test from 'node:test';
import {
  brandDomainTokenFromHost,
  buildFallbackPageUrls,
  dedupeProductUrlKey,
  extractFallbackLogoCandidatesFromHtml,
  extractLogoCandidatesFromHtml,
  isCrawlBlockedHttpStatus,
  isLowValueOfficialProductUrl,
  officialPageUrlsFromContext,
  shouldSkipPageForBlockedHost,
  shouldUseWikipediaProductFallback,
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

test('extractLogoCandidatesFromHtml prefers brand ikea.svg over logo-container decorative png', () => {
  const html = `
    <header>
      <div class="logo-container">
        <a href="/global/assets/logos/brand/ikea.svg">
          <img src="/global/en/images/kungscissus-1.png" alt="" />
        </a>
      </div>
    </header>
  `;
  const found = extractLogoCandidatesFromHtml(html, 'https://www.ikea.com/', [ 'ikea.com' ]);
  assert.ok(found.length >= 1);
  assert.match(found[0]!.url, /ikea\.svg/iu);
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

test('officialPageUrlsFromContext lists reference URL before brandURL', () => {
  const urls = officialPageUrlsFromContext({
    brandName: 'Petit Bateau',
    companyName: 'Petit Bateau',
    productName: 'Collection',
    brandURL: 'https://www.petit-bateau.fr/',
    companyURL: 'https://www.petit-bateau.fr/',
    campaignReferenceUrl: 'https://www.petit-bateau.fr/collection/collection-ete/',
    campaignUrls: [ 'https://www.petit-bateau.fr/collection/other/' ]
  });
  const collectionHref = 'https://www.petit-bateau.fr/collection/collection-ete/';
  assert.ok(urls.includes(collectionHref));
  const otherCampaign = 'https://www.petit-bateau.fr/collection/other/';
  const idxCollection = urls.indexOf(collectionHref);
  const idxOther = urls.indexOf(otherCampaign);
  assert.ok(idxCollection >= 0);
  assert.ok(idxOther < 0 || idxCollection < idxOther);
});

test('officialPageUrlsFromContext scrapes collection href before site root', () => {
  const urls = officialPageUrlsFromContext({
    brandName: 'Petit Bateau',
    companyName: 'Petit Bateau',
    productName: 'Collection Été',
    brandURL: 'https://www.petit-bateau.fr/collection/collection-ete/',
    companyURL: 'https://www.petit-bateau.fr/'
  });
  const collectionHref = 'https://www.petit-bateau.fr/collection/collection-ete/';
  const root = 'https://www.petit-bateau.fr/';
  assert.equal(urls[0], collectionHref);
  assert.ok(urls.indexOf(root) > urls.indexOf(collectionHref));
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

test('shouldUseWikipediaProductFallback skips when listing reference URL is set', () => {
  const ctx = {
    brandName: 'Diablo IV',
    companyName: 'Blizzard Entertainment',
    productName: 'Diablo IV: Lord of Hatred',
    brandURL: 'https://diablo4.blizzard.com/',
    companyURL: 'https://www.blizzard.com/',
    campaignReferenceUrl: 'https://diablo4.blizzard.com/en-us/lord-of-hatred'
  };
  assert.equal(
    shouldUseWikipediaProductFallback(ctx, { allOfficialBlocked: true, candidateCount: 0 }),
    false
  );
  const { campaignReferenceUrl: _ref, ...skuOnly } = ctx;
  assert.equal(
    shouldUseWikipediaProductFallback(skuOnly, { allOfficialBlocked: true, candidateCount: 0 }),
    true
  );
});

test('shouldSkipPageForBlockedHost', () => {
  const blocked = new Set([ 'group.mercedes-benz.com' ]);
  assert.equal(shouldSkipPageForBlockedHost('group.mercedes-benz.com', blocked), true);
  assert.equal(shouldSkipPageForBlockedHost('www.mercedes-benz.fr', blocked), false);
});

test('brandDomainTokenFromHost', () => {
  assert.equal(brandDomainTokenFromHost('www.mercedes-benz.fr'), 'mercedes-benz');
});

test('dedupeProductUrlKey merges resize variants', () => {
  const a =
    'https://media.oneweb.mercedes-benz.com/images/static/v1/23681/8/98/979a14b0ba9dbe7d37273f1e5c4a7a45b8dd1.jpg?im=Resize,width=480';
  const b =
    'https://media.oneweb.mercedes-benz.com/images/static/v1/23681/8/98/979a14b0ba9dbe7d37273f1e5c4a7a45b8dd1.jpg?im=Crop,width=1920';
  assert.equal(dedupeProductUrlKey(a), dedupeProductUrlKey(b));
});

test('isLowValueOfficialProductUrl', () => {
  assert.equal(
    isLowValueOfficialProductUrl(
      'https://media.oneweb.mercedes-benz.com/images/dynamic/europe/FR/iris.png?q=1'
    ),
    true
  );
});

test('officialPageUrlsFromContext omits companyURL on different brand domain', () => {
  const urls = officialPageUrlsFromContext({
    brandName: 'Mercedes-Benz',
    companyName: 'Mercedes-Benz Group',
    productName: 'Classe A',
    brandURL: 'https://www.mercedes-benz.fr/passengercars/models/hatchback/a-class/overview.html',
    companyURL: 'https://group.mercedes-benz.com/',
    campaignReferenceUrl:
      'https://www.mercedes-benz.fr/passengercars/models/hatchback/a-class/overview.html'
  });
  assert.ok(
    urls.some((u) => u.includes('mercedes-benz.fr')),
    'includes fr brand page'
  );
  assert.ok(
    !urls.some((u) => u.includes('group.mercedes-benz.com')),
    'skips corporate host when reference is on fr domain'
  );
});

test('extractLogoCandidatesFromHtml allows oneweb CDN when page is mercedes-benz.fr', () => {
  const html = `
    <header>
      <img src="https://assets.oneweb.mercedes-benz.com/plugin/hp-assets/latest/images/brands/mercedes-benz/wordmark.svg" class="logo-simple" />
    </header>
  `;
  const found = extractLogoCandidatesFromHtml(
    html,
    'https://www.mercedes-benz.fr/passengercars/models/hatchback/a-class/overview.html',
    [ 'mercedes-benz.fr' ]
  );
  assert.ok(found.length >= 1);
  assert.match(found[0]!.url, /wordmark\.svg/iu);
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
