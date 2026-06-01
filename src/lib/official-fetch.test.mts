import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRetryImageMetadataWithGet } from './official-fetch.mts';

test('shouldRetryImageMetadataWithGet', () => {
  assert.equal(shouldRetryImageMetadataWithGet(401), true);
  assert.equal(shouldRetryImageMetadataWithGet(403), true);
  assert.equal(shouldRetryImageMetadataWithGet(405), true);
  assert.equal(shouldRetryImageMetadataWithGet(404), false);
});
