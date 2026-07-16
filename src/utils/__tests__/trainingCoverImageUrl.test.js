import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshTrainingCoverImageUrl,
  refreshTrainingModuleCoverImages,
  TRAINING_COVER_IMAGE_PRESIGN_TTL_SEC,
} from '../trainingCoverImageUrl.js';

test('refreshTrainingCoverImageUrl skips when cover image has no S3 key', async () => {
  const coverImage = { url: 'https://example.com/stale.jpg' };
  await refreshTrainingCoverImageUrl(coverImage, async () => {
    throw new Error('should not sign');
  });
  assert.equal(coverImage.url, 'https://example.com/stale.jpg');
});

test('refreshTrainingCoverImageUrl replaces url with fresh presigned url', async () => {
  const coverImage = { key: 'training-module-cover-images/abc.png', url: 'https://s3/stale' };
  await refreshTrainingCoverImageUrl(coverImage, async (key, ttl) => {
    assert.equal(key, 'training-module-cover-images/abc.png');
    assert.equal(ttl, TRAINING_COVER_IMAGE_PRESIGN_TTL_SEC);
    return 'https://s3/fresh?sig=new';
  });
  assert.equal(coverImage.url, 'https://s3/fresh?sig=new');
});

test('refreshTrainingModuleCoverImages refreshes every module with a key', async () => {
  const modules = [
    { coverImage: { key: 'a', url: 'stale-a' } },
    { coverImage: { url: 'external-only' } },
    { coverImage: { key: 'b', url: 'stale-b' } },
  ];
  const signedKeys = [];
  await refreshTrainingModuleCoverImages(modules, async (key) => {
    signedKeys.push(key);
    return `https://s3/${key}`;
  });
  assert.deepEqual(signedKeys, ['a', 'b']);
  assert.equal(modules[0].coverImage.url, 'https://s3/a');
  assert.equal(modules[1].coverImage.url, 'external-only');
  assert.equal(modules[2].coverImage.url, 'https://s3/b');
});
