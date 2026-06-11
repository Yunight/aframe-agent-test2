import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCollaborationCampaign,
  isDivisionLineBrand,
  resolveCollaborationLogoParties
} from './logo-search-names.mts';

const legoPokemonContext = {
  brandName: 'LEGO® Pokémon™',
  companyName: 'The LEGO Group',
  brandContext:
    'LEGO® Pokémon™ is a multi-year collaboration between The LEGO Group and The Pokémon Company International, launched in 2026.'
};

test('isCollaborationCampaign detects LEGO Pokémon via brandContext', () => {
  assert.equal(isCollaborationCampaign(legoPokemonContext), true);
});

test('resolveCollaborationLogoParties extracts LEGO and Pokémon from brandName', () => {
  assert.deepEqual(resolveCollaborationLogoParties(legoPokemonContext), [ 'LEGO', 'Pokémon' ]);
});

test('Nike Football is a division line, not a collaboration', () => {
  const ctx = {
    brandName: 'Nike Football',
    companyName: 'Nike, Inc.',
    brandContext: 'Football line'
  };
  assert.equal(isDivisionLineBrand(ctx.brandName, ctx.companyName), true);
  assert.equal(isCollaborationCampaign(ctx), false);
});

test('Parkside / Lidl is a sub-brand, not a collaboration', () => {
  const ctx = {
    brandName: 'Parkside',
    companyName: 'Lidl',
    brandContext: 'Lidl house brand for tools'
  };
  assert.equal(isCollaborationCampaign(ctx), false);
});

test('explicit × separator marks collaboration', () => {
  const ctx = {
    brandName: 'Brand A × Brand B',
    companyName: 'Brand A Corp',
    brandContext: 'Joint promo'
  };
  assert.equal(isCollaborationCampaign(ctx), true);
  assert.deepEqual(resolveCollaborationLogoParties(ctx), [ 'Brand A', 'Brand B' ]);
});
