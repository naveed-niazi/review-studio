import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionMonitor, classifyFailure, retryDelay } from '../server/connections.js';

function fixture(options = {}) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const calls = [],
    failures = {};
  let loggedIn = true,
    persisted;
  const monitor = new ConnectionMonitor({
    clock: () => time,
    random: () => 0,
    command: async (cmd) => {
      calls.push(cmd);
      if (failures[cmd]) throw new Error(failures[cmd]);
      return cmd === 'claude' ? JSON.stringify({ loggedIn, email: 'account@example.com' }) : 'ok';
    },
    probe: async () => ({ github: { reachable: false }, claude: { reachable: false } }),
    persist: (value) => {
      persisted = structuredClone(value);
    },
    ...options,
  });
  return {
    monitor,
    calls,
    failures,
    advance: (ms) => {
      time += ms;
    },
    setAuth: (value) => {
      loggedIn = value;
    },
    saved: () => persisted,
  };
}

test('failure categories distinguish transport, services, credentials and review timeouts', () => {
  for (const [message, provider, kind, retryable] of [
    ['HTTP 503: unavailable', 'github', 'service', true],
    ['API Error: 529 overloaded', 'claude', 'service', true],
    ['Error code: 429', 'claude', 'rate_limit', true],
    ['HTTP 403: API rate limit exceeded', 'github', 'rate_limit', true],
    ["You've hit your limit", 'claude', 'rate_limit', true],
    ['HTTP 401', 'github', 'authentication', false],
    ['gh exited 1: To get started, please run: gh auth login', 'github', 'authentication', false],
    ['claude exited 1: {"loggedIn":false}', 'claude', 'authentication', false],
    ['git exited 128: requested URL returned error: 502', 'github', 'service', true],
    ['OAuth token expired', 'claude', 'authentication', false],
    ['HTTP 429: spending limit reached', 'claude', 'billing', false],
    ['credit balance too low', 'claude', 'billing', false],
    ['ENETUNREACH', 'github', 'local_network', true],
    ['EAI_AGAIN', 'github', 'dns', true],
    ['unexpected EOF', 'github', 'connection', true],
    ['ECONNRESET', 'claude', 'connection', true],
    ['certificate has expired', 'github', 'configuration', false],
    ['spawn claude ENOENT', 'claude', 'configuration', false],
    ['HTTP 403: forbidden', 'github', 'permission', false],
    ['claude timed out after 1800000ms', 'claude', 'review_timeout', false],
    ['Invalid review verdict in oauth change', 'claude', 'unknown', false],
  ]) {
    const issue = classifyFailure(new Error(message), provider);
    assert.equal(issue.kind, kind, message);
    assert.equal(issue.retryable, retryable, message);
  }
  assert.equal(
    classifyFailure(new Error('claude timed out after 15000ms'), 'claude', { health: true }).kind,
    'connection',
  );
});

test('retry delays increase, cap backoff, and never shorten Retry-After', () => {
  const issue = classifyFailure('HTTP 503');
  assert.deepEqual(
    [1, 2, 3, 10].map((n) => retryDelay(issue, n, () => 0)),
    [15000, 30000, 60000, 300000],
  );
  assert.equal(
    retryDelay(issue, 1, () => 0.5),
    16500,
  );
  const limited = classifyFailure('HTTP 429\nRetry-After: 7200');
  assert.equal(
    retryDelay(limited, 1, () => 0),
    7200000,
  );
});

test('transport diagnosis is qualified and recovery waits until due', async () => {
  const f = fixture();
  f.failures.gh = 'unexpected EOF';
  let status = await f.monitor.refresh();
  assert.equal(status.github.issue.kind, 'connection');
  assert.match(status.github.issue.diagnosis, /Neither service endpoint/);
  assert.match(status.github.issue.diagnosis, /wider outage is also possible/);
  assert.equal(f.monitor.ready(), false);
  await f.monitor.refresh();
  assert.equal(f.calls.length, 3);
  delete f.failures.gh;
  f.advance(15000);
  status = await f.monitor.refresh();
  assert.equal(status.github.ok, true);
  assert.equal(f.monitor.ready(), true);
  assert.deepEqual(f.calls, ['gh', 'claude', 'git', 'gh']);
  assert.deepEqual(f.saved(), {});
});

