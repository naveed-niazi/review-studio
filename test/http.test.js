import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createStore } from '../server/store.js';

export async function startFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-studio-http-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const repos = [
    { id: 'acme/web-app', name: 'web-app' },
    { id: 'acme/api', name: 'api' },
  ];
  const s = createStore(path.join(root, 'data'));
  for (const r of repos) {
    await mkdir(path.join(root, r.name));
    s.db.prepare('INSERT INTO repos (id,path) VALUES (?,?)').run(r.id, path.join(root, r.name));
  }
  s.db.close();
  const titles = [
    'Add session expiry handling to authentication',
    'Improve project navigation and keyboard shortcuts',
    'Fix permissions for workspace invitations',
    'Add analytics to the onboarding flow',
    'Update billing webhook validation',
    'Refine the dashboard empty state',
  ];
  await writeFile(
    path.join(bin, 'gh'),
    `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='api'&&args[1]==='user'){console.log(args.includes('--jq')?'dev-user':JSON.stringify({login:'dev-user'}));}else if(args[0]==='pr'&&args[1]==='list'){const repo=args[args.indexOf('--repo')+1];setTimeout(()=>console.log(JSON.stringify(${JSON.stringify(titles)}.map((title,i)=>({number:i+101,title,headRefOid:'a'.repeat(40),baseRefName:'main',headRefName:'feature/session-expiry',url:'https://github.com/'+repo+'/pull/'+(i+101),author:{login:['alex','sarah','jordan'][i%3]},isDraft:i===4,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),additions:48+i*21,deletions:12+i*3,changedFiles:3+i})))),1500);}else if(args[0]==='pr'&&args[1]==='view'){console.log(JSON.stringify({number:Number(args[2]),title:'Test pull request',headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',headRefName:'feature/session-expiry',url:'https://github.com/acme/web-app/pull/'+args[2],state:'OPEN',isDraft:false,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',statusCheckRollup:[],author:{login:'alex'},body:'## Summary\\nA focused feature change.',additions:48,deletions:12}));}else if(args[0]==='repo'&&args[1]==='list'){console.log(JSON.stringify([{nameWithOwner:'acme/new-project',description:'A new project',isPrivate:true}]));}else if(args[0]==='api'&&args.includes('PUT')&&args[1].endsWith('/merge')){let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'merge-requests.jsonl'))},input+'\\n');console.log(JSON.stringify({merged:true,sha:'c'.repeat(40)}));});}else if(args[0]==='api'&&/^repos\\/[^/]+\\/[^/]+$/.test(args[1])){console.log(JSON.stringify({permissions:{push:true},allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true}));}else if(args[0]==='api'){console.log(JSON.stringify([[{filename:'src/auth.ts',additions:4,deletions:1,patch:'@@ -1 +1 @@\\n-old\\n+new'}]]));}else if(args[0]==='auth'){console.log('Already authenticated');}else process.exit(2);`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(bin, 'claude'),
    `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'dev@example.com'}));`,
    { mode: 0o755 },
  );
  let output = '';
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PATH: bin + path.delimiter + process.env.PATH,
      REVIEW_STUDIO_DATA: path.join(root, 'data'),
      REVIEW_STUDIO_PORT: '0',
      REVIEW_STUDIO_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(output || 'Server start timeout')), 10000);
    server.stdout.on('data', (c) => {
      output += c;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    server.stderr.on('data', (c) => (output += c));
    server.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited ${code}: ${output}`));
    });
  });
  return {
    url,
    root,
    seedReview: async (prId, verdict = 'NON-BLOCKING') => {
      const store = createStore(path.join(root, 'data'));
      try {
        const id = store.enqueue(prId);
        store.db
          .prepare(
            "UPDATE jobs SET status='published',reviewed_base_branch=(SELECT base_branch FROM prs WHERE prs.id=jobs.pr_id),result=?,finished_at=? WHERE id=?",
          )
          .run(
            `**Verdict: ${verdict}**\n\n**Action:** Merge with a follow-up test.\n\nAdd coverage for the retry path.`,
            new Date().toISOString(),
            id,
          );
        return id;
      } finally {
        store.db.close();
      }
    },
    setClaudeFailure: async (message) => {
      await writeFile(
        path.join(bin, 'claude'),
        `#!${process.execPath}\n${
          message
            ? `console.error(${JSON.stringify(message)});process.exit(1);`
            : `console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'dev@example.com'}));`
        }`,
        { mode: 0o755 },
      );
    },
    stop: async () => {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

if (!process.env.REVIEW_STUDIO_FIXTURE_ONLY)
  test('HTTP API stays responsive during slow GitHub sync, protects mutations, and persists rule settings', async (t) => {
    const app = await startFixture();
    t.after(() => app.stop());
    const first = performance.now();
    const state = await (await fetch(app.url + '/api/state')).json();
    assert.ok(
      performance.now() - first < 500,
      'Cached state should not wait for 1.5s GitHub commands',
    );
    assert.equal(state.settings.paused, true);
    assert.equal(
      (
        await fetch(app.url + '/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: false }),
        })
      ).status,
      403,
    );
    const { token } = await (await fetch(app.url + '/api/session')).json();
    const headers = {
      'Content-Type': 'application/json',
      'X-Studio-Token': token,
    };
    assert.equal(
      (
        await fetch(app.url + '/api/settings', {
          method: 'PATCH',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise((resolve) =>
        http.get(app.url + '/api/state', { headers: { Host: 'attacker.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }),
      ),
      403,
    );
    const update = await fetch(app.url + '/api/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        checks: {
          tests: false,
          analytics: true,
          security: true,
          compatibility: true,
        },
        publishPolicy: 'automatic',
      }),
    });
    assert.equal(update.status, 200);
    const next = await (await fetch(app.url + '/api/state')).json();
    assert.equal(next.settings.checks.analytics, true);
    assert.equal(next.settings.checks.tests, false);
    assert.equal(next.settings.publishPolicy, 'automatic');
    assert.equal(
      (
        await fetch(app.url + '/api/settings', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ concurrency: 100 }),
        })
      ).status,
      400,
    );
    let ready;
    for (let attempt = 0; attempt < 30; attempt++) {
      ready = await (await fetch(app.url + '/api/state')).json();
      if (ready.prs.length === 12) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(ready.prs.length, 12);
    assert.equal(ready.health.github.output, 'dev-user');
    assert.match(ready.health.claude.output, /dev@example.com/);
    const queued = await (
      await fetch(app.url + '/api/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prId: 'acme/web-app#101',
          instructions: 'Check session expiry',
        }),
      })
    ).json();
    assert.ok(queued.id);
    const job = await (await fetch(app.url + '/api/jobs/' + queued.id)).json();
    assert.equal(job.policy, 'automatic');
    assert.equal(job.status, 'queued');
    assert.equal(JSON.parse(job.config).checks.analytics, true);
    const activeRemoval = await fetch(app.url + '/api/repos/remove', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'acme/web-app', deleteClone: false }),
    });
    assert.equal(activeRemoval.status, 400);
    const deleteExisting = await fetch(app.url + '/api/repos/remove', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'acme/api', deleteClone: true }),
    });
    assert.equal(deleteExisting.status, 400);
    assert.match((await deleteExisting.json()).error, /Only app-managed/);
    const remove = await fetch(app.url + '/api/repos/remove', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'acme/api', deleteClone: false }),
    });
    assert.equal(remove.status, 200);
    assert.ok((await stat(path.join(app.root, 'api'))).isDirectory());
  });

if (!process.env.REVIEW_STUDIO_FIXTURE_ONLY)
  test('API exposes specific service failure and recovery without overwriting runner intent', async (t) => {
    const app = await startFixture();
    t.after(() => app.stop());
    const { token } = await (await fetch(app.url + '/api/session')).json();
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
    await fetch(app.url + '/api/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ paused: false }),
    });
    await app.setClaudeFailure('API Error: 503 Service unavailable');
    const failed = await (await fetch(app.url + '/api/health')).json();
    assert.equal(failed.claude.ok, false);
    assert.equal(failed.claude.issue.kind, 'service');
    assert.ok(Date.parse(failed.claude.nextCheckAt) > Date.now());
    assert.equal((await (await fetch(app.url + '/api/state')).json()).settings.paused, false);
    await fetch(app.url + '/api/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ paused: true }),
    });
    await app.setClaudeFailure(null);
    const recovered = await (await fetch(app.url + '/api/health')).json();
    assert.equal(recovered.claude.ok, true);
    assert.equal((await (await fetch(app.url + '/api/state')).json()).settings.paused, true);
  });

if (!process.env.REVIEW_STUDIO_FIXTURE_ONLY)
  test('merge API shows the latest review, validates rules, requires confirmation data and CSRF, and merges the pinned commit', async (t) => {
    const app = await startFixture();
    t.after(() => app.stop());
    for (let i = 0; i < 150; i++) {
      if (
        (await (await fetch(app.url + '/api/state')).json()).prs.some(
          (p) => p.id === 'acme/web-app#102',
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const id = await app.seedReview('acme/web-app#102');
    const state = await (await fetch(app.url + '/api/state')).json();
    const pr = state.prs.find((p) => p.id === 'acme/web-app#102');
    assert.equal(pr.review.verdict, 'NON-BLOCKING');
    assert.equal(pr.review.current, true);
    assert.equal(pr.environment, 'PROD');
    const body = { prId: pr.id, sha: pr.sha, baseBranch: 'main', reviewId: id, method: 'squash' };
    assert.equal(
      (
        await fetch(app.url + '/api/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
      403,
    );
    const { token } = await (await fetch(app.url + '/api/session')).json();
    const headers = { 'Content-Type': 'application/json', 'X-Studio-Token': token };
    const rules = {
      devBranches: ['dev'],
      prodBranches: ['main'],
      rules: [{ baseBranch: 'dev', verdicts: ['LGTM'], method: 'merge' }],
    };
    assert.equal(
      (
        await fetch(app.url + '/api/repos', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ id: 'acme/web-app', mergeConfig: rules }),
        })
      ).status,
      200,
    );
    const invalid = structuredClone(rules);
    invalid.rules[0].verdicts = ['BLOCKING'];
    assert.equal(
      (
        await fetch(app.url + '/api/repos', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ id: 'acme/web-app', mergeConfig: invalid }),
        })
      ).status,
      400,
    );
    const updated = await (await fetch(app.url + '/api/state')).json();
    assert.deepEqual(
      JSON.parse(updated.repos.find((r) => r.id === 'acme/web-app').merge_config),
      rules,
    );
    await fetch(app.url + '/api/repos', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: 'acme/web-app', enabled: false }),
    });
    const invalidSave = await fetch(app.url + '/api/repos', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        id: 'acme/web-app',
        mergeConfig: { ...rules, rules: [] },
        instructions: 'x'.repeat(50001),
      }),
    });
    assert.equal(invalidSave.status, 400);
    await fetch(app.url + '/api/repos', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: 'acme/web-app', mergeConfig: rules }),
    });
    const savedRepo = (await (await fetch(app.url + '/api/state')).json()).repos.find(
      (r) => r.id === 'acme/web-app',
    );
    assert.equal(savedRepo.enabled, 0, 'editing rules must not enable a disabled repository');
    assert.deepEqual(
      JSON.parse(savedRepo.merge_config),
      rules,
      'invalid settings do not partially change merge policy',
    );
    await fetch(app.url + '/api/repos', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ id: 'acme/web-app', enabled: true }),
    });
    const info = await (await fetch(app.url + '/api/merge?id=' + encodeURIComponent(pr.id))).json();
    assert.deepEqual(info.reasons, []);
    assert.deepEqual(info.allowedMethods, ['merge', 'squash', 'rebase']);
    assert.equal(
      (
        await fetch(app.url + '/api/merge', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, sha: 'b'.repeat(40) }),
        })
      ).status,
      400,
    );
    const response = await fetch(app.url + '/api/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).merged, true);
    const final = await (await fetch(app.url + '/api/state')).json();
    assert.ok(!final.prs.some((p) => p.id === pr.id));
    assert.equal(final.merges[0].status, 'merged');
    assert.equal(final.merges[0].method, 'squash');
  });
