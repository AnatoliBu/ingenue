import {test, expect} from '@playwright/test';

const FIXTURE = 'http://127.0.0.1:7777/__fixture__';
const PAGE = 'http://localhost:7780/mlr.html?device=127.0.0.1&rt=7778&bridge=localhost';

async function commands(request) {
  const response = await request.get(`${FIXTURE}/commands`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function waitForSequence(request, predicate) {
  await expect.poll(async () => predicate(await commands(request))).toBe(true);
}

async function open(page) {
  await page.goto(PAGE);
  await page.waitForFunction(() => globalThis.ingenueDebug?.latest?.state?.status === 'synced');
  await expect(page.locator('#mlr-workflow')).toBeVisible();
  await expect(page.locator('#mlr-workflow-status')).not.toContainText('did not mount');
}

test.beforeEach(async ({request}) => {
  const response = await request.get(`${FIXTURE}/reset`);
  expect(response.ok()).toBeTruthy();
});

test('explicit MLR workflow assigns a clip and records through original Grid callbacks', async ({page, request}) => {
  await open(page);
  await page.locator('#mlr-workflow-track').selectOption('4');
  await page.locator('#mlr-workflow-clip').selectOption('7');
  await page.locator('#mlr-record-now').click();
  await waitForSequence(request, list => {
    const keys = list.filter(item => item.command?.target === 'grid' && item.command?.action === 'key').map(item => item.command.args);
    return keys.some(args => args.x === 7 && args.y === 5 && args.z === 1)
      && keys.some(args => args.x === 1 && args.y === 5 && args.z === 1)
      && keys.some(args => args.x === 16 && args.y === 5 && args.z === 1);
  });
  await expect(page.locator('#mlr-workflow-status')).toContainText('applied by norns');
});

test('explicit loop control emits the original same-row down down up up chord', async ({page, request}) => {
  await open(page);
  await page.locator('#mlr-workflow-track').selectOption('3');
  await page.locator('#mlr-loop-start').selectOption('4');
  await page.locator('#mlr-loop-end').selectOption('11');
  await page.locator('#mlr-loop-apply').click();
  await waitForSequence(request, list => {
    const matching = list.filter(item => item.command?.target === 'grid' && item.command?.args?.y === 4 && [4, 11].includes(item.command.args.x));
    return matching.slice(-4).map(item => [item.command.args.x, item.command.args.z]).join('|') === '4,1|11,1|11,0|4,0';
  });
});

test('clip clear selects the target region and deterministically drives E2 and K2', async ({page, request}) => {
  await open(page);
  await page.locator('#mlr-workflow-track').selectOption('1');
  await page.locator('#mlr-workflow-clip').selectOption('5');
  await page.locator('#mlr-clip-action').selectOption('clear');
  await page.locator('#mlr-clip-execute').click();
  await waitForSequence(request, list => {
    const commands = list.map(item => item.command);
    return commands.some(item => item?.target === 'grid' && item.args?.x === 5 && item.args?.y === 2)
      && commands.some(item => item?.target === 'control' && item.action === 'enc' && item.args?.n === 2 && item.args?.d === -127)
      && commands.some(item => item?.target === 'control' && item.action === 'enc' && item.args?.n === 2 && item.args?.d === 1)
      && commands.some(item => item?.target === 'control' && item.action === 'key' && item.args?.n === 2 && item.args?.z === 0);
  });
});
