import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const BRIDGE = 'http://localhost:7780';
const BRIDGE_QUERY = '?device=127.0.0.1&rt=7778&bridge=localhost';

async function resetFixture(request) {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
}

async function fixtureCommands(request) {
  const response = await request.get(`${FIXTURE}/commands`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function waitForCommand(request, predicate) {
  let match = null;
  await expect.poll(async () => {
    const commands = await fixtureCommands(request);
    match = commands.find(predicate) || null;
    return Boolean(match);
  }).toBe(true);
  return match;
}

async function waitForSynced(page) {
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
}

function observePage(page) {
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', message => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', error => pageErrors.push(error.message));
  return {consoleMessages, pageErrors};
}

async function openPerformanceThroughBridge(page) {
  await page.goto(`${BRIDGE}/midi.html${BRIDGE_QUERY}`);
  await waitForSynced(page);
  const performanceLink = page.getByRole('link', {name: 'performance'});
  await expect(performanceLink).toHaveAttribute('href', /performance\.html\?device=127\.0\.0\.1&rt=7778&bridge=localhost/);
  await performanceLink.click();
  await expect(page).toHaveURL(/performance\.html\?device=127\.0\.0\.1&rt=7778&bridge=localhost/);
  await waitForSynced(page);
  await expect(page.locator('#surface-endpoint')).toHaveText('ws://127.0.0.1:7778/realtime');
}

test.describe.configure({mode: 'serial'});

test.beforeEach(async ({request}) => {
  await resetFixture(request);
});

test('all browser surfaces boot, connect to norns and keep bridge routing', async ({page}) => {
  const observed = observePage(page);
  const pages = [
    'controllers.html',
    'performance.html',
    'builder.html',
    'launchpad.html',
    'gamepad.html',
    'params.html',
    'midi.html',
    'realtime-inspector.html',
  ];

  for (const name of pages) {
    await page.goto(`${BRIDGE}/${name}${BRIDGE_QUERY}`);
    await waitForSynced(page);
    const debug = await page.evaluate(() => ({url: ingenueDebug.latest.url, status: ingenueDebug.latest.state.status}));
    expect(debug).toEqual({url: 'ws://127.0.0.1:7778/realtime', status: 'synced'});
    const links = page.locator('[data-ingenue-nav] a');
    await expect(links).toHaveCount(8);
    for (const link of await links.all()) {
      await expect(link).toHaveAttribute('href', /\?device=127\.0\.0\.1&rt=7778&bridge=localhost$/);
    }
  }

  expect(observed.pageErrors).toEqual([]);
  expect(observed.consoleMessages.filter(line => line.startsWith('error:'))).toEqual([]);
});

test('localhost navigation never falls back to a localhost realtime port', async ({page}) => {
  const observed = observePage(page);
  await openPerformanceThroughBridge(page);
  expect(observed.consoleMessages.some(line => line.includes('ws://localhost:7781/realtime'))).toBe(false);
  expect(observed.consoleMessages.some(line => line.includes('[ingenue realtime] WebSocket open'))).toBe(true);
  expect(observed.pageErrors).toEqual([]);
});

test('performance UI sends balanced Lua-applied controls and configuration commands', async ({page, request}) => {
  const observed = observePage(page);
  await openPerformanceThroughBridge(page);
  await expect(page.locator('.grid-key')).toHaveCount(64);
  await expect(page.locator('.arc-ring')).toHaveCount(4);

  await page.locator('[data-key="1"]').click();
  await page.locator('[data-encoder="1"] [data-delta="1"]').click();
  await page.locator('.grid-key').first().click();
  await page.locator('.arc-key').first().click();
  await page.locator('.arc-ring').first().hover();
  await page.mouse.wheel(0, -100);

  await page.locator('#param-slider').evaluate(element => {
    element.value = '0.73';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await page.locator('#grid-shape').selectOption('8x8');
  await page.locator('#grid-apply').click();
  await page.locator('#arc-config-rings').selectOption('2');
  await page.locator('#arc-apply').click();

  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command?.args?.n === 1 && item.command?.args?.z === 1);
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command?.args?.n === 1 && item.command?.args?.z === 0);
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'enc' && item.command?.args?.n === 1 && item.command?.args?.d === 1);
  await waitForCommand(request, item => item.command?.target === 'grid' && item.command?.action === 'key' && item.command?.args?.z === 1);
  await waitForCommand(request, item => item.command?.target === 'grid' && item.command?.action === 'key' && item.command?.args?.z === 0);
  await waitForCommand(request, item => item.command?.target === 'arc' && item.command?.action === 'key' && item.command?.args?.z === 1);
  await waitForCommand(request, item => item.command?.target === 'arc' && item.command?.action === 'delta');
  await waitForCommand(request, item => item.command?.target === 'param' && item.command?.action === 'set' && item.command?.args?.id === 'cutoff');
  await waitForCommand(request, item => item.command?.target === 'grid' && item.command?.action === 'configure' && item.command?.args?.cols === 8 && item.command?.args?.rows === 8);
  await waitForCommand(request, item => item.command?.target === 'arc' && item.command?.action === 'configure' && item.command?.args?.rings === 2);

  await expect.poll(() => observed.consoleMessages.some(line => line.includes('[ingenue realtime] command ACK'))).toBe(true);
  expect(observed.pageErrors).toEqual([]);
});

