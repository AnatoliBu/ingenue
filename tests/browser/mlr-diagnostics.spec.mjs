import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/mlr.html?device=127.0.0.1&rt=7778&bridge=localhost';

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('missing MLR audio display data warns once and is retained in diagnostics', async ({page}) => {
  const warnings = [];
  page.on('console', message => {
    if (message.type() === 'warning' && message.text().includes('[ingenue mlr]')) {
      warnings.push(message.text());
    }
  });

  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('body')).toHaveAttribute('data-mlr-active', '');
  await expect(page.locator('body')).toHaveAttribute('data-mlr-audio-observed', 'false');

  // The fixture sends heartbeats every second. The warning must remain edge-triggered,
  // not repeat for every state event.
  await page.waitForTimeout(2300);

  const events = await page.evaluate(() => (
    globalThis.ingenueDebug.latest.eventSnapshot()
      .filter(entry => entry.event === 'mlr audio visualization unavailable')
  ));
  expect(events).toHaveLength(1);
  expect(events[0].level).toBe('warn');
  expect(events[0].detail.impact).toContain('cannot prove that audio was recorded');
  expect(warnings.filter(text => text.includes('mlr audio visualization unavailable'))).toHaveLength(1);

  await page.getByRole('button', {name: 'diagnostics'}).click();
  await expect(
    page.locator('.ingenue-shell-event-name')
      .filter({hasText: 'mlr audio visualization unavailable'})
  ).toHaveCount(1);
});
