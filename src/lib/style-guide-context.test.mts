import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductMatchTerms,
  extractCampaignContextFromPrompt,
  scoreProductContextRelevance
} from './style-guide-context.mts';

test('extractCampaignContextFromPrompt', () => {
  assert.equal(
    extractCampaignContextFromPrompt('The brand is BYD and the context is the new SEAL U SUV launch'),
    'the new SEAL U SUV launch'
  );
});

test('buildProductMatchTerms prioritizes product name', () => {
  const terms = buildProductMatchTerms({
    campaignContext: 'the new EV GTI 208 they are launching',
    productName: '208 GTI',
    brandName: 'Peugeot',
    brandURL: 'https://www.peugeot.fr/modeles/208-gti'
  });
  assert.ok(terms.some((t) => /208/iu.test(t)));
  assert.ok(terms[0]!.toLowerCase().includes('208') || terms[0]!.toLowerCase().includes('gti'));
});

test('scoreProductContextRelevance penalizes wrong BYD model', () => {
  const terms = buildProductMatchTerms({
    campaignContext: 'promoting the SEAL U family SUV',
    productName: 'BYD SEAL U',
    brandName: 'BYD Auto',
    brandURL: 'https://www.byd.com/fr/voitures-electriques/seal-u'
  });
  const sealU = scoreProductContextRelevance(
    'https://www.byd.com/material/seal_u_maggio.webp',
    'SEAL U promo',
    terms
  );
  const sealion = scoreProductContextRelevance(
    'https://www.byd.com/material/byd-sealion-7-1stBanner-xl.jpg',
    'Sealion 7',
    terms
  );
  assert.ok(sealU > sealion);
});
