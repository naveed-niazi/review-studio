import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { Engine } from '../server/engine.js';
import {
  MergeService,
  mergeConfig,
  validateMergeConfig,
  environmentFor,
  reviewSummary,
  latestReview,
} from '../server/merging.js';
const sha = 'a'.repeat(40),
  base = 'b'.repeat(40);
const config = () => ({
  devBranches: ['dev'],
  prodBranches: ['main'],
  rules: [{ baseBranch: 'dev', verdicts: ['LGTM', 'NON-BLOCKING'], method: 'merge' }],
});
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-merging-'));
  const s = createStore(dir);
  t.after(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  s.db
    .prepare('INSERT INTO repos (id,path,merge_config) VALUES (?,?,?)')
    .run('owner/repo', dir, JSON.stringify(config()));
  const pr = {
    number: 1,
    title: 'Do not classify PROD from this title',
    url: 'https://github.com/owner/repo/pull/1',
    headRefOid: sha,
    baseRefOid: base,
    baseRefName: 'dev',
    headRefName: 'feature/change',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: [],
  };
  new Engine(s).upsert('owner/repo', pr);
  const jobId = s.enqueue('owner/repo#1');
  s.db
    .prepare(
      "UPDATE jobs SET status='published',reviewed_base_branch='dev',result=?,finished_at=? WHERE id=?",
    )
    .run(
      '**Verdict: NON-BLOCKING**\n\n**Action:** Merge with follow-up.\n\nKeep a regression test.',
      new Date().toISOString(),
      jobId,
    );
  s.set('paused', false);
  const repo = {
    permissions: { push: true },
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
  };
  const calls = [];
  const e = {
    closing: false,
    canSync: () => true,
    log: (level, text, id) => s.event(level, text, id),
    gh: async (args, opts) => {
      calls.push({ args, opts });
      if (args.includes('PUT')) return { merged: true, sha: 'c'.repeat(40) };
      return structuredClone(args[0] === 'pr' ? pr : repo);
    },
  };
  const m = new MergeService(s, e);
  const request = { sha, baseBranch: 'dev', reviewId: jobId, method: 'merge' };
  return { s, e, m, pr, repo, calls, jobId, request, dir };
}
const writes = (f) => f.calls.filter((c) => c.args.includes('PUT'));
test('branch labels and automatic rules are exact, explicit, and off by default', () => {
  assert.deepEqual(mergeConfig({}).rules, []);
  assert.equal(environmentFor({ merge_config: JSON.stringify(config()) }, 'dev'), 'DEV');
  assert.equal(environmentFor({ merge_config: JSON.stringify(config()) }, 'main'), 'PROD');
  assert.equal(environmentFor({ merge_config: JSON.stringify(config()) }, 'DEV'), 'OTHER');
  assert.deepEqual(validateMergeConfig(config()), config());
  for (const mutate of [
    (c) => (c.rules[0].verdicts = ['BLOCKING']),
    (c) => (c.rules[0].verdicts = []),
    (c) => (c.rules[0].method = 'admin'),
    (c) => (c.rules[0].baseBranch = '*'),
    (c) => c.rules.push(c.rules[0]),
    (c) => c.prodBranches.push('dev'),
    (c) => (c.devBranches = ['../main']),
  ]) {
    const c = config();
    mutate(c);
    assert.throws(() => validateMergeConfig(c));
  }
});
test('review summaries distinguish stale commits and reject ambiguous verdicts', () => {
  const job = {
    id: 'one',
    sha,
    status: 'published',
    result: '**Verdict: LGTM**\n\n**Action:** Merge.',
  };
  assert.equal(reviewSummary(job, base).current, false);
  assert.equal(reviewSummary(job, sha).action, 'Merge.');
  assert.equal(
    reviewSummary({ ...job, result: job.result + '\n**Verdict: BLOCKING**' }, sha),
    null,
  );
  assert.equal(reviewSummary({ ...job, status: 'failed' }, sha), null);
});
for (const method of ['merge', 'squash', 'rebase'])
  test(`${method} merges only the exact reviewed SHA and records the result`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.m.inspect('owner/repo#1')).reasons.length, 0);
    await f.m.merge('owner/repo#1', { ...f.request, method });
    assert.deepEqual(JSON.parse(writes(f)[0].opts.input), { sha, merge_method: method });
    assert.equal(writes(f).length, 1);
    assert.equal(f.s.db.prepare('SELECT state FROM prs').get().state, 'MERGED');
    assert.equal(f.s.db.prepare('SELECT status FROM merges').get().status, 'merged');
  });
