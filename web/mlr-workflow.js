import {
  MlrWorkflowError,
  clearWholeBufferPlan,
  clipActionPlan,
  cutPlan,
  loopPlan,
  recordNowPlan,
  resizeClipPlan,
  selectClipPlan,
  stopRecordingPlan,
  toggleTrackPlan,
} from './mlr-workflow-core.js';

const COMMAND_TIMEOUT_MS = 5000;

function selectedNumber(element) { return Number(element?.value); }
function trackState(session, track) { return session?.state?.data?.mlr?.tracks?.[String(track)] || null; }

function selectGridPort(session) {
  const ports = session?.state?.data?.grid?.ports || {};
  const entries = Object.entries(ports)
    .map(([key, value]) => [Number(key), value])
    .filter(([port, value]) => Number.isSafeInteger(port) && port >= 1 && port <= 4 && value?.cols === 16 && value?.rows === 8)
    .sort(([left], [right]) => left - right);
  return entries.find(([, value]) => value?.virtual)?.[0] ?? entries[0]?.[0] ?? null;
}

function commandLabel(command) { return `${command.target}.${command.action}`; }

class WorkflowRunner {
  constructor(session, onState) {
    this.session = session;
    this.onState = onState;
    this.tail = Promise.resolve();
  }

  enqueue(label, plan) {
    this.tail = this.tail.catch(() => {}).then(() => this.run(label, plan));
    return this.tail;
  }

  async run(label, plan) {
    if (!Array.isArray(plan) || plan.length === 0) {
      this.onState({kind: 'info', text: `${label}: already in the requested state`});
      return;
    }
    this.onState({kind: 'busy', text: `${label} · 0/${plan.length}`});
    for (let index = 0; index < plan.length; index += 1) {
      const command = plan[index];
      await this.settle(command);
      this.onState({kind: 'busy', text: `${label} · ${index + 1}/${plan.length}`});
    }
    this.onState({kind: 'ok', text: `${label} applied by norns`});
  }

  settle(command) {
    return new Promise((resolve, reject) => {
      let id;
      let timer;
      const cleanup = () => {
        globalThis.clearTimeout(timer);
        this.session.removeEventListener('command', onCommand);
      };
      const onCommand = event => {
        if (event.detail?.id !== id) return;
        cleanup();
        if (event.detail.status === 'ack') resolve(event.detail);
        else {
          const failure = event.detail.failure || {};
          const error = new Error(failure.message || event.detail.error || `Command ${event.detail.status}`);
          error.code = failure.code || event.detail.errorCode || 'runtime-error';
          error.command = commandLabel(command);
          reject(error);
        }
      };
      this.session.addEventListener('command', onCommand);
      try { id = this.session.command(command); }
      catch (error) { cleanup(); reject(error); return; }
      timer = globalThis.setTimeout(() => {
        cleanup();
        const error = new Error('browser did not receive a command settlement');
        error.code = 'browser-timeout';
        error.command = commandLabel(command);
        reject(error);
      }, COMMAND_TIMEOUT_MS);
    });
  }
}

