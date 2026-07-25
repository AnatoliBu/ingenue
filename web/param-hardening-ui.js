const PARAM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function finiteText(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function descriptorNumericValue(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  for (const candidate of [descriptor.value, descriptor.raw, descriptor.value_text]) {
    const parsed = finiteText(candidate);
    if (parsed != null) return parsed;
  }
  const normalized = finiteText(descriptor.normalized);
  const min = finiteText(descriptor.min_text);
  const max = finiteText(descriptor.max_text);
  if (normalized != null && normalized >= 0 && normalized <= 1 && min != null && max != null && min < max) {
    return min + (max - min) * normalized;
  }
  return null;
}

export function descriptorRange(descriptor) {
  const min = finiteText(descriptor?.min_text);
  const max = finiteText(descriptor?.max_text);
  return min != null && max != null && min < max ? {min, max} : null;
}

export function mountParamHardening(session, root = document) {
  if (!session || typeof session.command !== 'function') throw new TypeError('realtime session is required');
  const idInput = root.getElementById('param-id');
  const slider = root.getElementById('param-slider');
  const number = root.getElementById('param-number');
  const minInput = root.getElementById('param-min');
  const maxInput = root.getElementById('param-max');
  if (!idInput || !slider || !number || !minInput || !maxInput) return null;
  if (idInput.dataset.paramHardening === 'true') return idInput._ingenueParamHardening;
  idInput.dataset.paramHardening = 'true';

  const status = root.createElement('output');
  status.className = 'muted param-authority';
  status.setAttribute('aria-live', 'polite');
  status.style.display = 'block';
  status.style.marginTop = '10px';
  status.textContent = 'Waiting for authoritative parameter descriptor…';
  slider.closest('.param-grid')?.after(status);

  const lastApplied = new Map();
  let ready = false;
  let describedKey = null;

  const currentId = () => idInput.value.trim();
  const setValue = value => {
    if (!Number.isFinite(value)) return;
    const min = Number(minInput.value);
    const max = Number(maxInput.value);
    const bounded = Number.isFinite(min) && Number.isFinite(max) && min < max
      ? Math.min(max, Math.max(min, value))
      : value;
    slider.value = String(bounded);
    number.value = String(bounded);
  };

  const applyDescriptor = descriptor => {
    const id = String(descriptor?.id || '');
    if (!PARAM_ID.test(id)) return false;
    const range = descriptorRange(descriptor);
    if (range && id === currentId()) {
      minInput.value = String(range.min);
      maxInput.value = String(range.max);
      slider.min = String(range.min);
      slider.max = String(range.max);
    }
    const value = descriptorNumericValue(descriptor);
    if (value != null) {
      lastApplied.set(id, value);
      if (id === currentId()) setValue(value);
    }
    if (id === currentId()) {
      const formatted = String(descriptor.formatted || descriptor.value_text || value ?? '—');
      status.textContent = `${descriptor.name || id} · applied ${formatted}`;
      idInput.setCustomValidity('');
    }
    return true;
  };

  const describe = (force = false) => {
    const id = currentId();
    if (!ready || !PARAM_ID.test(id)) {
      if (id && !PARAM_ID.test(id)) {
        const message = 'Parameter ID may contain letters, numbers, underscore, dot, colon and dash.';
        idInput.setCustomValidity(message);
        status.textContent = message;
      }
      return null;
    }
    const runtime = session.state?.data?.runtime;
    const key = `${runtime?.session_generation || 'legacy'}:${runtime?.script_generation ?? 'legacy'}:${id}`;
    if (!force && key === describedKey) return null;
    describedKey = key;
    idInput.setCustomValidity('');
    status.textContent = `Reading ${id} from norns…`;
    return session.command({target: 'param', action: 'describe', args: {id}});
  };

  const onIdChange = () => {
    describedKey = null;
    describe(true);
  };
  idInput.addEventListener('change', onIdChange);
  idInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onIdChange();
  });

  const onState = event => {
    const nextReady = event.detail?.status === 'synced' && Boolean(event.detail?.data?.script?.active);
    if (!nextReady) {
      ready = false;
      describedKey = null;
      status.textContent = event.detail?.status === 'reconnecting'
        ? 'Connection lost; parameter writes are paused.'
        : 'Waiting for authoritative parameter state…';
      return;
    }
    const becameReady = !ready;
    ready = true;
    if (becameReady) describe(true);
  };

  const onCommand = event => {
    const detail = event.detail || {};
    const command = detail.command || {};
    if (command.target !== 'param') return;
    const id = String(command.args?.id || '');
    if (detail.result?.param) applyDescriptor(detail.result.param);
    if (detail.status === 'ack' && command.action === 'set') {
      const value = descriptorNumericValue(detail.result?.param) ?? finiteText(command.args?.value);
      if (value != null) {
        lastApplied.set(id, value);
        if (id === currentId()) setValue(value);
      }
      if (id === currentId() && !detail.result?.param) status.textContent = `${id} · applied ${value ?? command.args?.value}`;
    }
    if (detail.status === 'reject') {
      const applied = lastApplied.get(id);
      if (id === currentId() && Number.isFinite(applied)) setValue(applied);
      if (id === currentId()) status.textContent = detail.failure?.message || detail.error || 'Parameter command rejected by norns.';
    }
    if (detail.status === 'uncertain' && id === currentId()) {
      status.textContent = detail.failure?.message || 'Parameter acknowledgement was lost; latest value will be retried.';
    }
  };

  session.addEventListener('state', onState);
  session.addEventListener('command', onCommand);
  const api = {
    describe: () => describe(true),
    applyDescriptor,
    get lastApplied() { return new Map(lastApplied); },
    destroy() {
      idInput.removeEventListener('change', onIdChange);
      session.removeEventListener('state', onState);
      session.removeEventListener('command', onCommand);
      status.remove();
      delete idInput.dataset.paramHardening;
      delete idInput._ingenueParamHardening;
    },
  };
  idInput._ingenueParamHardening = api;
  return api;
}
