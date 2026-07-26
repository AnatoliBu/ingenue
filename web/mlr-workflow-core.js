export class MlrWorkflowError extends Error {}

export const MLR_CLIP_ACTIONS = Object.freeze({load: 1, clear: 2, save: 3});
export const MLR_RESIZE_FACTORS = Object.freeze([0.5, 1, 2, 4, 8, 16]);

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MlrWorkflowError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function command(target, action, args) {
  return {target, action, args};
}

export function gridTap(port, x, y) {
  const p = integer(port, 'Grid port', 1, 4);
  const column = integer(x, 'Grid column', 1, 16);
  const row = integer(y, 'Grid row', 1, 8);
  return [
    command('grid', 'key', {port: p, x: column, y: row, z: 1}),
    command('grid', 'key', {port: p, x: column, y: row, z: 0}),
  ];
}

export function keyTap(key) {
  const n = integer(key, 'norns key', 1, 3);
  return [
    command('control', 'key', {n, z: 1}),
    command('control', 'key', {n, z: 0}),
  ];
}

export function encoderDelta(encoder, delta) {
  const n = integer(encoder, 'norns encoder', 1, 3);
  const d = integer(delta, 'encoder delta', -127, 127);
  return d === 0 ? [] : [command('control', 'enc', {n, d})];
}

export function viewPlan(port, view) {
  const column = {rec: 1, cut: 2, clip: 3}[String(view)];
  if (!column) throw new MlrWorkflowError('MLR view must be rec, cut or clip');
  return gridTap(port, column, 1);
}

export function selectClipPlan({port, track, clip}) {
  const row = integer(track, 'track', 1, 6) + 1;
  const slot = integer(clip, 'clip', 1, 7);
  return [...viewPlan(port, 'clip'), ...gridTap(port, slot, row)];
}

export function recordNowPlan({port, track, clip, armed = false, playing = false}) {
  const row = integer(track, 'track', 1, 6) + 1;
  const plan = [...selectClipPlan({port, track, clip}), ...viewPlan(port, 'rec')];
  if (!armed) plan.push(...gridTap(port, 1, row));
  if (!playing) plan.push(...gridTap(port, 16, row));
  return plan;
}

export function stopRecordingPlan({port, track, armed = true}) {
  if (!armed) return [];
  const row = integer(track, 'track', 1, 6) + 1;
  return [...viewPlan(port, 'rec'), ...gridTap(port, 1, row)];
}

export function toggleTrackPlan({port, track}) {
  const row = integer(track, 'track', 1, 6) + 1;
  return [...viewPlan(port, 'rec'), ...gridTap(port, 16, row)];
}

export function cutPlan({port, track, position}) {
  const row = integer(track, 'track', 1, 6) + 1;
  const column = integer(position, 'cut position', 1, 16);
  return [...viewPlan(port, 'cut'), ...gridTap(port, column, row)];
}

export function loopPlan({port, track, start, end}) {
  const p = integer(port, 'Grid port', 1, 4);
  const row = integer(track, 'track', 1, 6) + 1;
  const first = integer(start, 'loop start', 1, 16);
  const second = integer(end, 'loop end', 1, 16);
  if (first === second) throw new MlrWorkflowError('loop start and end must be different');
  return [
    ...viewPlan(p, 'cut'),
    command('grid', 'key', {port: p, x: first, y: row, z: 1}),
    command('grid', 'key', {port: p, x: second, y: row, z: 1}),
    command('grid', 'key', {port: p, x: second, y: row, z: 0}),
    command('grid', 'key', {port: p, x: first, y: row, z: 0}),
  ];
}

export function clipActionPlan({port, track, clip, action}) {
  const target = MLR_CLIP_ACTIONS[String(action)];
  if (!target) throw new MlrWorkflowError('clip action must be load, clear or save');
  return [
    ...selectClipPlan({port, track, clip}),
    ...encoderDelta(2, -127),
    ...encoderDelta(2, target - 1),
    ...keyTap(2),
  ];
}

export function resizeClipPlan({port, track, clip, factor}) {
  const numeric = Number(factor);
  const index = MLR_RESIZE_FACTORS.indexOf(numeric);
  if (index < 0) throw new MlrWorkflowError('clip resize factor is unsupported');
  return [
    ...selectClipPlan({port, track, clip}),
    ...encoderDelta(3, -127),
    ...encoderDelta(3, index),
    ...keyTap(3),
  ];
}

export function clearWholeBufferPlan(port) {
  const p = integer(port, 'Grid port', 1, 4);
  return [
    command('grid', 'key', {port: p, x: 16, y: 1, z: 1}),
    ...gridTap(p, 1, 1),
    command('grid', 'key', {port: p, x: 16, y: 1, z: 0}),
  ];
}
