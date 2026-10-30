import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { expect } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
process.env.REVIEW_STUDIO_FIXTURE_ONLY = '1';
const { startFixture } = await import('./http.test.js');
const fixture = await startFixture();
const dir = await mkdtemp(path.join(os.tmpdir(), 'review-studio-packaged-'));
const executablePath = path.resolve(
  'release/mac-arm64/Review Studio.app/Contents/MacOS/Review Studio',
);
let app;
try {
  app = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      PATH: path.join(fixture.root, 'bin') + path.delimiter + process.env.PATH,
      REVIEW_STUDIO_DATA: dir,
      REVIEW_STUDIO_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
    },
    timeout: 30000,
  });
  const page = await app.firstWindow({ timeout: 30000 });
  await page.getByRole('heading', { name: 'Welcome to Review Studio' }).waitFor({ timeout: 25000 });
  const origin = new URL(page.url()).origin;
  const prefs = await page.evaluate(() => window.reviewStudio.getPreferences());
  assert.equal(prefs.openAtLogin, false);
  assert.equal(prefs.keepRunning, true);
  assert.equal(prefs.notifications, true);
  assert.equal(prefs.attentionBadge, true);
  await page.evaluate(() => window.reviewStudio.setPreferences({ notifications: false }));
  await page.getByRole('button', { name: 'Explore first' }).click();
  await page.getByRole('heading', { name: 'Good code. Clear reviews.' }).waitFor();
  const state = await (await fetch(origin + '/api/state')).json();
  assert.equal(state.settings.paused, true);
  assert.equal(state.repos.length, 0);
  assert.equal(state.health.github.ok, true);
  assert.equal(state.health.claude.ok, true);
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  await page.getByText('Start Review Studio at login', { exact: true }).waitFor();
  await page
    .getByRole('heading', { name: 'Notifications & attention badge' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(os.tmpdir(), 'review-studio-notifications-settings.png'),
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  assert.equal((await fetch(origin + '/api/state')).status, 200);
  const db = new DatabaseSync(path.join(dir, 'studio.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('INSERT INTO repos(id,path) VALUES (?,?)').run('acme/desktop', dir);
    db.prepare(
      'INSERT INTO prs(id,repo,number,sha,title,url,base_branch) VALUES (?,?,?,?,?,?,?)',
    ).run(
      'acme/desktop#101',
      'acme/desktop',
      101,
      'a'.repeat(40),
      'Fixture PR',
      'https://github.com/acme/desktop/pull/101',
      'main',
    );
    db.prepare(
      'INSERT INTO jobs(id,pr_id,sha,status,position,policy,model,effort,created_at,result,reviewed_base_branch) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'desktop-review',
      'acme/desktop#101',
      'a'.repeat(40),
      'awaiting_approval',
      1,
      'approval',
      'sonnet',
      'medium',
      new Date().toISOString(),
      '**Verdict: LGTM**',
      'main',
    );
    await expect
      .poll(() => app.evaluate(({ app }) => app.dock.getBadge()), { timeout: 20000 })
      .toBe('1');
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      false,
    );
    await page.evaluate(() => window.reviewStudio.setPreferences({ attentionBadge: false }));
    assert.equal(await app.evaluate(({ app }) => app.dock.getBadge()), '');
    assert.equal(
      (await page.evaluate(() => window.reviewStudio.getPreferences())).attentionCount,
      1,
    );
    await page.evaluate(() => window.reviewStudio.setPreferences({ attentionBadge: true }));
    db.prepare("UPDATE jobs SET status='published' WHERE id='desktop-review'").run();
    await expect
      .poll(() => app.evaluate(({ app }) => app.dock.getBadge()), { timeout: 20000 })
      .toBe('');
    await fixture.setClaudeFailure('API Error: 503 Service unavailable');
    await fetch(origin + '/api/health');
    await expect
      .poll(() => app.evaluate(({ app }) => app.dock.getBadge()), { timeout: 20000 })
      .toBe('1');
    await fixture.setClaudeFailure(null);
    await fetch(origin + '/api/health');
    await expect
      .poll(() => app.evaluate(({ app }) => app.dock.getBadge()), { timeout: 20000 })
      .toBe('');
  } finally {
    db.close();
  }

  await app.evaluate(({ app }) => app.emit('activate'));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    true,
  );
  const enginePid = Number(await readFile(path.join(dir, 'app.pid'), 'utf8'));
  process.kill(enginePid, 'SIGTERM');
  await expect
    .poll(
      async () => (await page.evaluate(() => window.reviewStudio.getPreferences())).engineStopped,
      { timeout: 20000 },
    )
    .toBe(true);
  assert.equal(await app.evaluate(({ app }) => app.dock.getBadge()), '1');
  console.log(
    'Packaged desktop passed: first launch, fixture CLI credentials, startup preferences, menu-bar background lifecycle, background attention badges, connection failure/recovery, and engine exit detection. No reviews or GitHub writes performed.',
  );
} finally {
  await app?.close();
  await fixture.stop();
  await rm(dir, { recursive: true, force: true });
}
