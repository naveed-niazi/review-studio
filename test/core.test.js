import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { run, parsePR, remoteRepo, claudeResult } from '../server/process.js';
import { renderChecks, validateChecks } from '../server/rules.js';

const a = 'a'.repeat(40),
  b = 'b'.repeat(40);
const result =
  '**Verdict: LGTM**\n\n**Action:** No changes needed.\n\nNo actionable findings. Tests were not executed.';
const output = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result,
  total_cost_usd: 0.12,
});
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-test-')),
    repoPath = path.join(dir, 'repo');
  await mkdir(repoPath);
  const s = createStore(path.join(dir, 'data'));
  s.db.prepare('INSERT INTO repos (id,path) VALUES (?,?)').run('owner/repo', repoPath);
  const e = new Engine(s);
  e.upsert('owner/repo', {
    number: 1,
    title: 'Feature one',
    headRefOid: a,
    url: 'https://github.com/owner/repo/pull/1',
    author: { login: 'developer' },
    state: 'OPEN',
  });
  t.after(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, repoPath, s, e };
}
function fakeCommands({
  head = a,
  author = 'developer',
  resultOutput = output,
  failPost = false,
  existing = [],
  onClaude = () => {},
} = {}) {
  const calls = [];
  const command = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'gh') {
      if (args[0] === 'pr')
        return JSON.stringify({
          number: 1,
          title: 'Feature one',
          headRefOid: head,
          baseRefOid: b,
          baseRefName: 'main',
          url: 'https://github.com/owner/repo/pull/1',
          state: 'OPEN',
          author: { login: author },
          reviews: [],
          comments: [],
        });
      if (args[1] === 'user') return JSON.stringify({ login: 'reviewer' });
      if (args.includes('POST')) {
        if (failPost) throw new Error('HTTP 502');
        return JSON.stringify({
          html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-1',
        });
      }
      return JSON.stringify([existing]);
    }
    if (cmd === 'git') {
      if (args.includes('get-url')) return 'git@github.com:owner/repo.git';
      if (args.includes('rev-parse')) return head;
      if (args.includes('diff')) return '+export const changed = true;';
      return '';
    }
    if (cmd === 'claude') {
      await onClaude(opts);
      return resultOutput;
    }
    throw new Error('Unexpected command ' + cmd);
  };
  return { command, calls };
}
async function drain(e) {
  await e.tick();
  await Promise.all([...e.running.values()].map((c) => c.promise));
}

