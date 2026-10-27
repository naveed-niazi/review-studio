// Isolated UI acceptance test. Uses fake CLI executables, never production accounts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
process.env.REVIEW_STUDIO_FIXTURE_ONLY = '1';
const { startFixture } = await import('./http.test.js');
const fixture = await startFixture();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fixture.url);
  await page.getByRole('heading', { name: 'Good code. Clear reviews.' }).waitFor();
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await page.getByText(`v${version}`, { exact: true }).waitFor();
  await page.getByText('Add session expiry handling to authentication').first().waitFor();
  await page.locator('.branch-tag').first().waitFor();
  assert.equal(await page.locator('.branch-tag').first().innerText(), 'into main');
  await page.screenshot({
    path: 'build/workspace-preview.png',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Queue', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: 'Added to the review queue' }).waitFor();
  await page.getByRole('button', { name: 'Review queue', exact: false }).first().click();
  await page.getByRole('heading', { name: 'Runner is paused' }).waitFor();
  assert.equal(await page.locator('.queue-row').count(), 1);
  await page.getByRole('button', { name: 'Prompts & rules', exact: true }).click();
  await page.getByRole('button', { name: 'New prompt', exact: true }).click();
  await page.getByLabel('Prompt name').fill('Release readiness');
  await page
    .getByLabel('Instructions', { exact: true })
    .fill('Check rollback behavior and compatibility.');
  await page.getByRole('button', { name: 'Save prompt library' }).click();
  await page.getByRole('status').filter({ hasText: 'Prompt library saved' }).waitFor();
  await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
  await page.getByRole('heading', { name: 'Publishing policy' }).waitFor();
  await page.getByText('Publish automatically', { exact: true }).click();
  await page.getByText('Analytics accompany feature changes', { exact: true }).click();
  await page.getByLabel('Parallel reviews').fill('3');
  await page.getByLabel('Inactivity timeout (minutes)').fill('4');
  await page.getByLabel('Failed review recheck (minutes)').fill('6');
  await page.getByLabel('Sync interval (minutes)').fill('11');
  await page.getByLabel('Age measured from').selectOption('commit');
  await page.getByRole('button', { name: 'Save workflow settings' }).click();
  await page.getByRole('status').filter({ hasText: 'Workflow settings saved' }).waitFor();
  const state = await (await page.request.get(fixture.url + '/api/state')).json();
  assert.equal(state.settings.publishPolicy, 'automatic');
  assert.equal(state.settings.checks.analytics, true);
  assert.equal(state.settings.concurrency, 3);
  assert.equal(state.settings.stallMinutes, 4);
  assert.equal(state.settings.retryFailedMinutes, 6);
  assert.equal(state.settings.autoRetryFailed, true);
  assert.equal(state.settings.syncMinutes, 11);
  assert.equal(state.settings.ageBasis, 'commit');
  assert.equal(state.templates[0].name, 'Release readiness');
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Configure', exact: false }).first().click();
  await page.getByLabel('Repository review rules').fill('Preserve the API contract.');
  const previousPath = await page.getByLabel('Local repository path').inputValue();
  await page.getByLabel('Local repository path').fill(fixture.root);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  // The fake fixture is not a real git clone, so repository validation should fail visibly.
  await page.getByRole('status').filter({ hasText: 'git exited' }).waitFor();
  await page.getByLabel('Local repository path').fill(previousPath);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Repository saved' }).waitFor();
  await fixture.setClaudeFailure('API Error: 503 Service unavailable');
  await page.request.get(fixture.url + '/api/health');
  await page
    .locator('.connection-problem')
    .getByText('Service unavailable', { exact: true })
    .first()
    .waitFor();
  await page.getByText('Next connection check:', { exact: false }).first().waitFor();
  await page.screenshot({ path: '/tmp/review-studio-recovery.png', fullPage: true });
  assert.equal(
    (await (await page.request.get(fixture.url + '/api/state')).json()).settings.paused,
    true,
  );
  await fixture.setClaudeFailure(null);
  await page.request.get(fixture.url + '/api/health');
  await page.locator('.connection-problems').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await page.getByRole('button', { name: 'Browse repositories', exact: true }).click();
  await page.getByRole('button', { name: /acme\/new-project/ }).click();
  assert.equal(
    await page.getByLabel('GitHub repository', { exact: true }).inputValue(),
    'acme/new-project',
  );
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Pull requests', exact: false }).first().click();
  await page.getByRole('button', { name: 'View', exact: true }).first().click();
  await page.getByText('Current branches', { exact: true }).waitFor();
  await page
    .locator('.branch-summary')
    .getByText('feature/session-expiry', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: /Changed files/ }).click();
  await page.getByText('src/auth.ts', { exact: true }).waitFor();
  await page.getByText('src/auth.ts', { exact: true }).click();
  await page.getByText('+new', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  for (const viewport of [
    { width: 1024, height: 600 },
    { width: 820, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.getByRole('button', { name: 'Settings & connections', exact: true }).click();
    await page.getByRole('heading', { name: 'Publishing policy' }).waitFor();
    await page.screenshot({ path: `build/settings-${viewport.width}-preview.png` });
    const settingsBounds = await page
      .getByRole('button', { name: 'Settings & connections', exact: true })
      .boundingBox();
    assert.ok(settingsBounds.y >= 0 && settingsBounds.y + settingsBounds.height <= viewport.height);
    await page.getByRole('button', { name: 'Pull requests', exact: true }).click();
    await page.getByRole('heading', { name: 'Good code. Clear reviews.' }).waitFor();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture.seedReview('acme/web-app#102');
  await page.reload();
  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await page.getByLabel('Filter verdict').selectOption('NON-BLOCKING');
  await page.getByLabel('Filter environment').selectOption('PROD');
  await page.getByLabel('Filter target branch').selectOption('main');
  assert.equal(await page.locator('.pr-row').count(), 1);
  await page.locator('.pr-row').getByText('NON-BLOCKING', { exact: true }).waitFor();
  await page.screenshot({ path: 'build/reviewed-pr-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Merge…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm create a merge commit', exact: true }).waitFor();
  await page.getByText('Add coverage for the retry path.', { exact: true }).waitFor();
  await page.getByLabel('Merge method', { exact: true }).selectOption('squash');
  await page.screenshot({ path: 'build/merge-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Confirm squash and merge', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.pr-row').count(), 0);
  const merged = await (await page.request.get(fixture.url + '/api/state')).json();
  assert.equal(merged.merges[0].method, 'squash');
  assert.equal(merged.merges[0].status, 'merged');
  await page.getByRole('button', { name: 'Repositories', exact: true }).click();
  await page.getByRole('button', { name: 'Configure', exact: false }).first().click();
  await page.getByRole('button', { name: 'Add automatic merge rule', exact: true }).click();
  await page.getByLabel('Rule 1 target branch').fill('dev');
  await page.getByLabel('Rule 1 merge method').selectOption('rebase');
  await page.getByLabel('NON-BLOCKING BUT FIX', { exact: true }).check();
  await page.screenshot({ path: 'build/merge-rules-preview.png', fullPage: true });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const pr = data.prs[0];
    data.jobs = [
      {
        id: 'recovery-demo',
        pr_id: pr.id,
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        status: 'failed',
        pr_state: 'OPEN',
        created_at: new Date().toISOString(),
        recovery_pending: 1,
        recovery_note: 'Will check whether this PR still needs a review.',
        recovery_check_at: new Date(Date.now() + 300000).toISOString(),
        error: 'claude produced no output for 5 minutes',
      },
    ];
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await page.getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('heading', { name: /Automatic recovery/ }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /Needs attention/ }).count(), 0);
  await page.screenshot({ path: '/tmp/review-studio-smart-recovery.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'UI acceptance passed: inbox, queue, prompts, settings, repository picker, validation errors, changed-file preview, responsive layout.',
  );
} finally {
  await browser.close();
  await fixture.stop();
}