for (const [name, mutate] of [
  [
    'missing reviewed target branch',
    (f) => f.s.db.prepare('UPDATE jobs SET reviewed_base_branch=NULL').run(),
  ],
  ['stale review', (f) => (f.pr.headRefOid = base)],
  ['retargeted branch', (f) => (f.pr.baseRefName = 'main')],
  ['closed PR', (f) => (f.pr.state = 'CLOSED')],
  ['draft', (f) => (f.pr.isDraft = true)],
  ['conflict', (f) => (f.pr.mergeable = 'CONFLICTING')],
  ['unknown mergeability', (f) => (f.pr.mergeable = 'UNKNOWN')],
  ['blocked rules', (f) => (f.pr.mergeStateStatus = 'BLOCKED')],
  ['behind base', (f) => (f.pr.mergeStateStatus = 'BEHIND')],
  ['required review', (f) => (f.pr.reviewDecision = 'REVIEW_REQUIRED')],
  ['requested changes', (f) => (f.pr.reviewDecision = 'CHANGES_REQUESTED')],
  [
    'pending check',
    (f) => (f.pr.statusCheckRollup = [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }]),
  ],
  [
    'failing check',
    (f) =>
      (f.pr.statusCheckRollup = [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      ]),
  ],
  [
    'failing legacy status',
    (f) => (f.pr.statusCheckRollup = [{ __typename: 'StatusContext', state: 'ERROR' }]),
  ],
  ['missing checks', (f) => delete f.pr.statusCheckRollup],
  ['no write permission', (f) => (f.repo.permissions.push = false)],
  ['disabled merge method', (f) => (f.repo.allow_merge_commit = false)],
  ['disabled repository', (f) => f.s.db.prepare('UPDATE repos SET enabled=0').run()],
  [
    'blocking verdict',
    (f) => f.s.db.prepare("UPDATE jobs SET result='**Verdict: BLOCKING**'").run(),
  ],
  [
    'newer failed attempt',
    (f) => {
      const id = f.s.enqueue('owner/repo#1');
      f.s.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(id);
    },
  ],
])
  test(`merge refuses ${name}`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(f.m.merge('owner/repo#1', f.request));
    assert.equal(writes(f).length, 0);
  });
