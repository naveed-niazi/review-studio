import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { attentionSnapshot, dismissAttention } from '../server/attention.js';
const { AttentionNotifier, REMINDER_MS } = createRequire(import.meta.url)(
  '../desktop/notifications.cjs',
);
const healthy = { github: { ok: true }, claude: { ok: true }, git: { ok: true } };
const item = (id, kind = 'approval', category = 'attention') => ({
  id,
  kind,
  category,
  title: category === 'connection' ? 'GitHub connection failed' : 'Review is ready for approval',
  page: category === 'connection' ? 'settings' : 'reviews',
});
function harness(saved = {}) {
  let now = 100000,
    persisted;
  const notifications = [],
    badges = [];
  const notifier = new AttentionNotifier({
    clock: () => now,
    saved,
    send: async (n) => {
      notifications.push(n);
      return true;
    },
    badge: (n) => badges.push(n),
    persist: (v) => (persisted = structuredClone(v)),
  });
  const update = (items, connectionsChecked = true) =>
    notifier.update({ items, connectionsChecked });
  return {
    notifier,
    notifications,
    badges,
    update,
    advance: (ms) => (now += ms),
    saved: () => persisted,
  };
}
test('groups startup backlog, keeps badges outstanding, and deduplicates retries across restart', async () => {
  const f = harness();
  f.update([item('private/repo#1'), item('private/repo#2')]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.badges.at(-1), 2);
  assert.doesNotMatch(JSON.stringify(f.notifications), /private/);
  for (let i = 0; i < 20; i++) {
    f.advance(5000);
    await f.notifier.flush();
  }
  assert.equal(f.notifications.length, 1);
  const resumed = harness(f.saved());
  resumed.update([item('private/repo#1'), item('private/repo#2')]);
  await resumed.notifier.flush();
  assert.equal(resumed.notifications.length, 0);
  assert.equal(resumed.badges.at(-1), 2);
  resumed.update([]);
  assert.equal(resumed.badges.at(-1), 0);
});
test('persistent issues remind at 30 minutes, not every retry; reminders can be disabled', async () => {
  const f = harness();
  f.update([item('one')]);
  await f.notifier.flush();
  f.advance(REMINDER_MS - 1);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 1);
  f.advance(1);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 2);
  f.notifier.configure({ notificationReminders: false });
  f.advance(REMINDER_MS);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 2);
});
test('connection problems alert promptly and recovery waits for completed checks', async () => {
  const f = harness();
  f.update([item('one')]);
  await f.notifier.flush();
  f.update([item('one'), item('github', 'connection', 'connection')]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 2);
  f.update([item('one')], false);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 2);
  f.update([item('one')], true);
  await f.notifier.flush();
  assert.equal(f.notifications.at(-1).title, 'Connections restored');
  await f.notifier.flush();
  assert.equal(f.notifications.length, 3);
});
test('notification and badge preferences are independent', async () => {
  const f = harness();
  f.notifier.configure({ notifications: false });
  f.update([item('one')]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 0);
  assert.equal(f.badges.at(-1), 1);
  f.notifier.configure({ attentionBadge: false, notifyAttention: false });
  await f.notifier.flush();
  assert.equal(f.badges.at(-1), 0);
  assert.equal(f.notifications.length, 0);
  f.update([item('github', 'authentication', 'connection')]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 1);
});
test('failed native delivery backs off instead of flooding and does not mark issues delivered', async () => {
  const f = harness();
  let attempts = 0;
  f.notifier.send = async () => {
    attempts++;
    return false;
  };
  f.update([item('one')]);
  await f.notifier.flush();
  for (let i = 0; i < 12; i++) {
    f.advance(5000);
    await f.notifier.flush();
  }
  assert.equal(attempts, 1);
  assert.equal(f.saved(), undefined);
  f.advance(REMINDER_MS);
  await f.notifier.flush();
  assert.equal(attempts, 2);
});
test('only current, enabled, open PRs and real connection failures count', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-attention-'));
  const s = createStore(dir);
  t.after(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  s.db.prepare('INSERT INTO repos(id,path) VALUES (?,?)').run('acme/repo', dir);
  const e = new Engine(s);
  const make = (number, status, result) => {
    const id = e.upsert('acme/repo', {
      number,
      title: 'Private title',
      url: `https://github.com/acme/repo/pull/${number}`,
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      state: 'OPEN',
    });
    const job = s.enqueue(id);
    s.db.prepare('UPDATE jobs SET status=?,result=? WHERE id=?').run(status, result, job);
    return job;
  };
  const first = make(1, 'awaiting_approval', '**Verdict: LGTM**');
  const blocking = make(2, 'published', '**Verdict: BLOCKING**');
  const recovery = make(3, 'failed', null);
  s.db.prepare('UPDATE jobs SET recovery_pending=1 WHERE id=?').run(recovery);
  make(4, 'published', '**Verdict: NON-BLOCKING**');
  const closed = make(5, 'publish_failed', null);
  s.db.prepare("UPDATE prs SET state='CLOSED' WHERE id='acme/repo#5'").run();
  make(6, 'failed', null);
  s.db.prepare("UPDATE prs SET sha='new-head' WHERE id='acme/repo#6'").run();
  const initial = attentionSnapshot(s, healthy);
  assert.equal(initial.count, 2);
  assert.deepEqual(initial.items.map((i) => i.jobId).sort(), [first, recovery].sort());
  // A published verdict stays in review history without creating attention or native alerts.
  assert.deepEqual(
    { ...s.db.prepare('SELECT status,result FROM jobs WHERE id=?').get(blocking) },
    { status: 'published', result: '**Verdict: BLOCKING**' },
  );
  const desktop = harness();
  desktop.notifier.update(initial);
  await desktop.notifier.flush();
  assert.equal(desktop.badges.at(-1), 2);
  assert.equal(desktop.notifications[0].title, '2 items need attention');
  s.enqueue('acme/repo#1');
  assert.equal(attentionSnapshot(s, healthy).count, 1);
  const failedHealth = {
    ...healthy,
    github: { ok: false, issue: { kind: 'dns' }, nextCheckAt: 'later' },
  };
  const snapshot = attentionSnapshot(s, failedHealth);
  assert.equal(snapshot.count, 2);
  assert.match(snapshot.items.find((i) => i.id === 'connection:github').title, /resolved/);
  assert.equal(
    attentionSnapshot(s, { ...healthy, github: { ok: false, checking: true } }).count,
    1,
  );
  s.db.prepare('UPDATE repos SET enabled=0').run();
  assert.equal(attentionSnapshot(s, healthy).count, 0);
  s.db.prepare('UPDATE repos SET enabled=1').run();
  // Completing the remaining failure clears the badge even with blocking reviews on open PRs.
  s.db
    .prepare("UPDATE jobs SET status='published',result='**Verdict: BLOCKING**' WHERE id=?")
    .run(recovery);
  const resolved = attentionSnapshot(s, healthy);
  assert.equal(resolved.count, 0);
  desktop.notifier.update(resolved);
  desktop.advance(REMINDER_MS);
  await desktop.notifier.flush();
  assert.equal(desktop.badges.at(-1), 0);
  assert.equal(desktop.notifications.length, 1);
});

