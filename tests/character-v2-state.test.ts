import test from 'node:test';
import assert from 'node:assert/strict';
import { characterAssetFor } from '../apps/web/src/components/Avatar.js';

test('the current listening, preparation and paused states override an earlier happy reply', () => {
  for (const expression of ['warm', 'thoughtful', 'happy', 'calm'] as const) {
    for (const state of ['connecting', 'listening'] as const) assert.equal(characterAssetFor(state, expression), 'neutral');
    assert.equal(characterAssetFor('processing', expression), 'thoughtful');
    for (const state of ['paused', 'ended'] as const) assert.equal(characterAssetFor(state, expression), 'calm');
  }
});

test('reply expression is used only during speaking; welcome keeps the requested presentation size', () => {
  assert.equal(characterAssetFor('speaking', 'happy'), 'happy');
  assert.equal(characterAssetFor('speaking', 'calm'), 'calm');
  assert.equal(characterAssetFor('idle', 'happy', 'portrait'), 'welcome');
  assert.equal(characterAssetFor('idle', 'calm', 'full'), 'full-welcome');
});
