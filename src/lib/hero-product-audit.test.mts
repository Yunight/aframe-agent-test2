import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssetDescriptionsFile } from './core.mjs';
import {
  auditDistinctProducts,
  deterministicFindingsFromAssetDescriptions,
  isHeroProductCampaign,
  isListingPageCampaign
} from './core.mjs';

function heroProductEntry (assetId: string, name: string): AssetDescriptionsFile['assets'][number] {
  return {
    asset_id: assetId,
    fileName: `${assetId}.jpg`,
    fileType: 'products',
    description: `Lifestyle scene of ${name}`,
    shows_physical_product: true,
    primary_product_name: name,
    is_generic_collection: false,
    layout_hints: [ 'lifestyle' ],
    dominant_colors: [ '#EC1C24', '#FFFFFF' ]
  };
}

const bydDescriptions: AssetDescriptionsFile = {
  generated_at: '2026-01-01T00:00:00.000Z',
  model: 'test',
  assets: [
    heroProductEntry('products/a.jpg', 'BYD SEAL U DM-i'),
    heroProductEntry('products/b.jpg', 'BYD SEAL U DM-i'),
    heroProductEntry('products/c.jpg', 'BYD SEAL U DM-i'),
    heroProductEntry('products/d.jpg', 'BYD SEAL U DM-i'),
    heroProductEntry('products/e.jpg', 'BYD SEAL U DM-i')
  ]
};

const bydFields = {
  campaignContext: 'promotion de la voiture seal u dm i',
  productName: 'BYD SEAL U DM-i',
  brandName: 'BYD France',
  brandURL: 'https://www.byd.com/fr/vehicules-hybrides/seal-u-dm-i',
  campaignReferenceUrl: 'https://www.byd.com/fr/vehicules-hybrides/seal-u-dm-i'
};

describe('isHeroProductCampaign', () => {
  it('detects single-model automotive campaigns', () => {
    assert.equal(isHeroProductCampaign(bydFields), true);
    assert.equal(isListingPageCampaign(bydFields), false);
  });

  it('still detects catalog/listing campaigns', () => {
    const listing = {
      campaignContext: 'collection été Pokémon cartes',
      productName: 'Pokémon TCG',
      brandName: 'Carrefour',
      campaignReferenceUrl: 'https://www.carrefour.fr/s/collection-pokemon'
    };
    assert.equal(isListingPageCampaign(listing), true);
    assert.equal(isHeroProductCampaign(listing), false);
  });
});

describe('auditDistinctProducts', () => {
  it('allows same primary_product_name for hero campaigns', () => {
    const findings = auditDistinctProducts(bydDescriptions, { requireDistinctSkus: false });
    assert.equal(
      findings.some((f) => f.severity === 'blocker' && /same SKU/iu.test(f.issue)),
      false
    );
  });

  it('blocks same SKU for listing campaigns', () => {
    const findings = auditDistinctProducts(bydDescriptions, { requireDistinctSkus: true });
    assert.equal(
      findings.some((f) => f.severity === 'blocker' && /same SKU/iu.test(f.issue)),
      true
    );
  });
});

describe('deterministicFindingsFromAssetDescriptions', () => {
  it('does not require distinct SKUs for hero retail campaigns', () => {
    const findings = deterministicFindingsFromAssetDescriptions(bydDescriptions, 5, {
      profile: 'retail',
      campaignTerms: [ 'seal', 'dm-i', 'byd' ],
      requireDistinctSkus: false
    });
    assert.equal(
      findings.some((f) => f.severity === 'blocker' && /same SKU/iu.test(f.issue)),
      false
    );
  });
});
