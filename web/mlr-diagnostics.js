import {selectMlrGridPort} from './mlr-core.js';

const LOG_PREFIX = '[ingenue mlr]';

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function scriptIdentity(data) {
  const script = plainObject(data?.script) ? data.script : {};
  return String(script.shortname || script.name || '').trim().toLowerCase();
}

function exactMlrIdentity(identity) {
  const parts = String(identity || '').split('/').filter(Boolean);
  return parts.at(-1) === 'mlr';
}

function telemetryField(item) {
  if (!plainObject(item)) return false;
  return [
    'has_audio',
    'recorded_length',
    'recorded_seconds',
    'peak',
    'rms',
    'waveform',
    'samples',
  ].some(name => Object.hasOwn(item, name));
}

export function hasMlrAudioTelemetry(rawMlr) {
  if (!plainObject(rawMlr)) return false;
  if (telemetryField(rawMlr.audio)) return true;
  const clips = plainObject(rawMlr.clips) ? Object.values(rawMlr.clips) : [];
  return clips.some(telemetryField);
}

export function inspectMlrAvailability(data) {
  const runtimeAvailable = plainObject(data);
  const identity = scriptIdentity(data);
  const scriptActive = Boolean(data?.script?.active);
  const scriptIsMlr = scriptActive && exactMlrIdentity(identity);
  const rawMlr = plainObject(data?.mlr) ? data.mlr : null;
  const observerActive = Boolean(rawMlr?.active);
  const active = observerActive && (scriptIsMlr || !identity);
  const ports = plainObject(data?.grid?.ports) ? data.grid.ports : {};
  const gridPort = selectMlrGridPort(ports);
  return Object.freeze({
    runtimeAvailable,
    identity,
    scriptActive,
    scriptIsMlr,
    observerPresent: Boolean(rawMlr),
    observerActive,
    active,
    gridPort,
    gridAvailable: gridPort != null,
    audioTelemetry: hasMlrAudioTelemetry(rawMlr),
  });
}

export function mlrControlPolicy(availability) {
  const nativeReady = Boolean(availability?.runtimeAvailable);
  const gridReady = nativeReady && Boolean(availability?.gridAvailable);
  const richReady = Boolean(availability?.active);
  return Object.freeze({
    keys: nativeReady,
    encoders: nativeReady,
    grid: gridReady,
    workflow: gridReady && richReady,
  });
}

export class MlrDiagnosticLatch {
  constructor(emit) {
    if (typeof emit !== 'function') throw new TypeError('diagnostic emitter is required');
    this.emit = emit;
    this.active = new Map();
  }

  update(key, problem, {
    event,
    detail = undefined,
    recoveryEvent = `${event} resolved`,
    recoveryDetail = undefined,
  }) {
    const name = String(key);
    if (problem) {
      if (this.active.has(name)) return false;
      this.active.set(name, {event, recoveryEvent});
      this.emit('warn', event, detail);
      return true;
    }
    const previous = this.active.get(name);
    if (!previous) return false;
    this.active.delete(name);
    this.emit('info', recoveryEvent || previous.recoveryEvent, recoveryDetail);
    return true;
  }

  forget(key) {
    return this.active.delete(String(key));
  }

  has(key) {
    return this.active.has(String(key));
  }
}

function diagnosticEntry(session, globalLike, level, event, detail) {
  const fallback = Object.freeze({
    sequence: null,
    at: Date.now(),
    level,
    event,
    ...(detail === undefined ? {} : {detail}),
  });
  let entry = fallback;
  try {
    entry = session?.events?.append?.(level, event, detail) || fallback;
    const CustomEventCtor = globalLike?.CustomEvent;
    if (typeof session?.dispatchEvent === 'function' && typeof CustomEventCtor === 'function') {
      session.dispatchEvent(new CustomEventCtor('runtimeevent', {detail: entry}));
    }
  } catch {}
  const logger = globalLike?.console;
  const method = logger?.[level] || logger?.log;
  if (typeof method === 'function') {
    try {
      if (detail === undefined) method.call(logger, LOG_PREFIX, event);
      else method.call(logger, LOG_PREFIX, event, detail);
    } catch {}
  }
  return entry;
}

function setDisabled(element, disabled) {
  if (!element) return;
  if ('disabled' in element) element.disabled = Boolean(disabled);
  element.dataset.disabled = disabled ? 'true' : 'false';
}

function unavailableMessage(root, text) {
  const message = root.createElement('p');
  message.className = 'mlr-notice';
  message.dataset.mlrUnavailable = 'true';
  message.textContent = text;
  return message;
}

function clearInactiveRichSurface(root) {
  const placeholders = [
    ['#mlr-tracks', 'No authoritative MLR track state.'],
    ['#mlr-clips', 'No authoritative MLR clip state.'],
    ['#mlr-patterns', 'No authoritative MLR pattern state.'],
    ['#mlr-recalls', 'No authoritative MLR recall state.'],
  ];
  for (const [selector, text] of placeholders) {
    const container = root.querySelector(selector);
    if (!container) continue;
    container.replaceChildren(unavailableMessage(root, text));
  }
  const values = {
    '#mlr-view': '—',
    '#mlr-focus': '—',
    '#mlr-alt': '—',
    '#mlr-quantize': '—',
    '#mlr-help': 'Native Grid/K/E remain available. Launch MLR only for the optional rich view.',
  };
  for (const [selector, value] of Object.entries(values)) {
    const element = root.querySelector(selector);
    if (element) element.textContent = value;
  }
}

