import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const app = path.resolve('release/mac-arm64/Review Studio.app');
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const relativeArchive = 'Contents/Resources/app.asar';
const archive = path.join(app, relativeArchive);
const dmg = `Review-Studio-${pkg.version}-arm64.dmg`;
const hash = (data) => createHash('sha256').update(data).digest('hex');
const roots = new Set([
  'server',
  'desktop',
  'dist',
  'build',
  'node_modules',
  'package.json',
  'LICENSE',
]);
const files = listPackage(archive).map((file) => file.replace(/^\//, ''));
for (const file of files) {
  assert.ok(roots.has(file.split('/')[0]), `Unexpected archive entry: ${file}`);
  assert.ok(
    !/(^|\/)(?:\.env(?:\.|$)|\.review-studio|studio\.sqlite|api-key\.encrypted|app\.pid|responses|worktrees|repositories)(\/|$)|\.(?:sqlite|log|pem|key|p12|pfx)$/.test(
      file,
    ),
    `Private artifact: ${file}`,
  );
  const info = statFile(archive, file);
  if (info.files) continue;
  assert.ok(!info.link, `Unexpected archive symlink: ${file}`);
  const bytes = extractFile(archive, file);
  if (file.startsWith('server/') || file.startsWith('desktop/'))
    assert.ok(bytes.equals(readFileSync(file)), `Packaged source mismatch: ${file}`);
  if (!/\.(?:js|cjs|json|html|css|txt|md)$/.test(file)) continue;
  assert.ok(
    !/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-ant-[A-Za-z0-9_-]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\/(?:Users|home)\/(?!runner(?:\/|\b)|you(?:\/|\b))[^/\s"']+\//.test(
      bytes.toString(),
    ),
    `Possible private content: ${file}`,
  );
}
for (const required of [
  'LICENSE',
  'dist/THIRD_PARTY_LICENSES.txt',
  'desktop/preload.cjs',
  'server/index.js',
])
  assert.ok(files.includes(required), `Missing packaged file: ${required}`);
const bundled = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(bundled.version, pkg.version);
assert.equal(bundled.license, 'MIT');
assert.equal(bundled.main, pkg.main);
execFileSync('hdiutil', ['verify', path.join('release', dmg)], { stdio: 'inherit' });
const mount = mkdtempSync(path.join(os.tmpdir(), 'review-studio-dmg-'));
let mounted = false;
try {
  execFileSync(
    'hdiutil',
    ['attach', path.join('release', dmg), '-readonly', '-nobrowse', '-mountpoint', mount],
    { stdio: 'inherit' },
  );
  mounted = true;
  assert.equal(readlinkSync(path.join(mount, 'Applications')), '/Applications');
  assert.equal(
    hash(readFileSync(path.join(mount, 'Review Studio.app', relativeArchive))),
    hash(readFileSync(archive)),
    'DMG does not contain the tested app',
  );
} finally {
  if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
  rmSync(mount, { recursive: true, force: true });
}
writeFileSync('release/SHA256SUMS', `${hash(readFileSync(path.join('release', dmg)))}  ${dmg}\n`);
console.log(
  `Verified ${files.length} archive entries, source files, licenses, DMG integrity, and checksum. Pattern checks supplement source review; they cannot prove the absence of secrets.`,
);
