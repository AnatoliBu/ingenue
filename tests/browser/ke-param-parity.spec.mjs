import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/performance.html?device=127.0.0.1&rt=7778&bridge=localhost';

async function commands(request) {
  const response = await request.get(`${FIXTURE}/commands`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function waitForCommand(request, predicate) {
  await expect.poll(async () => (await commands(request)).some(predicate)).toBe(true);
}

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('hardware encoders support keyboard deltas with shift acceleration', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  const encoder = page.locator('[data-encoder="1"]');
  await expect(encoder).toHaveAttribute('tabindex', '0');
  await encoder.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowLeft');

  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'enc' && item.command.args?.n === 1 && item.command.args?.d === 1);
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'enc' && item.command.args?.n === 1 && item.command.args?.d === -8);
});

test('pointer-held K controls release exactly once when the browser loses focus', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  const key = page.locator('[data-key="1"]');
  await key.dispatchEvent('pointerdown', {pointerId: 41, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10});
  await expect(key).toHaveAttribute('data-pressed', 'true');
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command.args?.n === 1 && item.command.args?.z === 1);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(key).toHaveAttribute('data-pressed', 'false');
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command.args?.n === 1 && item.command.args?.z === 0);

  const matching = (await commands(request)).filter(item => item.command?.target === 'control' && item.command?.action === 'key' && item.command.args?.n === 1);
  expect(matching.map(item => item.command.args.z)).toEqual([1, 0]);
});

test('keyboard-held K controls and encoder gestures are cleared on focus loss', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  const key = page.locator('[data-key="2"]');
  const encoder = page.locator('[data-encoder="2"]');

  await key.focus();
  await key.dispatchEvent('keydown', {key: ' ', repeat: false});
  await expect(key).toHaveAttribute('data-pressed', 'true');
  await encoder.dispatchEvent('pointerdown', {pointerId: 52, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20});
  await expect(encoder).toHaveAttribute('data-pressed', 'true');

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(key).toHaveAttribute('data-pressed', 'false');
  await expect(encoder).toHaveAttribute('data-pressed', 'false');
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command.args?.n === 2 && item.command.args?.z === 0);
});

test('disconnect clears pressed visuals while the server releases owned controls', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  const key = page.locator('[data-key="3"]');
  await key.dispatchEvent('pointerdown', {pointerId: 63, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10});
  await expect(key).toHaveAttribute('data-pressed', 'true');
  await request.get(`${FIXTURE}/disconnect`);
  await expect(key).toHaveAttribute('data-pressed', 'false');
  await expect(page.locator('body')).toHaveAttribute('data-ingenue-state', 'reconnecting');
});