function applyAvailability(root, availability) {
  const policy = mlrControlPolicy(availability);
  root.querySelectorAll('[data-key]').forEach(element => setDisabled(element, !policy.keys));
  root.querySelectorAll('[data-encoder]').forEach(element => setDisabled(element, !policy.encoders));
  root.querySelectorAll('.mlr-pad').forEach(element => setDisabled(element, !policy.grid));
  root.querySelectorAll('#mlr-workflow button, #mlr-workflow select, #mlr-workflow input')
    .forEach(element => setDisabled(element, !policy.workflow));
  root.body?.toggleAttribute('data-mlr-ready', policy.workflow);
  root.body?.toggleAttribute('data-native-grid-ready', policy.grid);
  if (root.body) {
    root.body.dataset.nativeControls = policy.keys ? 'available' : 'unavailable';
    root.body.dataset.mlrAuthority = availability.active ? 'authoritative' : 'unavailable';
    root.body.dataset.mlrAudioObserved = availability.audioTelemetry ? 'true' : 'false';
  }
  if (!availability.active) clearInactiveRichSurface(root);
}

function debugEnabled(globalLike) {
  try {
    const value = new URLSearchParams(globalLike?.location?.search || '').get('debug') || '';
    return value.split(',').some(item => ['mlr', 'all', '1', 'true'].includes(item.trim().toLowerCase()));
  } catch {
    return false;
  }
}

export function installMlrDiagnostics(session, {
  root = document,
  globalLike = globalThis,
  debugIntervalMs = 2000,
} = {}) {
  if (!session || typeof session.addEventListener !== 'function') {
    throw new TypeError('MLR diagnostics require a realtime session');
  }
  const emit = (level, event, detail) => diagnosticEntry(session, globalLike, level, event, detail);
  const latch = new MlrDiagnosticLatch(emit);
  const verbose = debugEnabled(globalLike);
  let lastDebugAt = -Infinity;

  const update = event => {
    const state = event?.detail || session.state || {};
    if (state.status !== 'synced' || !state.data) return;
    const availability = inspectMlrAvailability(state.data);
    applyAvailability(root, availability);

    latch.update('script', !availability.active && !availability.scriptIsMlr, {
      event: 'mlr rich view inactive',
      detail: {
        revision: state.revision ?? null,
        active_script: availability.identity || null,
        impact: 'Optional MLR track/clip state and workflow are unavailable; native Grid/K/E remain available',
        action: 'Launch upstream mlr only when the optional rich workflow is needed',
      },
      recoveryEvent: 'mlr rich view active',
      recoveryDetail: {revision: state.revision ?? null, script: availability.identity || 'mlr'},
    });

    if (availability.scriptIsMlr) {
      latch.update('observer', !availability.observerActive, {
        event: 'mlr observer unavailable',
        detail: {
          revision: state.revision ?? null,
          impact: 'Native Grid/K/E remain available, but the optional MLR rich state was not received',
          action: 'Restart matron once after enabling the Ingenue mod if the rich view is required',
        },
        recoveryEvent: 'mlr observer recovered',
        recoveryDetail: {revision: state.revision ?? null},
      });
    } else {
      latch.forget('observer');
    }

    latch.update('grid', !availability.gridAvailable, {
      event: 'native 16x8 grid unavailable',
      detail: {
        revision: state.revision ?? null,
        expected: 'one authoritative 16×8 Grid vport',
        impact: 'Native Grid input and LED rendering are unavailable; K/E remain available',
      },
      recoveryEvent: 'native 16x8 grid recovered',
      recoveryDetail: {revision: state.revision ?? null, port: availability.gridPort},
    });

    if (availability.active) {
      latch.update('audio', !availability.audioTelemetry, {
        event: 'mlr audio visualization unavailable',
        detail: {
          revision: state.revision ?? null,
          impact: 'Clip cards cannot prove that audio was recorded; playback remains authoritative',
          missing: ['has_audio', 'recorded_length', 'peak/rms', 'waveform'],
          action: 'Use audio for now; softcut render telemetry is not implemented yet',
        },
        recoveryEvent: 'mlr audio visualization available',
        recoveryDetail: {revision: state.revision ?? null},
      });
    } else {
      latch.forget('audio');
    }

    const now = Date.now();
    if (verbose && now - lastDebugAt >= debugIntervalMs) {
      lastDebugAt = now;
      emit('debug', 'mlr availability snapshot', {
        revision: state.revision ?? null,
        ...availability,
      });
    }
  };

  session.addEventListener('state', update);
  update({detail: session.state});
  return {
    update,
    destroy() {
      session.removeEventListener('state', update);
    },
    latch,
  };
}
