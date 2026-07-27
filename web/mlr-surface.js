import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {
  decodeMlrGridFrame,
  normalizeMlrState,
  selectMlrGridPort,
  selectMlrVirtualGridPort,
  viewHelp,
} from './mlr-core.js';

function send(session, target, action, args) { return session.command({target, action, args}); }
function chunkedDelta(session, encoder, delta) {
  let remaining = Math.trunc(delta);
  while (remaining !== 0) {
    const part = Math.max(-127, Math.min(127, remaining));
    send(session, 'control', 'enc', {n: encoder, d: part});
    remaining -= part;
  }
}
function setReady(root, ready) {
  root.querySelectorAll('[data-mlr-control]').forEach(element => {
    if ('disabled' in element) element.disabled = !ready;
    element.dataset.disabled = ready ? 'false' : 'true';
  });
  root.body?.toggleAttribute('data-mlr-ready', ready);
}
function disabled(element) { return Boolean(element?.disabled || element?.dataset?.disabled === 'true'); }
function padTarget(element, port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 4) throw new Error('virtual Grid input port unavailable');
  return {port, x: Number(element.dataset.x), y: Number(element.dataset.y)};
}
function samePad(left, right) { return Boolean(left && right && left.port === right.port && left.x === right.x && left.y === right.y); }
function scriptIdentity(script) { return String(script?.shortname || script?.name || '').trim().toLowerCase(); }
function isExactMlrScript(script) {
  if (!script?.active) return false;
  return scriptIdentity(script).split('/').filter(Boolean).at(-1) === 'mlr';
}

function bindMomentary(button, onChange) {
  const active = new Set();
  const press = (identity, event) => {
    if (disabled(button) || active.has(identity)) return;
    event?.preventDefault?.(); active.add(identity); button.dataset.pressed = 'true'; onChange(1);
  };
  const release = identity => {
    if (!active.delete(identity)) return false;
    if (active.size === 0) button.dataset.pressed = 'false';
    onChange(0); return true;
  };
  button.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    button.setPointerCapture?.(event.pointerId);
    press(`pointer:${event.pointerId}`, event);
  });
  const endPointer = event => release(`pointer:${event.pointerId}`);
  button.addEventListener('pointerup', endPointer);
  button.addEventListener('pointercancel', endPointer);
  button.addEventListener('lostpointercapture', endPointer);
  button.addEventListener('keydown', event => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) press(`key:${event.key}`, event);
  });
  button.addEventListener('keyup', event => {
    if (event.key === ' ' || event.key === 'Enter') release(`key:${event.key}`);
  });
  return {releaseAll() { for (const identity of [...active]) release(identity); button.dataset.pressed = 'false'; }};
}

function bindEncoder(control, encoder, session) {
  const dial = control.querySelector('.mlr-encoder-dial') || control;
  let gesture = null;
  const emit = delta => chunkedDelta(session, encoder, delta);
  control.tabIndex = 0;
  control.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
  control.addEventListener('pointerdown', event => {
    if (disabled(control) || event.button > 0 || event.target.closest('button')) return;
    event.preventDefault(); control.setPointerCapture?.(event.pointerId);
    gesture = {pointerId: event.pointerId, y: event.clientY, remainder: 0};
    control.dataset.pressed = 'true';
  });
  control.addEventListener('pointermove', event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const total = (gesture.y - event.clientY) / 14 + gesture.remainder;
    const delta = Math.trunc(total);
    gesture.remainder = total - delta; gesture.y = event.clientY;
    if (delta) emit(delta);
  });
  const finish = event => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gesture = null; control.dataset.pressed = 'false';
    try { control.releasePointerCapture?.(event.pointerId); } catch {}
  };
  control.addEventListener('pointerup', finish);
  control.addEventListener('pointercancel', finish);
  control.addEventListener('lostpointercapture', finish);
  control.addEventListener('wheel', event => {
    if (disabled(control)) return;
    event.preventDefault(); emit(event.deltaY < 0 ? 1 : -1);
  }, {passive: false});
  control.addEventListener('keydown', event => {
    if (disabled(control) || event.repeat) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1;
    emit(direction * (event.shiftKey ? 8 : 1));
  });
  control.querySelector('[data-delta="-1"]')?.addEventListener('click', () => !disabled(control) && emit(-1));
  control.querySelector('[data-delta="1"]')?.addEventListener('click', () => !disabled(control) && emit(1));
  return {releaseAll() { gesture = null; control.dataset.pressed = 'false'; dial.dataset.pressed = 'false'; }};
}

