import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
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
  await page.getByRole('button', { name: 'Explore first' }).click();
  await page.getByRole('heading', { name: 'Good code. Clear reviews.' }).waitFor();
  const state = await (await fetch(origin + '/api/state')).json();
  assert.equal(state.settings.paused, true);
  assert.equal(state.repos.length, 0);
  assert.equal(state.health.github.ok, true);
  assert.equal(state.health.claude.ok, true);
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  await page.getByText('Start Review Studio at login', { exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false,
  );
  assert.equal((await fetch(origin + '/api/state')).status, 200);
  await app.evaluate(({ app }) => app.emit('activate'));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    true,
  );
  console.log(
    'Packaged desktop passed: first launch, fixture CLI credentials, startup preferences, menu-bar background lifecycle, engine remains responsive. No reviews or GitHub writes performed.',
  );
} finally {
  await app?.close();
  await fixture.stop();
  await rm(dir, { recursive: true, force: true });
}
