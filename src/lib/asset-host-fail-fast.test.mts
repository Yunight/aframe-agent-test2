import assert from 'node:assert/strict';
import test from 'node:test';
import { AssetHostFailureTracker } from './asset-host-fail-fast.mts';

test('AssetHostFailureTracker blocks host after threshold failures', () => {
  const tracker = new AssetHostFailureTracker(2);
  const url = 'https://www.example.com/a.jpg';
  assert.equal(tracker.isBlocked(url), false);
  assert.equal(tracker.recordFailure(url), false);
  assert.equal(tracker.isBlocked(url), false);
  assert.equal(tracker.recordFailure(url), true);
  assert.equal(tracker.isBlocked(url), true);
});
