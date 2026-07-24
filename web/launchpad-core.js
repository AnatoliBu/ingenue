export class LaunchpadError extends Error {}

export const LAUNCHPAD_SIZE = 8;
export const MAX_GRID_SIZE = 32;

function integer(value, label, low, high) {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new LaunchpadError(`${label} must be an integer between ${low} and ${high}`);
  }
  return value;
}

function localCoordinate(value, label) {
  return integer(value, label, 1, LAUNCHPAD_SIZE);
}

export function pageCount(size) {
  const normalized = integer(size, 'grid size', 1, MAX_GRID_SIZE);
  return Math.ceil(normalized / LAUNCHPAD_SIZE);
}

export function normalizeLaunchpadView(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LaunchpadError('Launchpad view must be an object');
  }
  const cols = integer(Number(raw.cols), 'grid columns', 1, MAX_GRID_SIZE);
  const rows = integer(Number(raw.rows), 'grid rows', 1, MAX_GRID_SIZE);
  const pagesX = pageCount(cols);
  const pagesY = pageCount(rows);
  const requestedX = Number.isSafeInteger(Number(raw.pageX)) ? Number(raw.pageX) : 0;
  const requestedY = Number.isSafeInteger(Number(raw.pageY)) ? Number(raw.pageY) : 0;
  const rotation = Number(raw.rotation ?? 0);
  integer(rotation, 'Launchpad rotation', 0, 3);
  return {
    cols,
    rows,
    pagesX,
    pagesY,
    pageX: Math.min(pagesX - 1, Math.max(0, requestedX)),
    pageY: Math.min(pagesY - 1, Math.max(0, requestedY)),
    rotation,
    flipX: Boolean(raw.flipX),
    flipY: Boolean(raw.flipY),
  };
}

export function transformLaunchpadCoordinate(x, y, rawView = {}) {
  let tx = localCoordinate(x, 'pad x');
  let ty = localCoordinate(y, 'pad y');
  const rotation = Number(rawView.rotation ?? 0);
  integer(rotation, 'Launchpad rotation', 0, 3);

  if (rawView.flipX) tx = LAUNCHPAD_SIZE + 1 - tx;
  if (rawView.flipY) ty = LAUNCHPAD_SIZE + 1 - ty;

  if (rotation === 1) return {x: LAUNCHPAD_SIZE + 1 - ty, y: tx};
  if (rotation === 2) return {x: LAUNCHPAD_SIZE + 1 - tx, y: LAUNCHPAD_SIZE + 1 - ty};
  if (rotation === 3) return {x: ty, y: LAUNCHPAD_SIZE + 1 - tx};
  return {x: tx, y: ty};
}

export function mapLaunchpadPad(x, y, rawView) {
  const view = normalizeLaunchpadView(rawView);
  const local = transformLaunchpadCoordinate(x, y, view);
  const gridX = view.pageX * LAUNCHPAD_SIZE + local.x;
  const gridY = view.pageY * LAUNCHPAD_SIZE + local.y;
  if (gridX > view.cols || gridY > view.rows) return null;
  return {x: gridX, y: gridY};
}

export function projectLaunchpadFrame(frame, rawView = {}) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new LaunchpadError('Grid frame is required');
  }
  const cols = integer(Number(frame.cols), 'grid columns', 1, MAX_GRID_SIZE);
  const rows = integer(Number(frame.rows), 'grid rows', 1, MAX_GRID_SIZE);
  if (!Array.isArray(frame.values) || frame.values.length !== cols * rows) {
    throw new LaunchpadError('Grid frame values do not match its dimensions');
  }
  const view = normalizeLaunchpadView({...rawView, cols, rows});
  const values = [];
  const valid = [];
  for (let y = 1; y <= LAUNCHPAD_SIZE; y += 1) {
    for (let x = 1; x <= LAUNCHPAD_SIZE; x += 1) {
      const mapped = mapLaunchpadPad(x, y, view);
      valid.push(Boolean(mapped));
      values.push(mapped ? frame.values[(mapped.y - 1) * cols + mapped.x - 1] : 0);
    }
  }
  return {view, values, valid};
}

export function pageRail(totalPages, activePage) {
  const count = integer(totalPages, 'page count', 1, 8);
  const current = integer(activePage, 'active page', 0, count - 1);
  return Array.from({length: 8}, (_, index) => ({
    page: index,
    enabled: index < count,
    active: index === current,
    label: index < count ? String(index + 1) : '',
  }));
}
