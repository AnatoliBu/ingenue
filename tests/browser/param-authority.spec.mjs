import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/performance.html?device=127.0.0.1&rt=7778&bridge=localhost';

async function commands(request) {
  const response = await request.get(`${FIXTURE}/commands`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('performance parameter lane reads its descriptor from norns', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  const authority = page.locator('.param-authority');
  await expect(authority).toContainText('applied 0.50');
  await expect(page.locator('#param-min')).toHaveValue('0');
  await expect(page.locator('#param-max')).toHaveValue('1');
  await expect(page.locator('#param-number')).toHaveValue('0.5');

  await expect.poll(async () => (await commands(request)).some(item =>
    item.command?.target === 'param' && item.command?.action === 'describe' && item.command.args?.id === 'cutoff'
  )).toBe(true);
});

test('authoritative descriptor replaces browser guesses and ACK records the applied value', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('.param-authority')).toContainText('applied');

  await page.locator('#param-min').fill('-100');
  await page.locator('#param-max').fill('100');
  await page.locator('#param-id').dispatchEvent('change');
  await expect(page.locator('#param-min')).toHaveValue('0');
  await expect(page.locator('#param-max')).toHaveValue('1');

  await page.locator('#param-slider').evaluate(element => {
    element.value = '0.72';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await expect(page.locator('.param-authority')).toContainText('applied 0.72');
  await expect(page.locator('#param-number')).toHaveValue('0.72');
  await expect.poll(async () => (await commands(request)).some(item =>
    item.command?.target === 'param' && item.command?.action === 'set' &&
    item.command.args?.id === 'cutoff' && item.command.args?.value === 0.72
  )).toBe(true);
});

test('parameter rejects are surfaced and malformed IDs never reach transport', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('.param-authority')).toContainText('applied');

  const id = page.locator('#param-id');
  await id.fill('reject_me');
  await id.dispatchEvent('change');
  await expect(page.locator('.param-authority')).toContainText('fixture rejected parameter command');

  const before = (await commands(request)).length;
  await id.fill('bad/id');
  await id.dispatchEvent('change');
  await expect(page.locator('.param-authority')).toContainText('may contain letters');
  const validation = await id.evaluate(element => element.validationMessage);
  expect(validation).toContain('Parameter ID');
  await page.waitForTimeout(100);
  expect((await commands(request)).length).toBe(before);
});
