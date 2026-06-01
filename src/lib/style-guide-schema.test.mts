import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  fontEffectSchema,
  normalizeFontEffectArray,
  normalizeFontEffectToken,
  sanitizeStyleGuideTypography
} from './style-guide-schema.mts';

test('normalizeFontEffectToken maps case and aliases', () => {
  assert.equal(normalizeFontEffectToken('Bold'), 'bold');
  assert.equal(normalizeFontEffectToken('ITALIC'), 'italic');
  assert.equal(normalizeFontEffectToken('line-through'), 'strikethrough');
  assert.equal(normalizeFontEffectToken('semibold'), 'bold');
});

test('normalizeFontEffectToken drops text-transform and weight-like tokens', () => {
  assert.equal(normalizeFontEffectToken('uppercase'), '__drop__');
  assert.equal(normalizeFontEffectToken('capitalize'), '__drop__');
  assert.equal(normalizeFontEffectToken('normal'), '__drop__');
  assert.equal(normalizeFontEffectToken('medium'), '__drop__');
});

test('normalizeFontEffectArray filters invalid entries', () => {
  assert.deepEqual(normalizeFontEffectArray([ 'bold', 'uppercase' ]), [ 'bold' ]);
  assert.deepEqual(normalizeFontEffectArray([ 'Bold' ]), [ 'bold' ]);
  assert.deepEqual(normalizeFontEffectArray([ 'semibold' ]), [ 'bold' ]);
  assert.deepEqual(normalizeFontEffectArray([]), []);
});

test('fontEffectSchema parses and sanitizes via Zod', () => {
  assert.deepEqual(fontEffectSchema.parse([ 'bold', 'uppercase', 'italic' ]), [ 'bold', 'italic' ]);
  assert.deepEqual(fontEffectSchema.parse([]), []);
});

test('fontEffectSchema is compatible with zodOutputFormat (no transform)', () => {
  const mini = z.object({ fontEffect: fontEffectSchema });
  assert.doesNotThrow(() => {
    zodOutputFormat(mini);
  });
});

test('sanitizeStyleGuideTypography normalizes each row', () => {
  const out = sanitizeStyleGuideTypography({
    brandName: 'X',
    typography: [
      {
        fontFamily: 'Inter',
        fontWeight: 600,
        fontEffect: [ 'bold', 'uppercase' ],
        fontUses: 'headings'
      }
    ]
  });
  assert.deepEqual(out.typography[0]!.fontEffect, [ 'bold' ]);
});
