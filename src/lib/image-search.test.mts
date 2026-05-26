import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveImageSearchProvider } from './image-search.mts';

test('resolveImageSearchProvider defaults to brave', () => {
  const prev = process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'];
  delete process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'];
  try {
    assert.equal(resolveImageSearchProvider(), 'brave');
    assert.equal(resolveImageSearchProvider(undefined), 'brave');
  } finally {
    if (prev !== undefined) {
      process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'] = prev;
    }
  }
});

test('resolveImageSearchProvider honors override and env', () => {
  const prev = process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'];
  process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'] = 'anthropic';
  try {
    assert.equal(resolveImageSearchProvider(), 'anthropic');
    assert.equal(resolveImageSearchProvider('brave'), 'brave');
  } finally {
    if (prev !== undefined) {
      process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'] = prev;
    } else {
      delete process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'];
    }
  }
});

test('resolveImageSearchProvider rejects invalid values', () => {
  assert.throws(() => resolveImageSearchProvider('bing'), /Invalid CREATIVE_IMAGE_SEARCH_PROVIDER/u);
});