function createGridController(root, session, getPort) {
  const container = root.getElementById('mlr-grid');
  const pointers = new Map();
  let loopAnchor = null;
  const command = (target, z) => send(session, 'grid', 'key', {...target, z});
  const mark = (target, pressed) => {
    const pad = container.querySelector(`[data-x="${target.x}"][data-y="${target.y}"]`);
    if (pad) pad.dataset.pressed = pressed ? 'true' : 'false';
  };
  const press = (identity, target) => {
    const current = pointers.get(identity);
    if (samePad(current, target)) return;
    if (current) { command(current, 0); mark(current, false); }
    pointers.set(identity, target); command(target, 1); mark(target, true);
  };
  const release = identity => {
    const target = pointers.get(identity);
    if (!target) return false;
    pointers.delete(identity); command(target, 0); mark(target, false); return true;
  };
  const releaseAnchor = () => {
    if (!loopAnchor) return;
    command(loopAnchor, 0); mark(loopAnchor, false); loopAnchor = null;
  };
  const padAtPoint = (x, y) => root.elementFromPoint?.(x, y)?.closest?.('.mlr-pad') || null;

  container.addEventListener('pointerdown', event => {
    const pad = event.target.closest('.mlr-pad');
    if (!pad || disabled(pad) || event.button > 0) return;
    event.preventDefault();
    const target = padTarget(pad, getPort());
    if (event.shiftKey && event.pointerType !== 'touch') {
      if (loopAnchor && loopAnchor.y !== target.y) releaseAnchor();
      if (loopAnchor) {
        const identity = `loop:${event.pointerId}`;
        press(identity, target); pad.setPointerCapture?.(event.pointerId);
      } else {
        loopAnchor = target; command(target, 1); mark(target, true); pad.dataset.loopAnchor = 'true';
      }
      return;
    }
    const identity = `pointer:${event.pointerId}`;
    press(identity, target); container.setPointerCapture?.(event.pointerId);
  });
  container.addEventListener('pointermove', event => {
    const identity = `pointer:${event.pointerId}`;
    if (!pointers.has(identity)) return;
    const pad = padAtPoint(event.clientX, event.clientY);
    if (!pad || disabled(pad)) return;
    press(identity, padTarget(pad, getPort()));
  });
  const end = event => {
    const loopIdentity = `loop:${event.pointerId}`;
    if (pointers.has(loopIdentity)) {
      release(loopIdentity); releaseAnchor();
      container.querySelectorAll('[data-loop-anchor="true"]').forEach(pad => delete pad.dataset.loopAnchor);
      return;
    }
    release(`pointer:${event.pointerId}`);
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('lostpointercapture', end);
  return {releaseAll() {
    for (const identity of [...pointers.keys()]) release(identity);
    releaseAnchor();
    container.querySelectorAll('[data-pressed="true"]').forEach(pad => pad.dataset.pressed = 'false');
    container.querySelectorAll('[data-loop-anchor="true"]').forEach(pad => delete pad.dataset.loopAnchor);
  }};
}

function ensureGrid(root) {
  const container = root.getElementById('mlr-grid');
  if (container.childElementCount === 128) return;
  const fragment = document.createDocumentFragment();
  for (let y = 1; y <= 8; y += 1) for (let x = 1; x <= 16; x += 1) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'mlr-pad'; button.dataset.mlrControl = '';
    button.dataset.x = String(x); button.dataset.y = String(y); button.dataset.level = '0';
    button.setAttribute('aria-label', `Grid ${x}, ${y}`); fragment.append(button);
  }
  container.replaceChildren(fragment);
}
function renderGrid(root, frame) {
  ensureGrid(root);
  root.querySelectorAll('.mlr-pad').forEach((pad, index) => {
    const level = frame?.values?.[index] ?? 0;
    const intensity = frame?.intensity ?? 15;
    pad.dataset.level = String(level);
    pad.style.setProperty('--mlr-level', String(level * intensity / 225));
  });
}
function statusText(item) {
  const parts = [];
  if (item.recording || item.rec) parts.push('recording');
  if (item.playing || item.play) parts.push('playing');
  if (item.active) parts.push('active');
  if (item.has_data || item.count > 0 || item.event_count > 0) parts.push('stored');
  return parts.join(' · ') || 'empty';
}
function node(tag, className = '', textContent = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent != null) element.textContent = String(textContent);
  return element;
}

