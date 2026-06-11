import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLogoSearchQueries,
  filterLogoSearchQueries,
  logoSearchCurrentYear,
  normalizeLegalEntityName,
  resolveLogoSearchNames,
  scoreCampaignLogoAdjustment,
  scoreEntertainmentLogoOpusPenalty,
  scoreSubBrandLogoAdjustment
} from './brave-image-assets.mts';

test('buildLogoSearchQueries includes current year for latest logo lockup', () => {
  const year = logoSearchCurrentYear();
  const queries = buildLogoSearchQueries({
    brandName: 'Peugeot',
    companyName: 'Stellantis',
    productName: 'Peugeot 308 SW',
    brandURL: 'https://www.peugeot.fr/',
    companyURL: 'https://www.stellantis.com/',
    logoImageSearchQueries: [],
    productImageSearchQueries: []
  });
  assert.ok(queries.some((q) => q.includes(String(year))), `expected year ${String(year)} in ${queries.join(' | ')}`);
  assert.ok(queries.some((q) => /Peugeot logo \d{4}/iu.test(q)));
});

test('resolveLogoSearchNames division line uses parent company only', () => {
  assert.equal(normalizeLegalEntityName('Nike, Inc.'), 'Nike');
  assert.deepEqual(
    resolveLogoSearchNames({
      brandName: 'Nike Football',
      companyName: 'Nike, Inc.',
      productName: 'Off-Pitch Looks France'
    }),
    [ 'Nike' ]
  );
});

test('resolveLogoSearchNames independent sub-brand returns brand and company', () => {
  assert.deepEqual(
    resolveLogoSearchNames({
      brandName: 'Parkside',
      companyName: 'Lidl',
      productName: 'Tools'
    }),
    [ 'Parkside', 'Lidl' ]
  );
  assert.deepEqual(
    resolveLogoSearchNames({
      brandName: 'Diablo IV',
      companyName: 'Blizzard Entertainment',
      productName: 'Diablo IV: Lord of Hatred'
    }),
    [ 'Diablo IV', 'Blizzard Entertainment' ]
  );
});

test('buildLogoSearchQueries uses brand names only not campaign product terms', () => {
  const queries = buildLogoSearchQueries({
    brandName: 'Diablo IV',
    companyName: 'Blizzard Entertainment',
    productName: 'Diablo IV: Lord of Hatred',
    brandURL: 'https://diablo4.blizzard.com/',
    companyURL: 'https://www.blizzard.com/',
    campaignReferenceUrl: 'https://diablo4.blizzard.com/en-us/lord-of-hatred',
    logoImageSearchQueries: [
      'Diablo IV Lord of Hatred logo svg',
      'site:diablo4.blizzard.com lord of hatred logo'
    ],
    productImageSearchQueries: []
  });
  assert.ok(queries.some((q) => /Diablo IV logo/iu.test(q)));
  assert.ok(queries.some((q) => /Blizzard Entertainment logo/iu.test(q)));
  assert.ok(!queries.some((q) => /lord of hatred/iu.test(q)));
  assert.ok(!queries.some((q) => /site:diablo4\.blizzard\.com.*lord of hatred/iu.test(q)));
});

test('filterLogoSearchQueries rejects campaign and product tokens for Nike Football', () => {
  const ctx = {
    brandName: 'Nike Football',
    companyName: 'Nike, Inc.',
    productName: 'Off-Pitch Looks France — FFF Lifestyle Collection 2026',
    campaignContext: 'promotion de la gamme look de foot france',
    campaignReferenceUrl: 'https://www.nike.com/fr/w/off-pitch-looks-france-9wreezabxgs'
  };
  const filtered = filterLogoSearchQueries(
    [
      'Nike swoosh logo transparent png 2026',
      'Nike Football logo FFF 2026 lockup',
      'FFF Fédération Française Football logo 2026 svg',
      'site:nike.com France football off-pitch looks logo 2026'
    ],
    ctx
  );
  assert.deepEqual(filtered, [ 'Nike swoosh logo transparent png 2026' ]);
});

test('scoreCampaignLogoAdjustment penalizes corporate Blizzard logo vs expansion lockup', () => {
  const scoring = {
    productName: 'Diablo IV: Lord of Hatred',
    companyName: 'Blizzard Entertainment',
    brandName: 'Diablo IV'
  };
  const corporate = scoreCampaignLogoAdjustment(
    'https://upload.wikimedia.org/wikipedia/commons/2/23/Blizzard_Entertainment_Logo.svg',
    'Blizzard Entertainment official logo',
    scoring
  );
  const expansion = scoreCampaignLogoAdjustment(
    'https://bnetcmsus-a.akamaihd.net/cms/page_media/lord-of-hatred-logo.svg',
    'Diablo IV Lord of Hatred logo',
    scoring
  );
  assert.ok(corporate < expansion, `corporate=${String(corporate)} expansion=${String(expansion)}`);
  assert.ok(corporate <= -100);
  assert.ok(expansion >= 80);
});

test('scoreSubBrandLogoAdjustment penalizes parent Lidl logo for Parkside sub-brand', () => {
  const scoring = {
    brandName: 'Parkside',
    companyName: 'Lidl'
  };
  const parentLogo = scoreSubBrandLogoAdjustment(
    'https://www.lidl.fr/cdn/assets/logos/brand/lidl-logo-shop-cdn.svg',
    'Lidl logo',
    scoring
  );
  const subBrandLogo = scoreSubBrandLogoAdjustment(
    'https://www.lidl.fr/cdn/assets/logos/brand/parkside-logo.svg',
    'Parkside tools logo',
    scoring
  );
  assert.ok(parentLogo < subBrandLogo, `parent=${String(parentLogo)} sub=${String(subBrandLogo)}`);
  assert.ok(parentLogo <= -100);
});

test('scoreSubBrandLogoAdjustment penalizes NET homonym for Matériel.net', () => {
  const scoring = {
    brandName: 'Matériel.net',
    companyName: 'Matériel.net'
  };
  const homonym = scoreSubBrandLogoAdjustment(
    'https://upload.wikimedia.org/wikipedia/commons/NET_Logo_1970.svg',
    'NET Logo 1970',
    scoring
  );
  const official = scoreSubBrandLogoAdjustment(
    'https://media.materiel.net/logos/logo-site-matnet-homepage.png',
    'materiel.net logo',
    scoring
  );
  assert.ok(homonym < official, `homonym=${String(homonym)} official=${String(official)}`);
});

test('scoreEntertainmentLogoOpusPenalty penalizes Scary Movie 4 logo for Scary Movie 6 / 2026', () => {
  const wrongOpus = scoreEntertainmentLogoOpusPenalty(
    'https://upload.wikimedia.org/wikipedia/commons/Scarymovie4-logo.svg',
    'Scary Movie 4 logo',
    'Scary Movie 6 (2026)'
  );
  const currentTitle = scoreEntertainmentLogoOpusPenalty(
    'https://www.scarymovie.film/assets/scary-movie-6-title.svg',
    'Scary Movie 6 title treatment',
    'Scary Movie 6 (2026)'
  );
  assert.ok(wrongOpus <= -150, `wrongOpus=${String(wrongOpus)}`);
  assert.ok(currentTitle > wrongOpus, `current=${String(currentTitle)} wrong=${String(wrongOpus)}`);
});
