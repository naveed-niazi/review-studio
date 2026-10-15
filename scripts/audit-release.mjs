import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

// Inspect tracked files and non-ignored candidates, including the index at commit time.
const paths = [
  ...new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const roots = new Set([
  'server',
  'src',
  'desktop',
  'bin',
  'test',
  'scripts',
  'docs',
  'examples',
  '.github',
]);
const rootFiles = new Set([
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
  'index.html',
  'vite.config.js',
  '.gitignore',
  '.prettierignore',
  '.prettierrc.json',
  '.editorconfig',
  '.nvmrc',
]);
const assets = new Set([
  'build/icon.png',
  'build/icon.svg',
  'build/icon.icns',
  'build/trayTemplate.png',
]);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Anthropic credential', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential in URL', /https?:\/\/[^\s/@]+:[^\s/@]+@/],
  ['personal absolute path', /\/(?:Users|home)\/(?!you(?:\/|\b)|runner(?:\/|\b))[^/\s"']+\//],
];
const problems = [];
for (const file of paths) {
  if (!rootFiles.has(file) && !assets.has(file) && !roots.has(file.split('/')[0]))
    problems.push(`${file}: outside publication allowlist`);
  if (
    /(^|\/)(?:node_modules|\.data|\.review-studio|worktrees|responses|repositories|dist|release)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|pem|key|p12|pfx|tgz)$|(^|\/)\.env(?:\.|$)/i.test(
      file,
    )
  )
    problems.push(`${file}: runtime data, credential file, or generated artifact`);
  if (lstatSync(file).isSymbolicLink()) {
    problems.push(`${file}: symlinks must not escape the publication boundary`);
    continue;
  }
  const data = readFileSync(file);
  if (/\.(png|icns)$/.test(file)) {
    if (!assets.has(file) && !/^docs\/screenshots\/[a-z-]+\.png$/.test(file))
      problems.push(`${file}: unapproved binary asset`);
    continue;
  }
  if (data.includes(0)) {
    problems.push(`${file}: unexpected binary file`);
    continue;
  }
  for (const [label, pattern] of patterns)
    if (pattern.test(data.toString('utf8'))) problems.push(`${file}: possible ${label}`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Publication guardrails passed for ${paths.length} files. Inspect the diff and screenshots before pushing; pattern checks cannot prove the absence of sensitive data.`,
  );