function renderMlrState(root, state) {
  root.getElementById('mlr-view').textContent = state.view_name.toUpperCase();
  root.getElementById('mlr-focus').textContent = `track ${state.focus}`;
  root.getElementById('mlr-alt').textContent = state.alt ? 'ALT held' : 'ALT off';
  root.getElementById('mlr-quantize').textContent = state.quantize ? 'quantized' : 'free';
  root.getElementById('mlr-help').textContent = viewHelp(state.view);

  const trackFragment = document.createDocumentFragment();
  for (const item of Object.values(state.tracks)) {
    const card = node('article', 'mlr-track');
    card.dataset.focused = item.index === state.focus ? 'true' : 'false';
    card.dataset.playing = item.play ? 'true' : 'false';
    card.dataset.recording = item.rec ? 'true' : 'false';
    const header = node('header');
    header.append(node('strong', '', `T${item.index}`), node('span', '', item.clip_name || `clip ${item.clip}`));
    const badges = node('div', 'mlr-track-badges');
    for (const label of [item.play ? 'play' : 'stop', item.rec ? 'rec' : 'safe', item.reverse ? 'reverse' : 'forward', item.tempo_map ? 'tempo map' : 'free rate']) badges.append(node('span', '', label));
    const loop = node('div', 'mlr-track-loop');
    const indicator = node('i');
    indicator.style.setProperty('--loop-left', `${item.loop_start * 6.25}%`);
    indicator.style.setProperty('--loop-right', `${(16 - item.loop_end) * 6.25}%`);
    const playhead = Math.max(0, Math.min(16, item.pos_grid));
    indicator.style.setProperty('--playhead-left', `${Math.max(0, playhead - item.loop_start) * 6.25}%`);
    loop.append(indicator);
    const details = node('dl');
    for (const [label, value] of [['speed', item.speed], ['clip', item.clip], ['loop', item.loop ? `${item.loop_start}–${item.loop_end}` : 'full'], ['level', item.volume.toFixed(2)]]) {
      const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); details.append(row);
    }
    card.append(header, badges, loop, details); trackFragment.append(card);
  }
  root.getElementById('mlr-tracks').replaceChildren(trackFragment);

  const clipFragment = document.createDocumentFragment();
  for (const item of Object.values(state.clips)) {
    const card = node('article', 'mlr-slot');
    card.append(node('strong', '', `C${item.index}`), node('span', '', item.name || '-'), node('small', '', `${item.length.toFixed(2)}s · ${item.bpm ? item.bpm.toFixed(1) + ' bpm' : '—'}`));
    clipFragment.append(card);
  }
  root.getElementById('mlr-clips').replaceChildren(clipFragment);
  for (const [kind, items] of [['patterns', state.patterns], ['recalls', state.recalls]]) {
    const fragment = document.createDocumentFragment();
    for (const item of Object.values(items)) {
      const card = node('article', 'mlr-memory');
      const current = statusText(item); card.dataset.state = current;
      card.append(node('strong', '', `${kind === 'patterns' ? 'P' : 'R'}${item.index}`), node('span', '', current), node('small', '', `${kind === 'patterns' ? item.count : item.event_count} events`));
      fragment.append(card);
    }
    root.getElementById(`mlr-${kind}`).replaceChildren(fragment);
  }
}