test('new approval rounds and a new outage alert even with reminders off', async () => {
  const f = harness();
  f.notifier.configure({ notificationReminders: false });
  f.update([{ ...item('review:one'), jobId: 'first' }]);
  await f.notifier.flush();
  f.advance(60000);
  f.update([{ ...item('review:one'), jobId: 'second' }]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 2);
  f.update([item('connection:github', 'connection', 'connection')]);
  await f.notifier.flush();
  f.update([]);
  await f.notifier.flush();
  assert.equal(f.notifications.at(-1).title, 'Connections restored');
  f.update([item('connection:github', 'connection', 'connection')]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 5);
});

test('review retries stay quiet but a failure on new code alerts again', async () => {
  const f = harness();
  f.notifier.configure({ notificationReminders: false });
  f.update([{ ...item('review:one', 'review_failed'), generation: 'head-a:main' }]);
  await f.notifier.flush();
  f.advance(60000);
  f.update([]);
  await f.notifier.flush();
  f.update([{ ...item('review:one', 'review_failed'), generation: 'head-a:main' }]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 1);
  f.update([{ ...item('review:one', 'review_failed'), generation: 'head-b:main' }]);
  await f.notifier.flush();
  assert.equal(f.notifications.length, 2);
});

test('dismissals persist, clear badges, and do not hide changed or recurring issues', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-dismiss-'));
  let s = createStore(dir);
  t.after(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  s.db
    .prepare('INSERT INTO repos(id,path,error) VALUES (?,?,?)')
    .run('acme/repo', dir, 'Sync failed');
  const e = new Engine(s);
  const pr = e.upsert('acme/repo', {
    number: 1,
    title: 'Test',
    url: 'https://github.com/acme/repo/pull/1',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    state: 'OPEN',
  });
  const job = s.enqueue(pr);
  s.db
    .prepare("UPDATE jobs SET status='awaiting_approval',result='**Verdict: BLOCKING**' WHERE id=?")
    .run(job);
  const initial = attentionSnapshot(s, healthy);
  assert.equal(initial.count, 2);
  const approval = initial.items.find((i) => i.kind === 'approval');
  dismissAttention(s, initial, [approval.dismissalKey]);
  assert.equal(attentionSnapshot(s, healthy).count, 1);
  assert.equal(s.job(job).status, 'awaiting_approval');
  s.db.close();
  s = createStore(dir);
  assert.equal(attentionSnapshot(s, healthy).count, 1);
  const remaining = attentionSnapshot(s, healthy);
  dismissAttention(
    s,
    remaining,
    remaining.items.map((i) => i.dismissalKey),
  );
  const desktop = harness();
  desktop.notifier.update(attentionSnapshot(s, healthy));
  await desktop.notifier.flush();
  assert.equal(desktop.badges.at(-1), 0);
  assert.equal(desktop.notifications.length, 0);
  const nextJob = s.enqueue(pr);
  s.db.prepare("UPDATE jobs SET status='awaiting_approval' WHERE id=?").run(nextJob);
  const next = attentionSnapshot(s, healthy);
  assert.equal(next.count, 1);
  assert.equal(next.items[0].jobId, nextJob);
  dismissAttention(s, next, [approval.dismissalKey]); // A stale screen cannot dismiss a newer round.
  assert.equal(attentionSnapshot(s, healthy).count, 1);
  s.db.prepare("UPDATE repos SET error='Different failure'").run();
  assert.equal(attentionSnapshot(s, healthy).count, 2);
  s.db.prepare('UPDATE repos SET error=NULL').run();
  attentionSnapshot(s, healthy);
  s.db.prepare("UPDATE repos SET error='Sync failed'").run();
  assert.equal(attentionSnapshot(s, healthy).count, 2);
});

test('dismissing an outage does not announce recovery and a later outage alerts again', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-dismiss-connection-'));
  const s = createStore(dir);
  t.after(async () => {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  const outage = { ...healthy, github: { ok: false, issue: { kind: 'dns' } } };
  const desktop = harness();
  const before = attentionSnapshot(s, outage);
  desktop.notifier.update(before);
  await desktop.notifier.flush();
  dismissAttention(
    s,
    before,
    before.items.map((i) => i.dismissalKey),
  );
  desktop.notifier.update(attentionSnapshot(s, outage));
  await desktop.notifier.flush();
  assert.equal(desktop.badges.at(-1), 0);
  assert.equal(desktop.notifications.length, 1);
  attentionSnapshot(s, { ...outage, github: { ...outage.github, checking: true } });
  assert.equal(attentionSnapshot(s, outage).count, 0);
  desktop.notifier.update(attentionSnapshot(s, healthy));
  await desktop.notifier.flush();
  assert.equal(desktop.notifications.at(-1).title, 'Connections restored');
  desktop.notifier.update(attentionSnapshot(s, outage));
  await desktop.notifier.flush();
  assert.equal(desktop.badges.at(-1), 1);
  assert.equal(desktop.notifications.length, 3);
});