test('manual confirmation cannot be reused for a different latest review', async (t) => {
  const f = await fixture(t);
  const id = f.s.enqueue('owner/repo#1');
  f.s.db
    .prepare(
      "UPDATE jobs SET status='published',reviewed_base_branch='dev',result='**Verdict: LGTM**' WHERE id=?",
    )
    .run(id);
  await assert.rejects(f.m.merge('owner/repo#1', f.request), /review changed/);
  assert.equal(writes(f).length, 0);
});
test('concurrent merge clicks write once', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.m.merge('owner/repo#1', f.request),
    f.m.merge('owner/repo#1', f.request),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(writes(f).length, 1);
});
test('ambiguous network result is durable and never automatically retried; refresh reconciles a merged PR', async (t) => {
  const f = await fixture(t),
    original = f.e.gh;
  f.e.gh = async (args, opts) => {
    const result = await original(args, opts);
    if (args.includes('PUT')) throw new Error('Connection lost');
    return result;
  };
  await assert.rejects(f.m.merge('owner/repo#1', f.request), /Connection lost/);
  assert.equal(f.s.db.prepare('SELECT status FROM merges').get().status, 'unknown');
  await new MergeService(f.s, f.e).tick();
  await assert.rejects(f.m.merge('owner/repo#1', f.request), /unresolved outcome/);
  assert.equal(writes(f).length, 1);
  f.pr.state = 'MERGED';
  await f.m.inspect('owner/repo#1');
  assert.equal(f.s.db.prepare('SELECT status FROM merges').get().status, 'merged');
});
test('an explicit rejection is not treated as a successful merge or blindly retried', async (t) => {
  const f = await fixture(t),
    original = f.e.gh;
  f.e.gh = async (args, opts) => {
    const result = await original(args, opts);
    return args.includes('PUT') ? { merged: false, message: 'Required checks changed' } : result;
  };
  await assert.rejects(f.m.merge('owner/repo#1', f.request), /Required checks changed/);
  assert.equal(f.s.db.prepare('SELECT status FROM merges').get().status, 'failed');
  await f.m.tick();
  assert.equal(writes(f).length, 1);
});
test('automatic merging requires an exact rule, published current review, and a running runner', async (t) => {
  const f = await fixture(t);
  f.s.set('paused', true);
  await f.m.tick();
  assert.equal(writes(f).length, 0);
  f.s.set('paused', false);
  f.s.db.prepare("UPDATE jobs SET status='awaiting_approval'").run();
  await f.m.tick();
  assert.equal(writes(f).length, 0);
  f.s.db
    .prepare("UPDATE jobs SET status='published',result='**Verdict: NON-BLOCKING BUT FIX**'")
    .run();
  await f.m.tick();
  assert.equal(writes(f).length, 0);
  const c = config();
  c.rules[0].verdicts = ['NON-BLOCKING BUT FIX'];
  c.rules[0].method = 'squash';
  f.s.db.prepare('UPDATE repos SET merge_config=?').run(JSON.stringify(c));
  await f.m.tick();
  assert.equal(writes(f).length, 1);
  assert.equal(JSON.parse(writes(f)[0].opts.input).merge_method, 'squash');
  assert.equal(f.s.db.prepare('SELECT automatic FROM merges').get().automatic, 1);
});
test('automatic policy changes while GitHub is loading prevent the write', async (t) => {
  const f = await fixture(t),
    original = f.e.gh;
  f.e.gh = async (args, opts) => {
    const r = await original(args, opts);
    const c = config();
    c.rules = [];
    f.s.db.prepare('UPDATE repos SET merge_config=?').run(JSON.stringify(c));
    return r;
  };
  await f.m.tick();
  assert.equal(writes(f).length, 0);
});
test('blocked automatic merges are rechecked after checks turn green', async (t) => {
  const f = await fixture(t);
  f.pr.mergeStateStatus = 'BLOCKED';
  await f.m.tick();
  assert.equal(writes(f).length, 0);
  assert.ok(f.m.checks.get('owner/repo#1').reasons.length);
  f.pr.mergeStateStatus = 'CLEAN';
  await f.m.tick();
  assert.equal(writes(f).length, 1);
});
test('latest review lookup is not limited by the dashboard job history window', async (t) => {
  const f = await fixture(t);
  for (let n = 2; n < 510; n++) {
    new Engine(f.s).upsert('owner/repo', { ...f.pr, number: n });
    f.s.enqueue(`owner/repo#${n}`);
  }
  assert.equal(latestReview(f.s, 'owner/repo#1').id, f.jobId);
});

test('a retargeted PR cannot reuse its review even with a new matching automatic rule', async (t) => {
  const f = await fixture(t);
  f.pr.baseRefName = 'main';
  const c = config();
  c.rules[0].baseBranch = 'main';
  f.s.db.prepare('UPDATE repos SET merge_config=?').run(JSON.stringify(c));
  await f.m.tick();
  await assert.rejects(
    f.m.merge('owner/repo#1', { ...f.request, baseBranch: 'main' }),
    /target branch/,
  );
  assert.equal(writes(f).length, 0);
});
test('explicit HTTP rejection permits a fresh manual attempt but never an automatic retry', async (t) => {
  const f = await fixture(t),
    original = f.e.gh;
  f.e.gh = async (args, opts) => {
    const result = await original(args, opts);
    if (args.includes('PUT')) throw new Error('gh: Head branch was modified (HTTP 409)');
    return result;
  };
  await assert.rejects(f.m.merge('owner/repo#1', f.request), /HTTP 409/);
  assert.equal(f.s.db.prepare('SELECT status FROM merges').get().status, 'failed');
  await f.m.tick();
  assert.equal(writes(f).length, 1);
  f.e.gh = original;
  await f.m.merge('owner/repo#1', f.request);
  assert.equal(writes(f).length, 2);
});
test('restart retains merge history and marks interrupted requests uncertain', async (t) => {
  const f = await fixture(t);
  f.s.db
    .prepare(
      "INSERT INTO merges (id,pr_id,sha,base_branch,job_id,method,automatic,status,created_at) VALUES ('interrupted','owner/repo#1',?,'dev',?,'merge',1,'merging',?)",
    )
    .run(sha, f.jobId, new Date().toISOString());
  const reopened = createStore(f.dir);
  try {
    assert.equal(reopened.db.prepare('SELECT status FROM merges').get().status, 'unknown');
    await new MergeService(reopened, f.e).tick();
    assert.equal(writes(f).length, 0);
  } finally {
    reopened.db.close();
  }
});