test('one reachable endpoint does not imply a complete local outage; API errors need no probes', async () => {
  let probes = 0;
  const f = fixture({
    probe: async () => {
      probes++;
      return { github: { reachable: false }, claude: { reachable: true, status: 404 } };
    },
  });
  f.failures.gh = 'unexpected EOF';
  await f.monitor.refresh();
  assert.match(
    f.monitor.snapshot().github.issue.diagnosis,
    /not evidence of a complete local internet outage/,
  );
  f.failures.gh = 'HTTP 503';
  await f.monitor.refresh({ force: true });
  assert.equal(f.monitor.snapshot().github.issue.kind, 'service');
  assert.equal(probes, 1);
});

test('health sign-in failures recover after login without manual intervention', async () => {
  const f = fixture();
  f.setAuth(false);
  await f.monitor.refresh();
  assert.equal(f.monitor.snapshot().claude.issue.kind, 'authentication');
  f.setAuth(true);
  f.advance(15000);
  await f.monitor.refresh();
  assert.equal(f.monitor.ready(), true);
});

test('operation credential/billing failures survive restart and local auth metadata until explicit recheck', async () => {
  for (const error of ['API Error: 401 invalid token', 'credit balance too low']) {
    const f = fixture();
    await f.monitor.refresh();
    f.monitor.report(new Error(error), 'claude');
    const restored = fixture({ saved: f.saved() });
    restored.advance(180000);
    await restored.monitor.refresh();
    assert.equal(restored.monitor.ready(), false);
    assert.equal(restored.monitor.snapshot().claude.actionRequired, true);
    assert.ok(!JSON.stringify(restored.saved()).includes('account@example.com'));
    await restored.monitor.refresh({ force: true, retryAccount: true });
    assert.equal(restored.monitor.ready(), true);
  }
});

test('rate limits survive restart and cannot be shortened by force or a later transport failure', async () => {
  const f = fixture();
  f.failures.gh = 'HTTP 429\nRetry-After: 600';
  await f.monitor.refresh();
  const deadline = f.monitor.snapshot().github.nextCheckAt;
  const restored = fixture({ saved: f.saved() });
  restored.monitor.report(new Error('unexpected EOF'), 'github');
  assert.equal(restored.monitor.snapshot().github.nextCheckAt, deadline);
  await restored.monitor.refresh({ force: true, retryAccount: true });
  assert.ok(!restored.calls.includes('gh'));
  assert.equal(restored.monitor.ready(), false);
  restored.advance(600000);
  await restored.monitor.refresh();
  assert.equal(restored.monitor.ready(), true);
});

test('an operation failure arriving during a successful health check wins the race', async () => {
  let finish;
  const f = fixture({
    command: async (cmd) =>
      cmd === 'claude'
        ? new Promise((resolve) => {
            finish = () => resolve('{"loggedIn":true}');
          })
        : 'ok',
  });
  const refresh = f.monitor.refresh();
  f.monitor.report(new Error('API Error: 529'), 'claude');
  finish();
  await refresh;
  assert.equal(f.monitor.snapshot().claude.issue.kind, 'service');
  assert.equal(f.monitor.ready(), false);
});

test('closing cancels health commands and prevents persistence after shutdown', async () => {
  let aborted = 0,
    persisted = 0;
  const f = fixture({
    command: async (_cmd, _args, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted++;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
    persist: () => {
      persisted++;
    },
  });
  const refresh = f.monitor.refresh();
  f.monitor.close();
  await refresh;
  assert.equal(aborted, 3);
  assert.equal(persisted, 0);
});

test('explicit service Retry-After blocks new API requests and forced checks until due', async () => {
  const f = fixture();
  f.failures.gh = 'HTTP 503\nRetry-After: 120';
  await f.monitor.refresh();
  assert.throws(() => f.monitor.assertRequestAllowed('github'), /Retry-After: 120/);
  delete f.failures.gh;
  await f.monitor.refresh({ force: true });
  assert.equal(f.calls.filter((c) => c === 'gh').length, 1);
  f.advance(120000);
  assert.doesNotThrow(() => f.monitor.assertRequestAllowed('github'));
  await f.monitor.refresh();
  assert.equal(f.monitor.ready(), true);
});
