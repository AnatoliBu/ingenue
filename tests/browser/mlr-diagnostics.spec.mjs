import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/mlr.html?device=127.0.0.1&rt=7778&bridge=localhost';

async function injectState(page, mutate) {
  await page.evaluate(source => {
    const session = globalThis.ingenueDebug.latest;
    const data = structuredClone(session.state.data);
    Function('data', source)(data);
    const nextState = {
      ...session.state,
      status: 'synced',
      revision: Number(session.state.revision || 0) + 1,
      data,
    };
    session.state = nextState;
    session.dispatchEvent(new CustomEvent('state', {detail: nextState}));
  }, mutate.toString().replace(/^.*?=>\s*{/, '').replace(/}\s*$/, ''));
}

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

test('MLRE and unrelated scripts keep native Grid K E while MLR workflow falls back', async ({page}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');

  const beforeLevels = await page.locator('.mlr-pad').evaluateAll(pads => pads.map(pad => pad.dataset.level));
  await injectState(page, data => {
    data.script = {active: true, name: 'mlre', shortname: 'mlre'};
    data.mlr = {active: false};
  });

  await expect(page.locator('body')).toHaveAttribute('data-mlr-authority', 'unavailable');
  await expect(page.locator('body')).toHaveAttribute('data-native-controls', 'available');
  await expect(page.locator('body')).toHaveAttribute('data-native-grid-ready', '');
  await expect(page.getByRole('button', {name: 'Grid 1, 1'})).toBeEnabled();
  await expect(page.getByRole('button', {name: 'K1'})).toBeEnabled();
  await expect(page.locator('[data-encoder="1"]')).toHaveAttribute('data-disabled', 'false');
  await expect(page.getByRole('button', {name: 'Record into selected clip'})).toBeDisabled();
  await expect(page.locator('#mlr-notice')).toContainText('Native virtual Grid port');
  await expect(page.locator('#mlr-help')).toContainText('Native Grid/K/E remain available');

  const afterLevels = await page.locator('.mlr-pad').evaluateAll(pads => pads.map(pad => pad.dataset.level));
  expect(afterLevels).toEqual(beforeLevels);
});

test('physical-only Grid LEDs are mirrored but browser Grid input is disabled', async ({page}) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');

  await injectState(page, data => {
    data.script = {active: true, name: 'mlre', shortname: 'mlre'};
    data.mlr = {active: false};
    const virtual = data.grid.ports['1'];
    data.grid.ports = {
      '3': {...virtual, port: 3, virtual: false},
    };
  });

  await expect(page.locator('body')).not.toHaveAttribute('data-native-grid-ready', '');
  await expect(page.getByRole('button', {name: 'Grid 1, 1'})).toBeDisabled();
  await expect(page.getByRole('button', {name: 'K1'})).toBeEnabled();
  await expect(page.locator('[data-encoder="1"]')).toHaveAttribute('data-disabled', 'false');
  await expect(page.getByRole('button', {name: 'Record into selected clip'})).toBeDisabled();
  await expect(page.locator('#mlr-notice')).toContainText('Physical Grid port 3 mirrored');
  await expect(page.locator('.mlr-pad').first()).not.toHaveAttribute('data-level', '0');
});
