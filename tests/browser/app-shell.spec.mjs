import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const BRIDGE = 'http://localhost:7780';
const QUERY = '?device=127.0.0.1&rt=7778&bridge=localhost';

async function waitForShell(page) {
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('.ingenue-shell-diagnostics-toggle')).toHaveCount(1);
  await expect(page.locator('.ingenue-shell-state')).toHaveAttribute('data-state', 'synced');
  await expect(page.locator('body')).toHaveAttribute('data-ingenue-state', 'synced');
}

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('every public controller page inherits one shared runtime shell', async ({page}) => {
  const pages = [
    'controllers.html',
    'performance.html',
    'mlr.html',
    'builder.html',
    'launchpad.html',
    'gamepad.html',
    'params.html',
    'midi.html',
    'realtime-inspector.html',
  ];
  for (const name of pages) {
    await page.goto(`${BRIDGE}/${name}${QUERY}`);
    await waitForShell(page);
    await expect(page.locator('[data-ingenue-nav]')).toHaveAttribute('data-connection-state', 'synced');
    await expect(page.locator('[data-ingenue-nav] a')).toHaveCount(9);
    await expect(page.locator('.ingenue-shell-drawer')).toBeHidden();
  }
});

test('diagnostics drawer renders the authoritative session and structured event log', async ({page}) => {
  await page.goto(`${BRIDGE}/performance.html${QUERY}`);
  await waitForShell(page);

  await page.locator('.ingenue-shell-diagnostics-toggle').click();
  const drawer = page.locator('.ingenue-shell-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('.ingenue-shell-summary-value').filter({hasText: 'ws://127.0.0.1:7778/realtime'})).toHaveCount(1);
  await expect(drawer.locator('.ingenue-shell-summary-value').filter({hasText: 'browser-contract-fixture'})).toHaveCount(1);
  await expect(drawer.locator('.ingenue-shell-event-name').filter({hasText: 'server hello'})).toHaveCount(1);
  await expect(drawer.locator('.ingenue-shell-event-name').filter({hasText: 'snapshot'})).toHaveCount(1);

  const sequences = await drawer.locator('.ingenue-shell-event').evaluateAll(rows => rows.map(row => Number(row.dataset.sequence)));
  expect(sequences.length).toBeGreaterThan(1);
  for (let index = 1; index < sequences.length; index += 1) {
    expect(sequences[index]).toBeLessThan(sequences[index - 1]);
  }

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.keyboard.press('Control+Shift+D');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', {name: 'clear'}).click();
  await expect(drawer.locator('.ingenue-shell-events-empty')).toHaveText('No runtime events yet.');
});

test('shared shell reports reconnecting and returns to synced', async ({page, request}) => {
  await page.goto(`${BRIDGE}/gamepad.html${QUERY}`);
  await waitForShell(page);
  await request.get(`${FIXTURE}/disconnect`);
  await expect(page.locator('.ingenue-shell-state')).toHaveAttribute('data-state', 'reconnecting');
  await expect(page.locator('body')).toHaveAttribute('data-ingenue-state', 'reconnecting');
  await waitForShell(page);
});

test('diagnostics remains usable at phone width with safe touch targets', async ({page}) => {
  await page.setViewportSize({width: 390, height: 740});
  await page.goto(`${BRIDGE}/params.html${QUERY}`);
  await waitForShell(page);
  const toggle = page.locator('.ingenue-shell-diagnostics-toggle');
  const toggleBox = await toggle.boundingBox();
  expect(toggleBox.height).toBeGreaterThanOrEqual(32);
  await toggle.click();
  const drawer = page.locator('.ingenue-shell-drawer');
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(740);
});
