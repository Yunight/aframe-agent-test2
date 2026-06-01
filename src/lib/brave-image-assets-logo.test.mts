import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLogoSearchQueries,
  scoreCampaignLogoAdjustment
} from './brave-image-assets.mts';

test('buildLogoSearchQueries prepends expansion queries when product differs from brand', () => {
  const queries = buildLogoSearchQueries({
    brandName: 'Diablo IV',
    companyName: 'Blizzard Entertainment',
    productName: 'Diablo IV: Lord of Hatred',
    brandURL: 'https://diablo4.blizzard.com/',
    companyURL: 'https://www.blizzard.com/',
    campaignReferenceUrl: 'https://diablo4.blizzard.com/en-us/lord-of-hatred',
    logoImageSearchQueries: [],
    productImageSearchQueries: []
  });
  assert.ok(queries.some((q) => /Lord of Hatred.*logo/iu.test(q)));
  assert.ok(queries.some((q) => /site:diablo4\.blizzard\.com.*lord of hatred logo/iu.test(q)));
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
