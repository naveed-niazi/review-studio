import { execFileSync } from 'node:child_process';

let failures = 0;
function report(label, ok, hint = '') {
  console.log(`${ok ? 'OK' : 'CHECK'}  ${label}${!ok && hint ? ` — ${hint}` : ''}`);
  if (!ok) failures++;
}
function command(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}
const [major, minor] = process.versions.node.split('.').map(Number);
report(
  'Node.js 22.13+',
  major > 22 || (major === 22 && minor >= 13),
  'Install a supported Node.js release.',
);
report('Git available', command('git', ['--version']) !== null, 'Install Git and add it to PATH.');
const github = command('gh', ['--version']) !== null;
report('GitHub CLI available', github, 'Install from https://cli.github.com/.');
if (github)
  report(
    'GitHub connection',
    command('gh', ['api', 'user', '--jq', '.login']) !== null,
    'Run gh auth login or reconnect in Settings.',
  );
const help = command('claude', ['--help']);
report(
  'Claude Code available',
  help !== null,
  'Install from https://code.claude.com/docs/en/setup.',
);
if (help) {
  report(
    'Required Claude options',
    [
      '--safe-mode',
      '--effort',
      '--tools',
      '--allowedTools',
      '--permission-mode',
      '--output-format',
      '--no-session-persistence',
    ].every((flag) => help.includes(flag)),
    'Update Claude Code before running reviews.',
  );
  let connected = false;
  try {
    connected = JSON.parse(command('claude', ['auth', 'status']) || '{}').loggedIn === true;
  } catch {}
  report(
    'Claude connection',
    connected,
    'Run claude auth login or connect an account/API key in Settings.',
  );
}
console.log('\nNo reviews were run. Account details and credentials are not printed.');
process.exitCode = failures ? 1 : 0;
