import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isDivisionLineBrand,
  isIndependentSubBrand,
  resolveBrandLogoRelationship,
  resolveLogoSearchNames,
  scoreSubBrandLogoAdjustment
} from './core.mjs';

describe('resolveBrandLogoRelationship', () => {
  it('classifies same brand', () => {
    assert.equal(resolveBrandLogoRelationship('BYD', 'BYD'), 'same');
    assert.equal(isDivisionLineBrand('BYD', 'BYD'), false);
    assert.equal(isIndependentSubBrand('BYD', 'BYD'), false);
  });

  it('classifies regional / division arms as division_line', () => {
    assert.equal(resolveBrandLogoRelationship('BYD France', 'BYD'), 'division_line');
    assert.equal(resolveBrandLogoRelationship('Nike Football', 'Nike'), 'division_line');
    assert.equal(isDivisionLineBrand('BYD France', 'BYD'), true);
    assert.equal(isIndependentSubBrand('BYD France', 'BYD'), false);
  });

  it('classifies independent sub-brands', () => {
    assert.equal(resolveBrandLogoRelationship('Parkside', 'Lidl'), 'independent_sub_brand');
    assert.equal(resolveBrandLogoRelationship('Peugeot', 'Stellantis'), 'independent_sub_brand');
    assert.equal(isIndependentSubBrand('Parkside', 'Lidl'), true);
    assert.equal(isDivisionLineBrand('Parkside', 'Lidl'), false);
  });

  it('uses company stem for noisy legal entity names', () => {
    assert.equal(
      resolveBrandLogoRelationship('Walt Disney World', 'The Walt Disney Company'),
      'division_line'
    );
  });
});

describe('resolveLogoSearchNames', () => {
  const base = { productName: 'test product' };

  it('returns parent only for division lines', () => {
    assert.deepEqual(
      resolveLogoSearchNames({ ...base, brandName: 'BYD France', companyName: 'BYD' }),
      [ 'BYD' ]
    );
    assert.deepEqual(
      resolveLogoSearchNames({ ...base, brandName: 'Nike Football', companyName: 'Nike' }),
      [ 'Nike' ]
    );
  });

  it('returns both names for independent sub-brands', () => {
    assert.deepEqual(
      resolveLogoSearchNames({ ...base, brandName: 'Parkside', companyName: 'Lidl' }),
      [ 'Parkside', 'Lidl' ]
    );
  });

  it('returns single name when brand equals company', () => {
    assert.deepEqual(
      resolveLogoSearchNames({ ...base, brandName: 'BYD', companyName: 'BYD' }),
      [ 'BYD' ]
    );
  });
});

describe('scoreSubBrandLogoAdjustment', () => {
  it('does not penalize parent logo for division/regional arms', () => {
    const adjust = scoreSubBrandLogoAdjustment(
      'https://upload.wikimedia.org/wikipedia/commons/e/e2/BYD_Auto_2022_logo.svg',
      'BYD Auto 2022 logo',
      { brandName: 'BYD France', companyName: 'BYD' }
    );
    assert.equal(adjust, 0);
  });

  it('penalizes parent-only logo for independent sub-brands', () => {
    const adjust = scoreSubBrandLogoAdjustment(
      'https://example.com/lidl-logo.svg',
      'Lidl official logo',
      { brandName: 'Parkside', companyName: 'Lidl' }
    );
    assert.ok(adjust < 0);
  });
});