export function mountMlrSurface(root = document, options = {}) {
  const url = options.url || realtimeUrl(options.locationLike || location);
  const session = options.session || new RealtimeSession({socketFactory: value => new WebSocket(value), url, channels: ['device', 'control', 'script', 'grid', 'mlr']});
  const endpoint = root.getElementById('mlr-endpoint');
  const status = root.getElementById('mlr-status');
  const revision = root.getElementById('mlr-revision');
  const script = root.getElementById('mlr-script');
  const notice = root.getElementById('mlr-notice');
  endpoint.textContent = url; ensureGrid(root); setReady(root, false);

  let selectedDisplayPort = null;
  let selectedInputPort = null;
  const getPort = () => selectedInputPort;
  const releases = [createGridController(root, session, getPort)];
  root.querySelectorAll('[data-key]').forEach(button => {
    const key = Number(button.dataset.key);
    releases.push(bindMomentary(button, z => send(session, 'control', 'key', {n: key, z})));
  });
  root.querySelectorAll('[data-encoder]').forEach(control => releases.push(bindEncoder(control, Number(control.dataset.encoder), session)));
  const releaseAll = () => releases.forEach(item => item.releaseAll());
  globalThis.addEventListener?.('blur', releaseAll);
  globalThis.addEventListener?.('pagehide', releaseAll);
  globalThis.addEventListener?.('keydown', event => { if (event.key === 'Escape') releaseAll(); });
  root.addEventListener?.('visibilitychange', () => { if (root.visibilityState === 'hidden') releaseAll(); });

  session.addEventListener('state', event => {
    const state = event.detail;
    status.textContent = state.status; revision.textContent = state.revision ?? '—';
    const ready = state.status === 'synced' && Boolean(state.data); setReady(root, ready);
    if (!ready) {
      releaseAll();
      notice.textContent = state.status === 'reconnecting' ? 'Connection lost. Every native hold was released.' : 'Waiting for authoritative norns state…';
      return;
    }
    const activeScript = state.data.script;
    const activeScriptName = activeScript?.active ? activeScript.name : 'no active script';
    script.textContent = activeScriptName;
    const ports = state.data.grid?.ports || {};
    const previousInputPort = selectedInputPort;
    selectedDisplayPort = selectMlrGridPort(ports, selectedDisplayPort);
    selectedInputPort = selectMlrVirtualGridPort(ports, selectedInputPort);
    if (previousInputPort !== selectedInputPort) releaseAll();
    const rawFrame = selectedDisplayPort == null ? null : ports[String(selectedDisplayPort)];
    if (rawFrame) {
      try { renderGrid(root, decodeMlrGridFrame(rawFrame)); } catch (error) { notice.textContent = error.message; }
    } else renderGrid(root, null);

    let richActive = false;
    const rawMlr = state.data.mlr;
    if (rawMlr && typeof rawMlr === 'object' && !Array.isArray(rawMlr)) {
      try {
        const mlr = normalizeMlrState(rawMlr);
        richActive = mlr.active && (isExactMlrScript(activeScript) || !scriptIdentity(activeScript));
        if (richActive) renderMlrState(root, mlr);
        if (richActive) {
          if (selectedInputPort != null) {
            notice.textContent = `MLR ${mlr.version} · native virtual Grid port ${selectedInputPort} · optional rich state observed at norns`;
          } else if (rawFrame) {
            notice.textContent = `MLR ${mlr.version} · physical Grid port ${selectedDisplayPort} mirrored · browser Grid input unavailable`;
          }
        }
      } catch (error) {
        notice.textContent = `MLR rich-state error: ${error.message}. Native K/E and available Grid mirroring remain active.`;
      }
    }

    if (!richActive) {
      const identity = scriptIdentity(activeScript) || 'no active script';
      if (selectedInputPort != null) {
        notice.textContent = `Native virtual Grid port ${selectedInputPort} · ${identity} · optional MLR rich view unavailable`;
      } else if (rawFrame) {
        notice.textContent = `Physical Grid port ${selectedDisplayPort} mirrored · ${identity} · browser Grid input unavailable`;
      } else {
        notice.textContent = `No authoritative 16×8 Grid frame for ${identity}. K/E remain available.`;
      }
    }
    root.body?.toggleAttribute('data-mlr-active', richActive);
  });
  session.addEventListener('command', event => {
    if (event.detail.status === 'reject' || event.detail.status === 'uncertain') notice.textContent = event.detail.failure?.message || event.detail.error || `Command ${event.detail.status}`;
  });
  session.addEventListener('protocolerror', event => { notice.textContent = `Protocol error: ${event.detail.message}`; });
  session.connect(); return session;
}