test('PR input parsing rejects ambiguous or command-like targets', () => {
  assert.deepEqual(parsePR('https://github.com/owner/repo/pull/45/files'), {
    repo: 'owner/repo',
    number: 45,
  });
  assert.deepEqual(parsePR('owner/repo#8'), { repo: 'owner/repo', number: 8 });
  for (const input of [
    'https://evil.com/owner/repo/pull/1',
    'owner/repo#0',
    '../..#2',
    'owner/..#1',
    '--owner/repo#1',
    '--help',
    'owner/repo#1; rm -rf /',
    'https://github.com.evil.com/o/r/pull/1',
  ])
    assert.throws(() => parsePR(input));
  assert.equal(remoteRepo('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(remoteRepo('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(remoteRepo('https://evil.com/owner/repo.git'), undefined);
});
test('Claude success requires a real successful result and valid verdict', () => {
  assert.equal(claudeResult(output).text, result);
  assert.match(
    claudeResult(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '**Verdict: LGTM** — safe to merge.\n\n**Action:** Merge.',
      }),
    ).text,
    /^\*\*Verdict: LGTM\*\* — safe to merge/,
  );
  for (const value of [
    '',
    'Failed to authenticate',
    JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'OAuth expired',
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Looks fine',
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result,
      permission_denials: [{ tool_name: 'Read' }],
    }),
  ])
    assert.throws(() => claudeResult(value));
});
test('queue is deduplicated and reorder validates full current membership', async (t) => {
  const { s, e } = await fixture(t);
  const one = s.enqueue('owner/repo#1', 'Check authentication');
  assert.equal(s.enqueue('owner/repo#1'), one);
  e.upsert('owner/repo', {
    number: 2,
    title: 'Feature two',
    headRefOid: b,
    url: 'https://github.com/owner/repo/pull/2',
  });
  const two = s.enqueue('owner/repo#2');
  s.reorder([two, one]);
  assert.deepEqual(
    s.db
      .prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY position")
      .all()
      .map((j) => j.id),
    [two, one],
  );
  assert.throws(() => s.reorder([one]));
  assert.throws(() => s.reorder([one, one]));
  assert.deepEqual(
    s.db
      .prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY position")
      .all()
      .map((j) => j.id),
    [two, one],
  );
});
test('review snapshots global and repo checks, instructions and policy at enqueue', async (t) => {
  const { s } = await fixture(t);
  s.set('publishPolicy', 'automatic');
  s.set('checks', {
    tests: true,
    analytics: false,
    security: true,
    compatibility: false,
  });
  s.set('instructions', 'Global rule');
  s.db
    .prepare('UPDATE repos SET instructions=?,checks=?')
    .run('Repository rule', JSON.stringify({ analytics: true, tests: false }));
  const id = s.enqueue('owner/repo#1', 'Focus');
  s.set('publishPolicy', 'approval');
  s.set('instructions', 'Changed');
  const job = s.job(id),
    config = JSON.parse(job.config);
  assert.equal(job.policy, 'automatic');
  assert.equal(config.instructions, 'Global rule');
  assert.equal(config.repoInstructions, 'Repository rule');
  assert.deepEqual(config.checks, {
    tests: false,
    analytics: true,
    security: true,
    compatibility: false,
  });
});
test('read-only review succeeds locally and never publishes in approval mode', async (t) => {
  const { s } = await fixture(t);
  const f = fakeCommands();
  const e = new Engine(s, { command: f.command });
  s.set('paused', false);
  const id = s.enqueue('owner/repo#1', 'Check permissions');
  await drain(e);
  const job = s.job(id);
  assert.equal(job.status, 'awaiting_approval');
  assert.equal(job.result, result);
  assert.equal(job.cost, 0.12);
  assert.equal(job.worktree, null);
  assert.ok(!f.calls.some((c) => c.args.includes('POST')));
  const claude = f.calls.find((c) => c.cmd === 'claude');
  assert.ok(claude.args.includes('--safe-mode'));
  assert.ok(claude.args.includes('Read,Grep,Glob'));
  assert.ok(!claude.args.includes('Bash'));
  assert.match(claude.opts.input, /Check permissions/);
  assert.match(claude.opts.input, /Tests accompany feature/);
});
test('stale HEAD fails before Claude and does not publish', async (t) => {
  const { s } = await fixture(t);
  const f = fakeCommands({ head: b });
  const e = new Engine(s, { command: f.command });
  s.set('paused', false);
  const id = s.enqueue('owner/repo#1');
  await drain(e);
  assert.equal(s.job(id).status, 'failed');
  assert.match(s.job(id).error, /changed after/);
  assert.ok(!f.calls.some((c) => c.cmd === 'claude'));
});
test('authentication error pauses the remaining queue', async (t) => {
  const { s } = await fixture(t);
  const f = fakeCommands({
    resultOutput: JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'OAuth token expired',
    }),
  });
  const e = new Engine(s, { command: f.command });
  s.set('paused', false);
  const id = s.enqueue('owner/repo#1');
  await drain(e);
  assert.equal(s.job(id).status, 'failed');
  assert.equal(s.get('paused'), true);
});
test('auto publishing is a separate operation pinned to reviewed commit', async (t) => {
  const { s } = await fixture(t);
  s.set('publishPolicy', 'automatic');
  s.set('paused', false);
  const f = fakeCommands();
  const e = new Engine(s, { command: f.command });
  const id = s.enqueue('owner/repo#1');
  await drain(e);
  assert.equal(s.job(id).status, 'published');
  const post = f.calls.find((c) => c.args.includes('POST'));
  const body = JSON.parse(post.opts.input);
  assert.equal(body.commit_id, a);
  assert.equal(body.event, 'COMMENT');
  assert.match(body.body, new RegExp(`review-studio:${id}`));
});
test('publishing failure retains result and retries reconcile by idempotency marker', async (t) => {
  const { s } = await fixture(t);
  const id = s.enqueue('owner/repo#1');
  s.db.prepare("UPDATE jobs SET status='awaiting_approval',result=? WHERE id=?").run(result, id);
  const failing = new Engine(s, {
    command: fakeCommands({ failPost: true }).command,
  });
  await failing.publish(id);
  assert.equal(s.job(id).status, 'publish_failed');
  assert.equal(s.job(id).result, result);
  const f = fakeCommands({
    existing: [
      {
        body: `${result}\n<!-- review-studio:${id} -->`,
        html_url: 'https://github.com/existing',
      },
    ],
  });
  await new Engine(s, { command: f.command }).publish(id);
  assert.equal(s.job(id).status, 'published');
  assert.ok(!f.calls.some((c) => c.args.includes('POST')));
});
test('publishing refuses stale commits, and duplicate concurrent requests', async (t) => {
  const { s } = await fixture(t);
  const id = s.enqueue('owner/repo#1');
  s.db.prepare("UPDATE jobs SET status='awaiting_approval',result=? WHERE id=?").run(result, id);
  const f = fakeCommands({ head: b });
  await new Engine(s, { command: f.command }).publish(id);
  assert.equal(s.job(id).status, 'publish_failed');
  assert.ok(!f.calls.some((c) => c.args.includes('POST')));
  s.db.prepare("UPDATE jobs SET status='awaiting_approval' WHERE id=?").run(id);
  const f2 = fakeCommands();
  const e = new Engine(s, { command: f2.command });
  const results = await Promise.allSettled([e.publish(id), e.publish(id)]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal(f2.calls.filter((c) => c.args.includes('POST')).length, 1);
});
test('pause prevents jobs starting; cancellation prevents successful completion', async (t) => {
  const { s } = await fixture(t);
  const id = s.enqueue('owner/repo#1');
  let release;
  const pending = new Promise((r) => (release = r));
  const f = fakeCommands({ onClaude: () => pending });
  const e = new Engine(s, { command: f.command });
  await e.tick();
  assert.equal(s.job(id).status, 'queued');
  s.set('paused', false);
  await e.tick();
  e.cancel(id);
  release();
  await Promise.all([...e.running.values()].map((c) => c.promise));
  assert.equal(s.job(id).status, 'cancelled');
  assert.equal(s.job(id).result, null);
});
test('process runner handles cancellation, output limits, and nonzero exits', async () => {
  assert.equal(await run(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)']), /exited 3/);
  await assert.rejects(
    run(process.execPath, ['-e', 'console.log("x".repeat(10000))'], {
      maxBytes: 100,
    }),
    /exceeded/,
  );
  const c = new AbortController();
  const task = run(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
    signal: c.signal,
  });
  c.abort();
  await assert.rejects(task, /Cancelled/);
});
test('rule validation preserves explicit overrides', () => {
  assert.match(renderChecks({ analytics: true }), /Analytics accompany/);
  assert.doesNotMatch(renderChecks({ analytics: true }), /Tests accompany/);
  assert.throws(() => validateChecks({ unknown: true }));
  assert.throws(() => validateChecks({ tests: 'yes' }));
});
test('database restart preserves queue and converts interrupted runs into actionable failures', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let s = createStore(dir);
  s.db.prepare('INSERT INTO repos (id,path) VALUES (?,?)').run('o/r', dir);
  new Engine(s).upsert('o/r', {
    number: 1,
    title: 'test',
    headRefOid: a,
    url: 'https://github.com/o/r/pull/1',
  });
  const id = s.enqueue('o/r#1');
  s.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  s.db.close();
  s = createStore(dir);
  assert.equal(s.job(id).status, 'failed');
  assert.match(s.job(id).error, /App stopped/);
  s.db.close();
});
test('real Git worktree keeps the original checkout unchanged and cleans up', async (t) => {
  const { dir, repoPath, s } = await fixture(t);
  await run('git', ['init', '-b', 'main', repoPath]);
  await run('git', ['-C', repoPath, 'config', 'user.email', 'test@example.invalid']);
  await run('git', ['-C', repoPath, 'config', 'user.name', 'Review Studio Test']);
  await writeFile(path.join(repoPath, 'feature.js'), 'export const value = 1;\n');
  await run('git', ['-C', repoPath, 'add', '.']);
  await run('git', ['-C', repoPath, 'commit', '-m', 'Base']);
  const base = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
  await run('git', ['-C', repoPath, 'checkout', '-b', 'feature']);
  await writeFile(path.join(repoPath, 'feature.js'), 'export const value = 2;\n');
  await run('git', ['-C', repoPath, 'commit', '-am', 'Feature']);
  const head = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
  const remote = path.join(dir, 'remote.git');
  await run('git', ['clone', '--bare', repoPath, remote]);
  await run('git', ['--git-dir', remote, 'update-ref', 'refs/pull/1/head', head]);
  await run('git', ['-C', repoPath, 'remote', 'add', 'origin', remote]);
  await run('git', ['-C', repoPath, 'checkout', 'main']);
  await writeFile(path.join(repoPath, 'untracked.txt'), 'Keep this');
  let reviewed = false;
  const command = async (cmd, args, opts) => {
    if (cmd === 'gh')
      return JSON.stringify({
        number: 1,
        title: 'Real worktree',
        headRefOid: head,
        baseRefOid: base,
        state: 'OPEN',
        url: 'https://github.com/owner/repo/pull/1',
      });
    if (cmd === 'git' && args.includes('get-url')) return 'git@github.com:owner/repo.git';
    if (cmd === 'claude') {
      assert.equal(
        await readFile(path.join(opts.cwd, 'feature.js'), 'utf8'),
        'export const value = 2;\n',
      );
      reviewed = true;
      return output;
    }
    return run(cmd, args, opts);
  };
  const e = new Engine(s, { command });
  e.upsert('owner/repo', {
    number: 1,
    title: 'Real worktree',
    headRefOid: head,
    url: 'https://github.com/owner/repo/pull/1',
  });
  s.set('paused', false);
  const id = s.enqueue('owner/repo#1');
  await drain(e);
  assert.equal(s.job(id).status, 'awaiting_approval', s.job(id).error);
  assert.ok(reviewed);
  assert.equal(
    await readFile(path.join(repoPath, 'feature.js'), 'utf8'),
    'export const value = 1;\n',
  );
  assert.equal(await readFile(path.join(repoPath, 'untracked.txt'), 'utf8'), 'Keep this');
  assert.equal(
    (await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'])).split('worktree ')
      .length,
    2,
  );
});
test('scheduler respects concurrency and explicit queue order', async (t) => {
  const { s, e: seed } = await fixture(t);
  for (const n of [2, 3])
    seed.upsert('owner/repo', {
      number: n,
      title: `Feature ${n}`,
      headRefOid: a,
      url: `https://github.com/owner/repo/pull/${n}`,
    });
  const ids = [1, 2, 3].map((n) => s.enqueue(`owner/repo#${n}`));
  s.reorder([ids[2], ids[0], ids[1]]);
  s.set('concurrency', 2);
  s.set('paused', false);
  let release;
  const waiting = new Promise((r) => (release = r));
  const fake = fakeCommands({ onClaude: () => waiting });
  const e = new Engine(s, { command: fake.command });
  await e.tick();
  assert.equal(e.running.size, 2);
  assert.equal(s.job(ids[2]).status, 'running');
  assert.equal(s.job(ids[0]).status, 'running');
  assert.equal(s.job(ids[1]).status, 'queued');
  s.set('paused', true);
  release();
  await Promise.all([...e.running.values()].map((c) => c.promise));
  await e.tick();
  assert.equal(s.job(ids[1]).status, 'queued');
});
test('automatic discovery skips drafts, reviewed commits and failed jobs', async (t) => {
  const { s } = await fixture(t);
  s.set('autoQueue', true);
  const make = (n) => ({
    number: n,
    title: `PR ${n}`,
    headRefOid: a,
    url: `https://github.com/owner/repo/pull/${n}`,
    updatedAt: new Date().toISOString(),
  });
  const e = new Engine(s, {
    command: async () => JSON.stringify([make(1), { ...make(2), isDraft: true }, make(3), make(4)]),
  });
  e.upsert('owner/repo', make(4));
  const failed = s.enqueue('owner/repo#4');
  s.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failed);
  e.upsert('owner/repo', make(3));
  const published = s.enqueue('owner/repo#3');
  s.db.prepare("UPDATE jobs SET status='published' WHERE id=?").run(published);
  await e.sync();
  const jobs = s.db.prepare("SELECT pr_id FROM jobs WHERE status='queued'").all();
  assert.deepEqual(
    jobs.map((j) => j.pr_id),
    ['owner/repo#1'],
  );
  await e.sync();
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 3);
});
test('blocking findings request changes only on another author’s PR', async (t) => {
  const { s } = await fixture(t);
  const id = s.enqueue('owner/repo#1');
  const blocking = '**Verdict: BLOCKING**\n**Action:** Fix the regression.';
  for (const author of ['developer', 'reviewer']) {
    s.db
      .prepare("UPDATE jobs SET status='awaiting_approval',result=? WHERE id=?")
      .run(blocking, id);
    const fake = fakeCommands({ author });
    await new Engine(s, { command: fake.command }).publish(id);
    const post = fake.calls.find((c) => c.args.includes('POST'));
    assert.equal(
      JSON.parse(post.opts.input).event,
      author === 'reviewer' ? 'COMMENT' : 'REQUEST_CHANGES',
    );
  }
});
test('transient GitHub reads retry, but publishing writes never blindly retry', async (t) => {
  const { s } = await fixture(t);
  let calls = 0;
  const e = new Engine(s, {
    command: async () => {
      calls++;
      if (calls < 3) throw new Error('HTTP 502: Bad Gateway');
      return '{"ok":true}';
    },
  });
  assert.deepEqual(await e.gh(['api', 'user']), { ok: true });
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(e.gh(['api', 'repos/o/r/pulls/1/reviews', '--method', 'POST']), /502/);
  assert.equal(calls, 1);
});
test('commit-age discovery ignores recent comments on old code and caches commit dates', async (t) => {
  const { s } = await fixture(t);
  s.set('autoQueue', true);
  s.set('ageBasis', 'commit');
  let gitReads = 0;
  const make = (n, sha) => ({
    number: n,
    title: `PR ${n}`,
    headRefOid: sha,
    url: `https://github.com/owner/repo/pull/${n}`,
    updatedAt: new Date().toISOString(),
  });
  const e = new Engine(s, {
    command: async (cmd, args) => {
      if (cmd === 'git') {
        gitReads++;
        if (args.at(-1) === b) throw Error('not local');
        return '2020-01-01T00:00:00Z';
      }
      if (args[0] === 'api')
        return JSON.stringify({
          commit: { committer: { date: new Date().toISOString() } },
        });
      return JSON.stringify([make(1, a), make(2, b)]);
    },
  });
  await e.sync();
  assert.deepEqual(
    s.db
      .prepare('SELECT pr_id FROM jobs')
      .all()
      .map((j) => j.pr_id),
    ['owner/repo#2'],
  );
  assert.equal(gitReads, 2);
  await e.sync();
  assert.equal(gitReads, 2);
});
test('default model preserves Claude CLI selection', async (t) => {
  const { s } = await fixture(t);
  s.set('model', 'default');
  s.set('paused', false);
  const id = s.enqueue('owner/repo#1');
  const f = fakeCommands();
  await drain(new Engine(s, { command: f.command }));
  assert.equal(s.job(id).status, 'awaiting_approval');
  assert.ok(!f.calls.find((c) => c.cmd === 'claude').args.includes('--model'));
});
test('completed reviews tolerate introductions and titles without losing content', () => {
  for (const prefix of [
    "I've reviewed the PR context, the full diff, and the relevant source in the checkout. Here's my review.\n\n---\n\n",
    '## Review of owner/repo#1 @ `abc123`\n\n',
  ]) {
    for (const verdict of ['LGTM', 'BLOCKING', 'NON-BLOCKING', 'NON-BLOCKING BUT FIX']) {
      const body = `**Verdict: ${verdict}**\n\n**Action:** Check findings.\n\n- src/auth.js:12: Concrete finding.`;
      const parsed = claudeResult(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: prefix + body,
        }),
      );
      assert.ok(parsed.text.startsWith(`**Verdict: ${verdict}**`));
      assert.ok(parsed.text.includes(prefix.trim()));
      assert.ok(parsed.text.includes('src/auth.js:12: Concrete finding.'));
    }
  }
});
test('verdict normalization rejects ambiguous, quoted, fenced or unsuccessful responses', () => {
  for (const text of [
    'Example:\n\n```markdown\n' + result + '\n```',
    '> **Verdict: LGTM**',
    '**Verdict: LGTM**\n\n**Verdict: BLOCKING**',
    'There is no review verdict.',
  ])
    assert.throws(
      () => claudeResult(JSON.stringify({ type: 'result', subtype: 'success', result: text })),
      /unambiguous/,
    );
  assert.throws(() =>
    claudeResult(
      JSON.stringify({
        type: 'result',
        subtype: 'error',
        result: 'Intro\n\n' + result,
      }),
    ),
  );
  assert.throws(
    () =>
      claudeResult(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          permission_denials: [{ tool_name: 'Read' }],
          result: 'Intro\n\n' + result,
        }),
      ),
    /required tools/,
  );
});
test('raw Claude output survives worktree and context cleanup after validation fails', async (t) => {
  const { s } = await fixture(t);
  s.set('paused', false);
  const invalid = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Incomplete review without a verdict.',
  });
  const f = fakeCommands({ resultOutput: invalid });
  const id = s.enqueue('owner/repo#1');
  await drain(new Engine(s, { command: f.command }));
  assert.equal(s.job(id).status, 'failed');
  assert.equal(await readFile(path.join(s.dir, 'responses', `${id}.jsonl`), 'utf8'), invalid);
  await assert.rejects(readFile(path.join(s.dir, 'context', id, 'pr.json')), /ENOENT/);
  assert.ok(!f.calls.some((c) => c.args.includes('POST')));
});

test('fresh installation has no repository data and requires explicit review activation', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-fresh-'));
  const store = createStore(dir);
  t.after(async () => {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const table of ['repos', 'prs', 'jobs', 'events'])
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(store.get('templates'), undefined);
  assert.equal(store.settings().paused, true);
  assert.equal(store.settings().autoQueue, false);
  assert.equal(store.settings().publishPolicy, 'approval');
  assert.equal(store.settings().onboardingComplete, false);
});
