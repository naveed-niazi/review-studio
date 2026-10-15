import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

process.env.REVIEW_STUDIO_FIXTURE_ONLY = '1';
const { startFixture } = await import('../test/http.test.js');
const fixture = await startFixture();
let browser;
try {
  const out = path.resolve('docs/screenshots');
  await mkdir(out, { recursive: true });
  const { token } = await (await fetch(fixture.url + '/api/session')).json();
  async function api(route, method, body) {
    const response = await fetch(fixture.url + route, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Demo API failed: ${route}`);
    return response.json();
  }
  let state;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(fixture.url + '/api/state')).json();
    if (state.prs.length === 12 && state.health) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (state.prs.length !== 12 || !state.health) throw new Error('Demo fixture failed to load.');
  const continuity = await readFile('examples/prompts/review-continuity.md', 'utf8');
  const experiments = await readFile('examples/prompts/experiment-review.md', 'utf8');
  await api('/api/templates', 'PUT', {
    templates: [
      { id: 'continuity', name: 'Review continuity', body: continuity },
      { id: 'experiments', name: 'Experiment & analytics', body: experiments },
      {
        id: 'security',
        name: 'Authentication & access',
        body: 'Trace authentication, session expiry, authorization checks, and tenant isolation. Verify failure paths and focused regression coverage.',
      },
    ],
  });
  for (const [number, instructions] of [
    [101, 'Check session expiry and recovery paths.'],
    [102, 'Verify keyboard navigation and focus management.'],
    [103, 'Trace workspace authorization boundaries.'],
  ]) {
    await api('/api/jobs', 'POST', { prId: `acme/web-app#${number}`, instructions });
  }
  const ready = await api('/api/jobs', 'POST', { prId: 'acme/api#101', instructions: '' });
  // Populate a fictional completed result only inside this disposable fixture.
  const db = new DatabaseSync(path.join(fixture.root, 'data', 'studio.sqlite'));
  db.prepare("UPDATE jobs SET status='awaiting_approval',result=?,finished_at=? WHERE id=?").run(
    '**Verdict: NON-BLOCKING**\n\nThe session expiry change is ready for a closer look.\n\n- Add a regression test for refresh-token expiry during a pending request.\n- Previously raised authorization feedback is resolved in the current diff.\n\n**Action:** Consider the test addition before merging.',
    new Date().toISOString(),
    ready.id,
  );
  db.close();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1060 },
    deviceScaleFactor: 1,
  });
  await page.goto(fixture.url);
  await page.getByRole('heading', { name: 'Good code. Clear reviews.' }).waitFor();
  await page.getByText('Add session expiry handling to authentication').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const capture = (name) =>
    page.screenshot({ path: path.join(out, name + '.png'), animations: 'disabled' });
  await capture('pull-requests');
  await page.getByRole('button', { name: 'Review queue', exact: false }).first().click();
  await page.getByRole('heading', { name: 'Runner is paused' }).waitFor();
  await capture('review-queue');
  await page.getByRole('button', { name: 'Prompts & rules', exact: true }).click();
  await page.getByRole('button', { name: 'Authentication & access', exact: false }).click();
  await page.setViewportSize({ width: 1440, height: 1240 });
  await capture('prompts');
  console.log('Created three screenshots from isolated fictional data.');
} finally {
  await browser?.close();
  await fixture.stop();
}
