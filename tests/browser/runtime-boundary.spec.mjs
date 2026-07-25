import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/performance.html?device=127.0.0.1&rt=7778&bridge=localhost';

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('Chromium exposes one bounded structured runtime log and local validation errors', async ({page, request}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');

  const outcome = await page.evaluate(() => {
    const session = globalThis.ingenueDebug.latest;
    const id = session.command({target: 'system', action: 'ping', args: {}});
    let failure = null;
    try {
      session.command({target: 'control', action: 'key', args: null});
    } catch (error) {
      failure = {name: error.name, code: error.code, message: error.message};
    }
    return {id, failure};
  });

  expect(outcome.failure).toEqual({
    name: 'RuntimeContractError',
    code: 'validation',
    message: 'command args must be an object',
  });

  await expect.poll(async () => {
    const response = await request.get(`${FIXTURE}/commands`);
    const commands = await response.json();
    return commands.some(item => item.id === outcome.id && item.command?.target === 'system');
  }).toBe(true);

  await expect.poll(async () => page.evaluate(id => {
    const entries = globalThis.ingenueDebug.latest.eventSnapshot();
    return entries.some(entry => entry.event === 'command ACK' && entry.detail?.id === id);
  }, outcome.id)).toBe(true);

  const diagnostics = await page.evaluate(() => {
    const session = globalThis.ingenueDebug.latest;
    return {
      size: session.events.size,
      limit: session.events.limit,
      entries: session.eventSnapshot(),
    };
  });
  expect(diagnostics.size).toBeLessThanOrEqual(diagnostics.limit);
  expect(diagnostics.entries.some(entry => entry.event === 'server hello')).toBe(true);
  expect(diagnostics.entries.some(entry => entry.event === 'snapshot')).toBe(true);
  expect(diagnostics.entries.some(entry => entry.event === 'command rejected locally' && entry.detail?.failure?.code === 'validation')).toBe(true);
  for (let index = 1; index < diagnostics.entries.length; index += 1) {
    expect(diagnostics.entries[index].sequence).toBeGreaterThan(diagnostics.entries[index - 1].sequence);
  }
});