test('disconnect, rejection and matron timeout are observable and recoverable', async ({page, request}) => {
  const observed = observePage(page);
  await openPerformanceThroughBridge(page);

  await page.locator('#param-id').fill('reject_me');
  await page.locator('#param-number').evaluate(element => {
    element.value = '0.4';
    element.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await expect(page.locator('#surface-notice')).toContainText('fixture rejected parameter command');

  await page.locator('#param-id').fill('timeout_me');
  await page.locator('#param-number').evaluate(element => {
    element.value = '0.6';
    element.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await expect(page.locator('#surface-notice')).toContainText('matron acknowledgement timeout');

  const before = await (await request.get(`${FIXTURE}/stats`)).json();
  await request.get(`${FIXTURE}/disconnect`);
  await expect.poll(async () => {
    const stats = await (await request.get(`${FIXTURE}/stats`)).json();
    return stats.connections > before.connections && stats.subscriptions > before.subscriptions;
  }).toBe(true);
  await waitForSynced(page);
  await expect(page.locator('#surface-status')).toHaveText('synced');
  expect(observed.consoleMessages.some(line => line.includes('command REJECT'))).toBe(true);
  expect(observed.consoleMessages.some(line => line.includes('WebSocket closed'))).toBe(true);
  expect(observed.consoleMessages.some(line => line.includes('reconnect scheduled'))).toBe(true);
  expect(observed.pageErrors).toEqual([]);
});

test('held controls are released on page lifecycle and gamepad blur', async ({page, request}) => {
  await openPerformanceThroughBridge(page);
  const key = page.locator('[data-key="2"]');
  await key.hover();
  await page.mouse.down();
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command?.args?.n === 2 && item.command?.args?.z === 1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command?.args?.n === 2 && item.command?.args?.z === 0);
  await page.mouse.up();

  await resetFixture(request);
  await page.goto(`${BRIDGE}/gamepad.html${BRIDGE_QUERY}`);
  await waitForSynced(page);
  const face = page.locator('[data-gamepad-button="A"]');
  await face.hover();
  await page.mouse.down();
  await waitForCommand(request, item => item.command?.target === 'gamepad' && item.command?.action === 'button' && item.command?.args?.name === 'A' && item.command?.args?.z === 1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await waitForCommand(request, item => item.command?.target === 'gamepad' && item.command?.action === 'button' && item.command?.args?.name === 'A' && item.command?.args?.z === 0);
  await page.mouse.up();

  await page.locator('[data-gamepad-direction="X:1"]').click();
  await page.locator('#gamepad-left-trigger').evaluate(element => {
    element.value = '0.8';
    element.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await waitForCommand(request, item => item.command?.target === 'gamepad' && item.command?.action === 'dpad' && item.command?.args?.axis === 'X');
  await waitForCommand(request, item => item.command?.target === 'gamepad' && item.command?.action === 'analog' && item.command?.args?.axis === 'triggerleft');
});

test('ownership prevents a second browser from stealing active controls', async ({browser, request}) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await first.goto(`${BRIDGE}/performance.html${BRIDGE_QUERY}`);
    await second.goto(`${BRIDGE}/performance.html${BRIDGE_QUERY}`);
    await waitForSynced(first);
    await waitForSynced(second);
    await first.locator('[data-key="1"]').click();
    await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key' && item.command?.args?.n === 1);
    await second.locator('[data-key="2"]').click();
    await expect(second.locator('#surface-notice')).toContainText('owned by another client');
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('Browser MIDI learns a controller and sends normalized commands through norns', async ({browser, request}) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const input = {
      id: 'fixture-midi-in',
      name: 'Fixture MIDI input',
      manufacturer: 'Ingenue',
      state: 'connected',
      connection: 'closed',
      onmidimessage: null,
      open: async () => { input.connection = 'open'; },
      close: async () => { input.connection = 'closed'; },
    };
    const output = {
      id: 'fixture-midi-out',
      name: 'Fixture MIDI output',
      manufacturer: 'Ingenue',
      state: 'connected',
      connection: 'open',
    };
    const access = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map([[output.id, output]]),
      onstatechange: null,
    };
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => access,
    });
    globalThis.__emitFixtureMidi = data => input.onmidimessage?.({data: Uint8Array.from(data)});
  });
  const page = await context.newPage();
  const observed = observePage(page);
  try {
    await page.goto(`${BRIDGE}/midi.html${BRIDGE_QUERY}`);
    await waitForSynced(page);
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    await expect(page.locator('#midi-bridge')).toBeHidden();
    await page.locator('#midi-permission').click();
    await expect(page.locator('#midi-input')).toHaveValue('fixture-midi-in');
    await page.locator('#midi-pickup').uncheck();
    await expect(page.locator('#midi-learn')).toBeEnabled();
    await page.locator('#midi-learn').click();
    await page.evaluate(() => __emitFixtureMidi([0xB0, 74, 64]));
    await expect(page.locator('.mapping-row')).toHaveCount(1);
    await page.evaluate(() => __emitFixtureMidi([0xB0, 74, 100]));
    await waitForCommand(request, item => item.command?.target === 'param' && item.command?.action === 'set_normalized' && item.command?.args?.id === 'cutoff');
    await expect.poll(() => observed.consoleMessages.some(line => line.includes('command ACK'))).toBe(true);
    expect(observed.pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('UI Builder persists exact-script layouts and drives live preview commands', async ({page, request}) => {
  await page.goto(`${BRIDGE}/builder.html${BRIDGE_QUERY}`);
  await waitForSynced(page);
  await page.locator('[data-add-widget="key"]').click();
  await page.locator('[data-add-widget="encoder"]').click();
  await page.locator('[data-add-widget="param"]').click();
  await expect(page.locator('#builder-count')).toHaveText('3 widgets');
  await page.locator('#builder-export').click();
  const exported = JSON.parse(await page.locator('#builder-json').inputValue());
  expect(exported.script).toBe('browser-contract-fixture');
  expect(exported.widgets.map(widget => widget.type)).toEqual(['key', 'encoder', 'param']);

  const previewKey = page.locator('#builder-preview button').first();
  await previewKey.click();
  await waitForCommand(request, item => item.command?.target === 'control' && item.command?.action === 'key');
  await page.reload();
  await waitForSynced(page);
  await expect(page.locator('#builder-count')).toHaveText('3 widgets');
});