function mount(session, root = document) {
  const panel = root.getElementById('mlr-workflow');
  if (!panel || panel.dataset.mounted === 'true') return;
  panel.dataset.mounted = 'true';

  const track = root.getElementById('mlr-workflow-track');
  const clip = root.getElementById('mlr-workflow-clip');
  const cut = root.getElementById('mlr-workflow-cut');
  const loopStart = root.getElementById('mlr-loop-start');
  const loopEnd = root.getElementById('mlr-loop-end');
  const action = root.getElementById('mlr-clip-action');
  const resize = root.getElementById('mlr-clip-resize-factor');
  const status = root.getElementById('mlr-workflow-status');
  const authority = root.getElementById('mlr-workflow-authority');
  const current = root.getElementById('mlr-workflow-current');
  const controls = [...panel.querySelectorAll('button, select, input')];

  const setStatus = ({kind = 'info', text}) => {
    status.dataset.kind = kind;
    status.textContent = text;
  };
  const runner = new WorkflowRunner(session, setStatus);

  const snapshot = () => {
    const port = selectGridPort(session);
    const selectedTrack = selectedNumber(track);
    const selectedClip = selectedNumber(clip);
    const state = trackState(session, selectedTrack);
    if (!port) throw new MlrWorkflowError('MLR needs an authoritative 16×8 Grid port');
    return {port, track: selectedTrack, clip: selectedClip, state};
  };

  const execute = (label, build) => {
    let plan;
    try { plan = build(snapshot()); }
    catch (error) { setStatus({kind: 'error', text: `${error.code || 'validation'}: ${error.message}`}); return; }
    controls.forEach(control => { if ('disabled' in control) control.disabled = true; });
    runner.enqueue(label, plan).catch(error => {
      setStatus({kind: 'error', text: `${error.code || 'runtime-error'} · ${error.command || label}: ${error.message}`});
    }).finally(() => render());
  };

  const render = () => {
    const port = selectGridPort(session);
    const selectedTrack = selectedNumber(track);
    const state = trackState(session, selectedTrack);
    const ready = session.state?.status === 'synced' && Boolean(session.state?.data?.mlr?.active) && Boolean(port);
    controls.forEach(control => { if ('disabled' in control) control.disabled = !ready; });
    if (!ready) {
      current.textContent = 'optional rich workflow waiting for active MLR and a 16×8 Grid';
      authority.textContent = `runtime ${session.state?.status || 'connecting'}`;
      return;
    }
    const owner = session.state.data?.ownership?.resources?.[`grid:${port}`]?.client_id || null;
    authority.textContent = owner && owner !== session.clientId
      ? `Grid ${port} owned by another browser`
      : `Grid ${port} · this tab`;
    if (!state) {
      current.textContent = `T${selectedTrack} state unavailable`;
      return;
    }
    current.textContent = `T${selectedTrack} → C${state.clip} · ${state.rec ? 'REC armed' : 'REC safe'} · ${state.play ? 'playing' : 'stopped'} · ${state.loop ? `loop ${state.loop_start}–${state.loop_end}` : 'full clip'}`;
    root.getElementById('mlr-record-now').textContent = state.rec && state.play ? 'Recording now' : 'Record into selected clip';
    root.getElementById('mlr-stop-record').disabled = !state.rec;
    root.getElementById('mlr-toggle-track').textContent = state.play ? 'Stop track' : 'Start track';
  };

  root.getElementById('mlr-assign-clip').addEventListener('click', () => execute('assign clip', ({port, track, clip}) => selectClipPlan({port, track, clip})));
  root.getElementById('mlr-record-now').addEventListener('click', () => execute('record', ({port, track, clip, state}) => recordNowPlan({port, track, clip, armed: Boolean(state?.rec), playing: Boolean(state?.play)})));
  root.getElementById('mlr-stop-record').addEventListener('click', () => execute('stop recording', ({port, track, state}) => stopRecordingPlan({port, track, armed: Boolean(state?.rec)})));
  root.getElementById('mlr-toggle-track').addEventListener('click', () => execute('toggle track', ({port, track}) => toggleTrackPlan({port, track})));
  root.getElementById('mlr-cut-play').addEventListener('click', () => execute('cut and play', ({port, track}) => cutPlan({port, track, position: selectedNumber(cut)})));
  root.getElementById('mlr-loop-apply').addEventListener('click', () => execute('set loop', ({port, track}) => loopPlan({port, track, start: selectedNumber(loopStart), end: selectedNumber(loopEnd)})));
  root.getElementById('mlr-clip-execute').addEventListener('click', () => execute(`clip ${action.value}`, ({port, track, clip}) => clipActionPlan({port, track, clip, action: action.value})));
  root.getElementById('mlr-clip-resize').addEventListener('click', () => execute('resize clip', ({port, track, clip}) => resizeClipPlan({port, track, clip, factor: Number(resize.value)})));
  root.getElementById('mlr-buffer-clear').addEventListener('click', () => {
    if (!globalThis.confirm?.('Clear the complete MLR softcut buffer? This destroys every clip region.')) return;
    execute('clear complete buffer', ({port}) => clearWholeBufferPlan(port));
  });
  track.addEventListener('change', render);
  clip.addEventListener('change', render);
  session.addEventListener('state', render);
  session.addEventListener('command', event => {
    if (event.detail?.status === 'reject' || event.detail?.status === 'uncertain') {
      const failure = event.detail.failure || {};
      setStatus({kind: 'error', text: `${failure.code || event.detail.errorCode || event.detail.status}: ${failure.message || event.detail.error || 'command failed'}`});
    }
  });
  render();
}

function waitForSession(root = document, attempt = 0) {
  const session = globalThis.ingenueDebug?.latest;
  if (session) { mount(session, root); return; }
  if (attempt >= 200) {
    const status = root.getElementById('mlr-workflow-status');
    if (status) { status.dataset.kind = 'error'; status.textContent = 'runtime session did not mount'; }
    return;
  }
  globalThis.setTimeout(() => waitForSession(root, attempt + 1), 25);
}

waitForSession();
