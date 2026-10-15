import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateReleaseRef(version, ref) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  assert.equal(ref, `refs/tags/v${version}`, 'Release tag must exactly match package.json version');
  return `v${version}`;
}
export function verifyChecksum(version, manifest, bytes) {
  const filename = `Review-Studio-${version}-arm64.dmg`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    manifest,
    `${digest}  ${filename}\n`,
    'Installer checksum or filename does not match',
  );
  return { filename, digest };
}
function publish() {
  const { GITHUB_REF: ref, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: event } = process.env;
  assert.equal(event, 'push', 'Only version-tag pushes may publish releases');
  assert.match(repository || '', /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const tag = validateReleaseRef(version, ref);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  assert.equal(commit, git('rev-parse', `${tag}^{commit}`));
  git('merge-base', '--is-ancestor', commit, 'origin/main');
  const { filename, digest } = verifyChecksum(
    version,
    readFileSync('release/SHA256SUMS', 'utf8'),
    readFileSync(`release/Review-Studio-${version}-arm64.dmg`),
  );
  assert.ok(process.env.GH_TOKEN, 'GitHub Actions release token is required');
  const gh = (...args) =>
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let existing;
  try {
    existing = JSON.parse(
      gh('release', 'view', tag, '--repo', repository, '--json', 'isDraft,assets'),
    );
  } catch (error) {
    if (!/release not found|HTTP 404/i.test(String(error.stderr))) throw error;
  }
  if (existing) {
    assert.equal(
      existing.isDraft,
      true,
      'This release is already public; publish a new version instead of replacing it',
    );
    assert.ok(
      existing.assets.every((asset) => [filename, 'SHA256SUMS'].includes(asset.name)),
      'Unexpected assets in draft release',
    );
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'review-studio-release-'));
  try {
    const notes = path.join(temporary, 'notes.md');
    writeFileSync(
      notes,
      `## Review Studio ${version} — macOS preview\n\nBuilt and tested by GitHub Actions from commit \`${commit}\`.\n\n### Install\n\nDownload **${filename}**, open the DMG, and drag **Review Studio** into **Applications**. Requires an Apple Silicon Mac (M-series), macOS 13+, Git, GitHub CLI, and a current Claude Code CLI. Node.js is bundled. Existing CLI sign-ins are detected automatically.\n\nThis is an **unsigned, unnotarized preview**. macOS may block its first launch. If you trust this download, follow [Apple’s instructions](https://support.apple.com/en-ie/102445). Start-at-login registration may be unreliable until signing and notarization are configured.\n\n### Verify the download\n\nDownload the accompanying checksum file and run:\n\n\`\`\`sh\nshasum -a 256 -c SHA256SUMS\ngh attestation verify ${filename} --repo ${repository}\n\`\`\`\n\nSHA-256: \`${digest}\`\n\nGitHub provenance verifies the build origin; it does not replace Apple code signing or certify the application’s security.\n\n### Features and limitations\n\nLocal PR dashboard, prioritized reviews, isolated worktrees, custom prompts and repository rules, configurable discovery/concurrency, and approval-based or optional automatic publishing. No personal configuration or repository data is included.\n\nReviews use static analysis and do not run repository tests. Claude Code sends review context to Anthropic. Intel, Windows, and Linux installers are not included. See [setup instructions](https://github.com/${repository}#readme) and [security/dependency notes](https://github.com/${repository}/blob/${commit}/SECURITY.md).\n`,
    );
    if (!existing)
      gh(
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--verify-tag',
        '--draft',
        '--prerelease',
        '--title',
        `Review Studio ${version} — macOS preview`,
        '--notes-file',
        notes,
      );
    else gh('release', 'edit', tag, '--repo', repository, '--notes-file', notes);
    gh(
      'release',
      'upload',
      tag,
      `release/${filename}`,
      'release/SHA256SUMS',
      '--repo',
      repository,
      '--clobber',
    );
    const uploaded = JSON.parse(
      gh('release', 'view', tag, '--repo', repository, '--json', 'assets'),
    );
    const asset = uploaded.assets.find((asset) => asset.name === filename);
    assert.equal(
      asset?.digest,
      `sha256:${digest}`,
      'GitHub asset digest does not match the verified installer',
    );
    assert.equal(uploaded.assets.length, 2, 'Release must contain exactly the verified assets');
    assert.equal(asset.state, 'uploaded');
    const checksumAsset = uploaded.assets.find((asset) => asset.name === 'SHA256SUMS');
    assert.equal(checksumAsset?.state, 'uploaded');
    assert.equal(
      checksumAsset.digest,
      `sha256:${createHash('sha256').update(readFileSync('release/SHA256SUMS')).digest('hex')}`,
      'GitHub checksum asset digest does not match the verified manifest',
    );
    gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease');
    console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  publish();
