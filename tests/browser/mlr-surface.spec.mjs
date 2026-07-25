import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/mlr.html?device=127.0.0.1&rt=7778&bridge=localhost';

async function commands(request) {
  const response = await request.get(`${FIXTURE}/commands`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function waitForCommand(request, predicate) {
  await expect.poll(async () => (await commands(request)).some(predicate)).toBe(true);
}
async function openMlr(page) {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('#mlr-status')).toHaveText('synced');
  await expect(page.locator('body')).toHaveAttribute('data-mlr-active', '');
}

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('MLR surface renders the complete authoritative observer state and 16 by 8 LEDs', async ({page}) => {
  await openMlr(page);
  await expect(page.locator('.mlr-pad')).toHaveCount(128);
  await expect(page.locator('.mlr-track')).toHaveCount(6);
  await expect(page.locator('.mlr-slot')).toHaveCount(7);
  await expect(page.locator('#mlr-patterns .mlr-memory')).toHaveCount(4);
  await expect(page.locator('#mlr-recalls .mlr-memory')).toHaveCount(4);
  await expect(page.locator('#mlr-view')).toHaveText('CUT');
  await expect(page.locator('#mlr-quantize')).toHaveText('quantized');
  await expect(page.locator('.mlr-pad[data-x="2"][data-y="1"]')).toHaveAttribute('data-level', '15');
  await expect(page.locator('.mlr-track').first()).toHaveAttribute('data-playing', 'true');
  await expect(page.locator('.mlr-track').first()).toContainText('4–9');
});

test('ordinary MLR Grid input is balanced and uses the published 16 by 8 vport', async ({page, request}) => {
  await openMlr(page);
  await page.locator('.mlr-pad[data-x="7"][data-y="2"]').click();
  await waitForCommand(request, item => item.command?.target === 'grid' && item.command?.action === 'key' && item.command.args?.port === 2 && item.command.args?.x === 7 && item.command.args?.y === 2 && item.command.args?.z === 1);
  await waitForCommand(request, item => item.command?.target === 'grid' && item.command?.action === 'key' && item.command.args?.port === 2 && item.command.args?.x === 7 && item.command.args?.y === 2 && item.command.args?.z === 0);
});

test('desktop Shift-click emits the exact MLR two-point loop chord ordering', async ({page, request}) => {
  await openMlr(page);
  const first = page.locator('.mlr-pad[data-x="3"][data-y="4"]');
  const second = page.locator('.mlr-pad[data-x="11"][data-y="4"]');
  await page.keyboard.down('Shift');
  await first.click();
  await expect(first).toHaveAttribute('data-loop-anchor', 'true');
  await second.click();
  await page.keyboard.up('Shift');
  await expect.poll(async () => {
    const matching = (await commands(request)).filter(item => item.command?.target === 'grid' && item.command?.args?.port === 2 && item.command?.args?.y === 4);
    return matching.map(item => [item.command.args.x, item.command.args.z]);
  }).toEqual([[3, 1], [11, 1], [11, 0], [3, 0]]);
});

test('MLR norns K and E controls use the standard callback path', async ({page, request}) => {
  await openMlr(page);
  await page.locator('[data-key="2"]').click();
  await page.locator('[data-encoder="2"] [data-delta="1"]').click();
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command.args?.n === 2 && item.command.args?.z === 1);
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command.args?.n === 2 && item.command.args?.z === 0);
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'enc' && item.command.args?.n === 2 && item.command.args?.d === 1);
});

test('socket loss releases MLR holds and the page returns to authoritative state', async ({page, request}) => {
  await openMlr(page);
  const pad = page.locator('.mlr-pad[data-x="16"][data-y="1"]');
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(pad).toHaveAttribute('data-pressed', 'true');
  await request.get(`${FIXTURE}/disconnect`);
  await expect(pad).toHaveAttribute('data-pressed', 'false');
  await expect(page.locator('body')).toHaveAttribute('data-ingenue-state', 'reconnecting');
  await page.mouse.up();
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('#mlr-view')).toHaveText('CUT');
});
