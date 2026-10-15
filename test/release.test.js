import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateReleaseRef, verifyChecksum } from '../scripts/publish-release.mjs';

test('releases require an exact version tag, never a branch or mismatched version', () => {
  assert.equal(validateReleaseRef('1.0.0', 'refs/tags/v1.0.0'), 'v1.0.0');
  assert.equal(validateReleaseRef('1.1.0-beta.1', 'refs/tags/v1.1.0-beta.1'), 'v1.1.0-beta.1');
  for (const ref of ['refs/heads/main', 'refs/tags/v2.0.0', 'refs/tags/v1.0.0-other'])
    assert.throws(() => validateReleaseRef('1.0.0', ref));
});

test('release checksum rejects changed binaries, unexpected names, and extra assets', () => {
  const binary = Buffer.from('isolated installer fixture');
  const digest = createHash('sha256').update(binary).digest('hex');
  const manifest = `${digest}  Review-Studio-1.0.0-arm64.dmg\n`;
  assert.equal(verifyChecksum('1.0.0', manifest, binary).digest, digest);
  assert.throws(() => verifyChecksum('1.0.0', manifest, Buffer.from('modified installer')));
  assert.throws(() => verifyChecksum('2.0.0', manifest, binary));
  assert.throws(() => verifyChecksum('1.0.0', manifest + 'extra-file\n', binary));
});
