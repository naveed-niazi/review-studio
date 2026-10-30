import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { realpath, stat, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createStore, defaults, now } from './store.js';
import { validateChecks } from './rules.js';
import {
  MergeService,
  mergeConfig,
  latestReview,
  reviewSummary,
  environmentFor,
  validateMergeConfig,
} from './merging.js';
import { Engine } from './engine.js';
import { attentionSnapshot } from './attention.js';
import { ConnectionMonitor } from './connections.js';
import { run, parsePR, remoteRepo, abortAllProcesses, isRepository } from './process.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(
  process.env.REVIEW_STUDIO_DATA || path.join(os.homedir(), '.review-studio'),
);
const port = Number(process.env.REVIEW_STUDIO_PORT || 8790);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lock = path.join(dataDir, 'app.pid');
try {
  const pid = Number(readFileSync(lock, 'utf8'));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (e) {
    if (e.code === 'EPERM') alive = true;
  }
  if (alive)
    throw new Error(`Review Studio is already running (PID ${pid}). Open http://127.0.0.1:${port}`);
  unlinkSync(lock);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
process.on('exit', () => {
  try {
    if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
  } catch {}
});
const store = createStore(dataDir);
const operations = new Map();
const app = express(),
  token = randomBytes(32).toString('hex'),
  clients = new Set();
let apiKey = process.env.REVIEW_STUDIO_API_KEY || '',
  notifyTimer,
  healthCache = null,
  authSession = null;
delete process.env.REVIEW_STUDIO_API_KEY;
function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const client of clients) client.write('data: changed\n\n');
  }, 350);
}
const connections = new ConnectionMonitor({
  env: () => (apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
  notify,
  event: (level, message) => store.event(level, message),
  saved: store.get('connectionRecovery') || {},
  persist: (value) => store.set('connectionRecovery', value),
});
const engine = new Engine(store, {
  canRun: () => connections.ready(),
  beforeGithub: () => connections.assertRequestAllowed('github'),
  canSync: () => connections.snapshot().github.ok,
  reportFailure: (error, provider, retryAt) => {
    connections.report(error, provider, retryAt);
    healthCache = { ...connections.snapshot(), apiKeySet: !!apiKey };
  },
  notify,
  env: () => (apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
});
const merging = new MergeService(store, engine, { notify });
function attention() {
  return attentionSnapshot(store, connections.snapshot(), operations.values());
}
function sendAttention() {
  process.parentPort?.postMessage({ type: 'attention', snapshot: attention() });
}
const attentionHeartbeat = setInterval(sendAttention, 5000);
attentionHeartbeat.unref();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
    return res.status(403).json({ error: 'Local connections only.' });
  if (req.headers.origin && req.headers.origin !== `http://${host}`)
    return res.status(403).json({ error: 'Origin is not allowed.' });
  if (req.headers['sec-fetch-site'] === 'cross-site')
    return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-studio-token'] !== token)
    return res.status(403).json({ error: 'Refresh the app and try again.' });
  next();
});
app.use(express.json({ limit: '1mb' }));
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    next(e);
  }
};
const text = (value, max = 20000) => {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`Expected text of at most ${max} characters.`);
  return value;
};
const integer = (value, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected an integer between ${min} and ${max}.`);
  return value;
};
const choice = (value, choices) => {
  if (!choices.includes(value)) throw new Error(`Choose one of ${choices.join(', ')}.`);
  return value;
};
const boolean = (value) => {
  if (typeof value !== 'boolean') throw new Error('Expected true or false.');
  return value;
};
async function health(options) {
  healthCache = { ...(await connections.refresh(options)), apiKeySet: !!apiKey };
  return healthCache;
}
app.get('/api/session', (_req, res) => res.json({ token }));
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  });
  res.flushHeaders();
  res.write('data: connected\n\n');
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});
app.get('/api/state', (_req, res) =>
  res.json({
    settings: store.settings(),
    attention: attention(),
    repos: store.db.prepare('SELECT * FROM repos WHERE archived=0 ORDER BY id').all(),
    mergeChecks: Object.fromEntries(merging.checks),
    merges: store.db.prepare('SELECT * FROM merges ORDER BY rowid DESC LIMIT 100').all(),
    prs: store.db
      .prepare(
        `SELECT p.*, EXISTS(SELECT 1 FROM jobs j WHERE j.pr_id=p.id AND j.sha=p.sha AND j.status IN ('awaiting_approval','published','publish_failed','publishing')) AS reviewed FROM prs p JOIN repos r ON r.id=p.repo WHERE p.state='OPEN' AND r.enabled=1 ORDER BY p.updated_at DESC`,
      )
      .all()
      .map((pr) => ({
        ...pr,
        review: reviewSummary(latestReview(store, pr.id), pr.sha, pr.base_branch),
        environment: environmentFor(
          store.db.prepare('SELECT * FROM repos WHERE id=?').get(pr.repo),
          pr.base_branch,
        ),
      })),
    jobs: store.db
      .prepare(
        `SELECT j.id,j.pr_id,j.sha,j.status,j.position,j.instructions,j.policy,j.model,j.effort,j.created_at,j.started_at,j.finished_at,j.phase,j.error,j.published_url,j.cost,j.retry_count,j.retry_at,j.failure_kind,j.failure_provider,j.recovery_check_at,j.recovery_note,j.recovery_pending,j.recovery_count,p.state AS pr_state,p.repo,p.number,p.title,p.url,p.author,p.base_branch,p.head_branch,p.sha AS current_sha FROM jobs j JOIN prs p ON p.id=j.pr_id WHERE j.status IN ('queued','running','publishing') OR j.id IN (SELECT id FROM jobs ORDER BY created_at DESC LIMIT 500) ORDER BY j.created_at DESC`,
      )
      .all(),
    events: store.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 120').all(),
    templates: store.get('templates') || [],
    operations: [...operations.values()],
    syncing: engine.syncing,
    lastSync: store.get('lastSync') || null,
    health: healthCache,
    dataDir,
  }),
);
app.get(
  '/api/health',
  wrap(async (_req, res) => res.json(await health({ force: true, retryAccount: true }))),
);
app.post('/api/sync', (_req, res) => {
  void engine.sync().catch((e) => engine.log('error', e.message));
  res.status(202).json({ ok: true });
});
app.patch(
  '/api/settings',
  wrap(async (req, res) => {
    const validators = {
      onboardingComplete: boolean,
      checks: validateChecks,
      paused: boolean,
      concurrency: (v) => integer(v, 1, 6),
      publishPolicy: (v) => choice(v, ['approval', 'automatic']),
      autoQueue: boolean,
      syncMinutes: (v) => integer(v, 1, 120),
      maxAgeDays: (v) => integer(v, 1, 365),
      ageBasis: (v) => choice(v, ['activity', 'commit']),
      model: (v) => {
        text(v, 100);
        if (!/^[a-zA-Z0-9._:-]+$/.test(v)) throw new Error('Invalid model name.');
        return v;
      },
      effort: (v) => choice(v, ['low', 'medium', 'high', 'xhigh', 'max']),
      timeoutMinutes: (v) => integer(v, 1, 120),
      stallMinutes: (v) => integer(v, 2, 30),
      autoRetryFailed: boolean,
      retryFailedMinutes: (v) => integer(v, 2, 120),
      instructions: (v) => text(v, 50000),
    };
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      if (!validators[key]) throw new Error('Unknown setting.');
      validators[key](value);
    }
    if (req.body.paused === false) await health({ force: true, retryAccount: true });
    store.transaction(() => {
      for (const [key, value] of entries) store.set(key, value);
    });
    notify();
    res.json(store.settings());
  }),
);
app.put(
  '/api/templates',
  wrap(async (req, res) => {
    if (!Array.isArray(req.body.templates) || req.body.templates.length > 50)
      throw new Error('Use up to 50 prompt templates.');
    const templates = req.body.templates.map((t) => ({
      id: text(t.id, 100),
      name: text(t.name, 100),
      body: text(t.body, 20000),
    }));
    store.set('templates', templates);
    notify();
    res.json({ ok: true });
  }),
);
app.post(
  '/api/repos',
  wrap(async (req, res) => {
    const id = text(req.body.id, 200).trim(),
      localPath = await realpath(text(req.body.path, 2000).replace(/^~(?=\/)/, os.homedir()));
    if (!isRepository(id)) throw new Error('Use owner/repository.');
    if (!(await stat(localPath)).isDirectory())
      throw new Error('Choose a local repository directory.');
    const remote = await run('git', ['-C', localPath, 'remote', 'get-url', 'origin']);
    if (remoteRepo(remote)?.toLowerCase() !== id.toLowerCase())
      throw new Error('The local repository origin must match the GitHub repository.');
    store.db
      .prepare(
        'INSERT INTO repos (id,path) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET managed=CASE WHEN repos.path=excluded.path THEN repos.managed ELSE 0 END,path=excluded.path,error=NULL,archived=0,enabled=1',
      )
      .run(id, localPath);
    notify();
    res.json({ ok: true });
  }),
);

app.get(
  '/api/github/repos',
  wrap(async (req, res) => {
    const owner = text(String(req.query.owner || healthCache?.github?.output || ''), 100).trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(owner))
      throw new Error('Enter a GitHub username or organization.');
    const repos = await engine.gh([
      'repo',
      'list',
      owner,
      '--limit',
      '1000',
      '--json',
      'nameWithOwner,description,isPrivate,isArchived',
    ]);
    const connected = new Set(
      store.db
        .prepare('SELECT id FROM repos WHERE archived=0')
        .all()
        .map((r) => r.id),
    );
    res.json(
      repos
        .filter((r) => !r.isArchived)
        .map((r) => ({ ...r, connected: connected.has(r.nameWithOwner) })),
    );
  }),
);
app.post(
  '/api/repos/clone',
  wrap(async (req, res) => {
    const id = text(req.body.id, 200).trim(),
      instructions = text(req.body.instructions || '', 50000),
      checks = validateChecks(req.body.checks || {});
    if (!isRepository(id)) throw new Error('Use owner/repository.');
    if (store.db.prepare('SELECT id FROM repos WHERE id=? AND archived=0').get(id))
      throw new Error('This repository is already connected.');
    const managed = !req.body.path;
    const destination = path.resolve(
      req.body.path
        ? text(req.body.path, 2000).replace(/^~(?=\/)/, os.homedir())
        : path.join(dataDir, 'repositories', id),
    );
    if ([...operations.values()].some((o) => o.path === destination && o.status === 'running'))
      throw new Error('This repository is already being cloned.');
    try {
      await stat(destination);
      throw new Error(
        'Destination already exists. Use an existing local clone or choose an empty destination.',
      );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const operation = {
      id: randomBytes(8).toString('hex'),
      repo: id,
      path: destination,
      status: 'running',
      message: 'Cloning repository…',
    };
    operations.set(operation.id, operation);
    void (async () => {
      try {
        await mkdir(path.dirname(destination), { recursive: true });
        await run('gh', ['repo', 'clone', id, destination], {
          timeout: 20 * 60000,
        });
        store.db
          .prepare(
            'INSERT INTO repos (id,path,instructions,managed,checks) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,instructions=excluded.instructions,managed=excluded.managed,checks=excluded.checks,archived=0,enabled=1,error=NULL',
          )
          .run(id, destination, instructions, +managed, JSON.stringify(checks));
        operation.status = 'complete';
        operation.message = 'Repository cloned and connected';
        engine.log('success', `Cloned ${id} to ${destination}`);
        void engine.sync();
      } catch (e) {
        operation.status = 'failed';
        operation.message = e.message;
        engine.log('error', `Clone failed for ${id}: ${e.message}`);
      } finally {
        notify();
      }
    })();
    notify();
    res.status(202).json({ id: operation.id });
  }),
);
app.post(
  '/api/repos/remove',
  wrap(async (req, res) => {
    const id = text(req.body.id, 200),
      repo = store.db.prepare('SELECT * FROM repos WHERE id=? AND archived=0').get(id);
    if (!repo) throw new Error('Repository not found.');
    if (
      store.db
        .prepare(
          "SELECT j.id FROM jobs j JOIN prs p ON p.id=j.pr_id WHERE p.repo=? AND j.status IN ('queued','running','publishing')",
        )
        .get(id)
    )
      throw new Error(
        'Cancel queued reviews and wait for active reviews to finish before removing this repository.',
      );
    if (req.body.deleteClone) {
      if (!repo.managed) throw new Error('Only app-managed clones can be deleted.');
      const root = await realpath(path.join(dataDir, 'repositories'));
      const local = await realpath(repo.path);
      if (!repo.managed || !local.startsWith(root + path.sep))
        throw new Error('Only app-managed clones can be deleted.');
      const [dirty, commits, worktrees] = await Promise.all([
        run('git', ['-C', local, 'status', '--porcelain', '--untracked-files=all', '--ignored']),
        run('git', ['-C', local, 'rev-list', '--branches', '--not', '--remotes']),
        run('git', ['-C', local, 'worktree', 'list', '--porcelain']),
      ]);
      if (dirty || commits || worktrees.split('worktree ').length > 2)
        throw new Error(
          'Clone contains local files, unpushed commits, or other worktrees. Remove it from the app without deleting files.',
        );
      await rm(local, { recursive: true });
    }
    store.db
      .prepare('UPDATE repos SET archived=1,enabled=0,merge_config=? WHERE id=?')
      .run(JSON.stringify({ ...mergeConfig(repo), rules: [] }), id);
    engine.log(
      'info',
      `Removed ${id} from connected repositories${req.body.deleteClone ? ' and deleted its app-managed clone' : ''}. Review history retained.`,
    );
    res.json({ ok: true });
  }),
);

app.patch(
  '/api/repos',
  wrap(async (req, res) => {
    const id = text(req.body.id, 200);
    const existing = store.db.prepare('SELECT * FROM repos WHERE id=? AND archived=0').get(id);
    if (!existing) throw new Error('Repository not found.');
    const config =
      req.body.mergeConfig === undefined ? undefined : validateMergeConfig(req.body.mergeConfig);
    const checks = req.body.checks === undefined ? undefined : validateChecks(req.body.checks);
    const enabled = req.body.enabled === undefined ? undefined : boolean(req.body.enabled);
    const instructions =
      req.body.instructions === undefined ? undefined : text(req.body.instructions, 50000);
    let localPath;
    if (req.body.path !== undefined && req.body.path !== existing.path) {
      localPath = await realpath(text(req.body.path, 2000).replace(/^~(?=\/)/, os.homedir()));
      if (!(await stat(localPath)).isDirectory())
        throw new Error('Choose a local repository directory.');
      const remote = await run('git', ['-C', localPath, 'remote', 'get-url', 'origin']);
      if (remoteRepo(remote)?.toLowerCase() !== id.toLowerCase())
        throw new Error('The local repository origin must match the GitHub repository.');
    }
    store.transaction(() => {
      if (localPath !== undefined)
        store.db
          .prepare(
            'UPDATE repos SET managed=CASE WHEN path=? THEN managed ELSE 0 END,path=?,error=NULL WHERE id=?',
          )
          .run(localPath, localPath, id);
      if (config !== undefined)
        store.db
          .prepare('UPDATE repos SET merge_config=? WHERE id=?')
          .run(JSON.stringify(config), id);
      if (checks !== undefined)
        store.db.prepare('UPDATE repos SET checks=? WHERE id=?').run(JSON.stringify(checks), id);
      if (enabled !== undefined)
        store.db.prepare('UPDATE repos SET enabled=? WHERE id=?').run(+enabled, id);
      if (instructions !== undefined)
        store.db.prepare('UPDATE repos SET instructions=? WHERE id=?').run(instructions, id);
    });
    notify();
    res.json({ ok: true });
  }),
);
app.post(
  '/api/jobs',
  wrap(async (req, res) => {
    let id = req.body.prId;
    if (req.body.url) {
      const ref = parsePR(req.body.url);
      if (!store.db.prepare('SELECT id FROM repos WHERE id=?').get(ref.repo))
        throw new Error('Add this repository and its local path in Repositories first.');
      id = engine.upsert(ref.repo, await engine.fetchPR(ref.repo, ref.number));
    }
    const jobId = store.enqueue(text(id, 250), text(req.body.instructions || '', 20000));
    notify();
    res.status(201).json({ id: jobId });
  }),
);
app.put(
  '/api/queue',
  wrap(async (req, res) => {
    if (!Array.isArray(req.body.ids)) throw new Error('Expected queue IDs.');
    store.reorder(req.body.ids);
    notify();
    res.json({ ok: true });
  }),
);
app.get(
  '/api/jobs/:id',
  wrap(async (req, res) => {
    const job = store.job(req.params.id);
    if (!job) return res.status(404).json({ error: 'Review not found.' });
    res.json({
      ...job,
      events: store.db
        .prepare('SELECT * FROM events WHERE job_id=? ORDER BY id DESC LIMIT 300')
        .all(job.id),
    });
  }),
);
app.patch(
  '/api/jobs/:id',
  wrap(async (req, res) => {
    const job = store.job(req.params.id);
    if (!job || job.status !== 'queued')
      throw new Error('Only queued review instructions can be edited.');
    store.db
      .prepare('UPDATE jobs SET instructions=? WHERE id=?')
      .run(text(req.body.instructions, 20000), job.id);
    notify();
    res.json({ ok: true });
  }),
);
app.post(
  '/api/jobs/:id/cancel',
  wrap(async (req, res) => {
    engine.cancel(req.params.id);
    res.json({ ok: true });
  }),
);
app.post(
  '/api/jobs/:id/retry',
  wrap(async (req, res) => {
    const job = store.job(req.params.id);
    if (
      !job ||
      !['failed', 'cancelled', 'awaiting_approval', 'published', 'publish_failed'].includes(
        job.status,
      )
    )
      throw new Error('This review cannot be retried yet.');
    await health({ force: true, retryAccount: true });
    engine.upsert(job.repo, await engine.fetchPR(job.repo, job.number));
    const id = store.enqueue(job.pr_id, job.instructions);
    notify();
    res.json({ id });
  }),
);
app.post(
  '/api/jobs/:id/publish',
  wrap(async (req, res) => {
    const job = store.job(req.params.id);
    if (!job || !['awaiting_approval', 'publish_failed'].includes(job.status))
      throw new Error('Review is not ready to publish.');
    void engine.publish(job.id).catch((e) => engine.log('error', e.message, job.id));
    res.status(202).json({ ok: true });
  }),
);
app.get(
  '/api/pr',
  wrap(async (req, res) => {
    const { repo, number } = parsePR(String(req.query.id));
    if (!store.db.prepare('SELECT id FROM repos WHERE id=?').get(repo))
      throw new Error('Unknown repository.');
    const [metadata, files] = await Promise.all([
      engine.fetchPR(repo, number),
      engine.gh(['api', `repos/${repo}/pulls/${number}/files`, '--paginate', '--slurp']),
    ]);
    res.json({
      metadata,
      files: files.flat().map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    });
  }),
);
app.get(
  '/api/merge',
  wrap(async (req, res) => {
    const id = text(req.query.id, 300);
    parsePR(id);
    res.json(await merging.inspect(id, { includeUpdate: true }));
  }),
);
app.post(
  '/api/merge',
  wrap(async (req, res) => {
    const id = text(req.body.prId, 300);
    parsePR(id);
    res.json(
      await merging.merge(id, {
        sha: text(req.body.sha, 64),
        baseBranch: text(req.body.baseBranch, 200),
        reviewId: text(req.body.reviewId, 100),
        method: text(req.body.method, 20),
      }),
    );
  }),
);
app.post(
  '/api/update-branch',
  wrap(async (req, res) => {
    const id = text(req.body.prId, 300);
    parsePR(id);
    res.status(202).json(
      await merging.updateBase(id, {
        sha: text(req.body.sha, 64),
        baseBranch: text(req.body.baseBranch, 200),
      }),
    );
  }),
);
app.post(
  '/api/auth/key',
  wrap(async (req, res) => {
    apiKey = text(req.body.key, 500).trim();
    healthCache = null;
    res.json({ ok: true });
  }),
);
app.get('/api/auth/session', (_req, res) =>
  res.json(
    authSession
      ? {
          provider: authSession.provider,
          output: authSession.output,
          status: authSession.status,
        }
      : { status: 'idle' },
  ),
);
app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const provider = choice(req.body.provider, ['github', 'claude']);
    if (authSession?.status === 'running')
      throw new Error('A sign-in is already in progress. Finish or cancel it first.');
    const command = provider === 'github' ? 'gh' : 'claude',
      args =
        provider === 'github'
          ? ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']
          : ['auth', 'login', '--claudeai'];
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GH_BROWSER: process.platform === 'darwin' ? '/usr/bin/open' : undefined,
      },
    });
    const session = { provider, output: '', status: 'running', child };
    authSession = session;
    const append = (c) => {
      session.output = (session.output + c.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(
        -12000,
      );
      notify();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      session.status = 'failed';
      append(e.message);
    });
    child.on('close', (code) => {
      clearTimeout(session.timer);
      session.status = code === 0 ? 'complete' : 'failed';
      void health({ force: true, retryAccount: true }).then(notify);
    });
    session.timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 10 * 60000);
    session.timer.unref();
    res.json({ ok: true });
  }),
);
app.post(
  '/api/auth/input',
  wrap(async (req, res) => {
    if (authSession?.status !== 'running') throw new Error('No active sign-in.');
    authSession.child.stdin.write(text(req.body.input || '', 4000) + '\n');
    res.json({ ok: true });
  }),
);
app.post('/api/auth/cancel', (_req, res) => {
  authSession?.child.kill('SIGTERM');
  res.json({ ok: true });
});
app.use(express.static(path.join(here, '../dist'), { index: 'index.html' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message || 'Request failed.' });
});
const server = app.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(`Review Studio is ready at ${address}`);
  process.parentPort?.postMessage({ type: 'ready', url: address });
  process.send?.({ type: 'ready', url: address });
  void health()
    .then(async (status) => {
      notify();
      if (status.github.ok && store.db.prepare('SELECT COUNT(*) AS n FROM repos').get().n)
        await engine.sync();
    })
    .catch((e) => engine.log('error', e.message));
});
server.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
let ticking = false;
const ticker = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    if (connections.ready()) await engine.tick();
    if (
      !engine.syncing &&
      healthCache?.github.ok &&
      Date.now() - new Date(store.get('lastSync') || 0).getTime() > store.get('syncMinutes') * 60000
    )
      void engine.sync().catch((e) => engine.log('error', e.message));
  } finally {
    ticking = false;
  }
}, 1500);
const recoveryTimer = setInterval(() => {
  void engine
    .recoverFailed()
    .catch((error) => engine.log('error', `Recovery check failed: ${error.message}`));
}, 30000);
const healthTimer = setInterval(() => {
  void health().catch((error) => engine.log('error', `Connection check failed: ${error.message}`));
}, 1500);
const mergeTimer = setInterval(() => {
  void merging
    .refreshUpdates()
    .catch((error) => engine.log('error', `Branch update check failed: ${error.message}`));
  void merging
    .tick()
    .catch((error) => engine.log('error', `Automatic merge check failed: ${error.message}`));
}, 60000);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  engine.closing = true;
  clearInterval(ticker);
  clearInterval(attentionHeartbeat);
  clearInterval(healthTimer);
  clearInterval(recoveryTimer);
  clearInterval(mergeTimer);
  connections.close();
  authSession?.child.kill('SIGTERM');
  for (const c of clients) c.end();
  server.close();
  await abortAllProcesses();
  await engine.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'check-connections')
    void health({ force: true })
      .then(notify)
      .catch((e) => engine.log('error', e.message));
  if (event.data?.type === 'shutdown') void shutdown();
  if (event.data?.type === 'api-key') {
    apiKey = event.data.value;
    void health({ force: true, retryAccount: true }).then(notify);
  }
});
