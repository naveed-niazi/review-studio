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
    `#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='api'&&args[1]==='user'){console.log(args.includes('--jq')?'dev-user':JSON.stringify({login:'dev-user'}));}else if(args[0]==='pr'&&args[1]==='list'){const repo=args[args.indexOf('--repo')+1];setTimeout(()=>console.log(JSON.stringify(${JSON.stringify(titles)}.map((title,i)=>({number:i+101,title,headRefOid:'a'.repeat(40),baseRefName:'main',headRefName:'feature/session-expiry',url:'https://github.com/'+repo+'/pull/'+(i+101),author:{login:['alex','sarah','jordan'][i%3]},isDraft:i===4,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),additions:48+i*21,deletions:12+i*3,changedFiles:3+i})))),1500);}else if(args[0]==='pr'&&args[1]==='view'){console.log(JSON.stringify({number:Number(args[2]),title:'Test pull request',headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',headRefName:'feature/session-expiry',url:'https://github.com/acme/web-app/pull/'+args[2],state:'OPEN',author:{login:'alex'},body:'## Summary\\nA focused feature change.',additions:48,deletions:12}));}else if(args[0]==='repo'&&args[1]==='list'){console.log(JSON.stringify([{nameWithOwner:'acme/new-project',description:'A new project',isPrivate:true}]));}else if(args[0]==='api'){console.log(JSON.stringify([[{filename:'src/auth.ts',additions:4,deletions:1,patch:'@@ -1 +1 @@\\n-old\\n+new'}]]));}else if(args[0]==='auth'){console.log('Already authenticated');}else process.exit(2);`,
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
