import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaults = {
  onboardingComplete: false,
  paused: true,
  concurrency: 2,
  publishPolicy: 'approval',
  autoQueue: false,
  syncMinutes: 8,
  maxAgeDays: 15,
  ageBasis: 'activity',
  model: 'sonnet',
  effort: 'medium',
  timeoutMinutes: 30,
  checks: {
    tests: true,
    analytics: false,
    security: true,
    compatibility: false,
  },
  instructions: `Scope
Review high-confidence defects introduced by this PR and directly affected call sites. Omit new stylistic, speculative, and pre-existing issues. Block only for clear regressions, data loss, security issues, or missing coverage essential to changed behavior when the tests check is enabled. Do not expand scope on later rounds.

Continuity
Reconcile all supplied prior feedback against the current code. Keep EVERY unresolved blocking and non-blocking finding, including partially fixed items and small follow-ups. Do not treat an author saying "fixed", a resolved thread, or omission from a later review as proof of a fix. Preserve severity unless new evidence justifies a change; persistence alone does not make a non-blocker blocking. If evidence is missing, say what still needs verification without presenting an assumption as a confirmed defect.

Group prior non-blocking findings once under **Carried over — non-blocking**. Keep unresolved blockers under **Blocking**, marked "Still open". Put new non-blocking findings under **Non-blocking**. Never duplicate a finding across sections. Track prior authors, dates and review IDs internally; do not print them or repeatedly link old comments. Each carried-over item must explain the remaining problem without requiring the reader to open an earlier review.

Writing
Use a short problem title, a precise file:line or symbol, the trigger and impact, and a concrete fix or verification step. Prefer two to four short sentences per finding, using brief sub-bullets only when they improve clarity. Describe what remains wrong after a partial fix, not the full history. Keep enough technical detail for someone to implement the fix. Avoid jargon, long call-chain narratives, raw review/comment IDs, timestamps, round numbers and repeated attribution.

Start with the required verdict and a one-sentence Action that agrees with it. Omit empty sections and "None" bullets. Briefly summarize newly resolved issues only when useful, with a short reason for closure; do not repeat the resolved history on later rounds. State meaningful verification limits once and keep them short. Do not list checks that passed or policies that did not apply. Never shorten a review by dropping unresolved findings; shorten their wording instead.`,
};
export const now = () => new Date().toISOString();
export function createStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const db = new DatabaseSync(path.join(dir, 'studio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, instructions TEXT NOT NULL DEFAULT '', last_sync TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS prs (id TEXT PRIMARY KEY, repo TEXT NOT NULL REFERENCES repos(id), number INTEGER NOT NULL, sha TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, author TEXT, draft INTEGER, created_at TEXT, updated_at TEXT, state TEXT DEFAULT 'OPEN', additions INTEGER DEFAULT 0, deletions INTEGER DEFAULT 0, files INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, pr_id TEXT NOT NULL REFERENCES prs(id), sha TEXT NOT NULL, status TEXT NOT NULL, position INTEGER NOT NULL, instructions TEXT NOT NULL DEFAULT '', policy TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, phase TEXT, result TEXT, error TEXT, published_url TEXT, cost REAL, worktree TEXT);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, position);
    CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS one_live_job ON jobs(pr_id) WHERE status IN ('queued','running','publishing');`);
  for (const [table, columns] of Object.entries({
    prs: {
      base_branch: "TEXT NOT NULL DEFAULT ''",
      head_branch: "TEXT NOT NULL DEFAULT ''",
    },
    repos: {
      managed: 'INTEGER NOT NULL DEFAULT 0',
      archived: 'INTEGER NOT NULL DEFAULT 0',
      checks: "TEXT NOT NULL DEFAULT '{}'",
    },
    jobs: { config: 'TEXT' },
  })) {
    const existing = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
    for (const [column, definition] of Object.entries(columns))
      if (!existing.includes(column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  const get = (key) => {
    const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return r ? JSON.parse(r.value) : defaults[key];
  };
  const set = (key, value) =>
    db
      .prepare(
        'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  const event = (level, message, jobId = null) =>
    db
      .prepare('INSERT INTO events (job_id,level,message,created_at) VALUES (?,?,?,?)')
      .run(jobId, level, message, now());
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  // Never retry an interrupted publish automatically: GitHub may have accepted it.
  db.prepare(
    "UPDATE jobs SET status='failed', error='App stopped during review. Retry when ready.', finished_at=? WHERE status='running'",
  ).run(now());
  db.prepare(
    "UPDATE jobs SET status='publish_failed', error='App stopped during publishing. Verify GitHub before retrying.', finished_at=? WHERE status='publishing'",
  ).run(now());
  const settings = () => Object.fromEntries(Object.keys(defaults).map((k) => [k, get(k)]));
  const job = (id) =>
    db
      .prepare(
        `SELECT j.*, p.repo,p.number,p.title,p.url,p.author,p.additions,p.deletions,p.files,p.base_branch,p.head_branch,p.sha AS current_sha FROM jobs j JOIN prs p ON p.id=j.pr_id WHERE j.id=?`,
      )
      .get(id);
  const enqueue = (prId, instructions = '') => {
    const pr = db.prepare('SELECT * FROM prs WHERE id=?').get(prId);
    if (!pr || pr.state !== 'OPEN') throw new Error('Choose an open pull request.');
    const repo = db.prepare('SELECT * FROM repos WHERE id=?').get(pr.repo);
    if (!repo.enabled) throw new Error('Enable this repository before adding reviews.');
    if (!existsSync(repo.path))
      throw new Error('Local repository is missing. Update its path in Repositories.');
    const active = db
      .prepare("SELECT id FROM jobs WHERE pr_id=? AND status IN ('queued','running','publishing')")
      .get(prId);
    if (active) return active.id;
    const id = randomUUID(),
      position = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS n FROM jobs').get().n;
    db.prepare(
      'INSERT INTO jobs (id,pr_id,sha,status,position,instructions,policy,model,effort,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      prId,
      pr.sha,
      'queued',
      position,
      instructions,
      get('publishPolicy'),
      get('model'),
      get('effort'),
      now(),
    );
    const config = {
      instructions: get('instructions'),
      repoInstructions: repo.instructions,
      checks: { ...get('checks'), ...JSON.parse(repo.checks || '{}') },
    };
    db.prepare('UPDATE jobs SET config=? WHERE id=?').run(JSON.stringify(config), id);
    event('info', `Queued ${prId}`, id);
    return id;
  };
  const reorder = (ids) =>
    transaction(() => {
      const queued = db
        .prepare("SELECT id FROM jobs WHERE status='queued'")
        .all()
        .map((x) => x.id);
      if (
        ids.length !== queued.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !queued.includes(id))
      )
        throw new Error('Queue changed. Refresh and try again.');
      ids.forEach((id, i) => db.prepare('UPDATE jobs SET position=? WHERE id=?').run(i, id));
    });
  return {
    db,
    dir,
    get,
    set,
    settings,
    event,
    transaction,
    job,
    enqueue,
    reorder,
  };
}
