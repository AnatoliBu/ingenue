import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {AppliedValueLane} from './performance-core.js';
import {
  controlModel,
  normalizeCatalog,
  normalizedForOption,
  optionIndexForNormalized,
} from './params-core.js';

function command(session, action, args = {}) {
  return session.command({target: 'param', action, args});
}

function setReady(root, ready) {
  root.body?.toggleAttribute('data-ready', ready);
  root.querySelectorAll('[data-param-control]').forEach(element => {
    if ('disabled' in element) element.disabled = !ready;
    element.dataset.disabled = ready ? 'false' : 'true';
  });
}

function valueLabel(item) {
  return item.formatted || item.valueText || item.normalized.toFixed(3);
}

function createHeading(item) {
  const heading = document.createElement(item.kind === 'group' ? 'h2' : 'h3');
  heading.className = `params-${item.kind}`;
  heading.textContent = item.name;
  return heading;
}

function createShell(item) {
  const shell = document.createElement('article');
  shell.className = `param-card param-${item.kind}`;
  shell.dataset.paramId = item.id;
  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = item.name;
  title.title = item.id;
  const output = document.createElement('output');
  output.className = 'param-value';
  output.textContent = valueLabel(item);
  header.append(title, output);
  const body = document.createElement('div');
  body.className = 'param-control';
  shell.append(header, body);
  return {shell, body, output};
}

function createControl(item, session, settlements, lanes) {
  const model = controlModel(item);
  if (model.surface === 'heading') return createHeading(item);
  const {shell, body, output} = createShell(item);

  if (model.surface === 'trigger') {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.paramControl = '';
    button.textContent = 'trigger';
    button.addEventListener('click', () => command(session, 'trigger', {id: item.id}));
    body.append(button);
    return shell;
  }

  const lane = new AppliedValueLane(value => {
    const id = command(session, 'set_normalized', {id: item.id, value});
    settlements.set(id, lane);
    return id;
  });
  lane.lastApplied = item.normalized;
  lanes.set(item.id, {lane, item, output, shell});

  if (model.surface === 'toggle') {
    const label = document.createElement('label');
    label.className = 'param-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.paramControl = '';
    checkbox.checked = model.checked;
    checkbox.addEventListener('change', () => lane.push(checkbox.checked ? 1 : 0));
    const caption = document.createElement('span');
    caption.textContent = checkbox.checked ? 'on' : 'off';
    checkbox.addEventListener('change', () => { caption.textContent = checkbox.checked ? 'on' : 'off'; });
    label.append(checkbox, caption);
    body.append(label);
    return shell;
  }

  if (model.surface === 'option') {
    const select = document.createElement('select');
    select.dataset.paramControl = '';
    model.options.forEach((label, index) => {
      const option = document.createElement('option');
      option.value = String(index + 1);
      option.textContent = label;
      select.append(option);
    });
    select.value = String(model.selected);
    select.addEventListener('change', () => {
      lane.push(normalizedForOption(Number(select.value), model.options.length));
    });
    body.append(select);
    return shell;
  }

  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '1';
  range.step = item.kind === 'number' ? '0.001' : '0.0001';
  range.value = String(model.value);
  range.dataset.paramControl = '';
  range.addEventListener('input', () => lane.push(Number(range.value)));
  const bounds = document.createElement('div');
  bounds.className = 'param-bounds';
  const minimum = document.createElement('span');
  minimum.textContent = item.minText;
  const maximum = document.createElement('span');
  maximum.textContent = item.maxText;
  bounds.append(minimum, maximum);
  body.append(range, bounds);
  return shell;
}

function updateFromDescriptor(entry, descriptor) {
  if (!entry || !descriptor || descriptor.id !== entry.item.id) return;
  entry.item.normalized = descriptor.normalized;
  entry.item.formatted = descriptor.formatted;
  entry.item.valueText = descriptor.value_text;
  entry.output.textContent = descriptor.formatted || descriptor.value_text || descriptor.normalized.toFixed(3);
  const control = entry.shell.querySelector('[data-param-control]');
  if (!control) return;
  if (control.type === 'range') control.value = String(descriptor.normalized);
  else if (control.type === 'checkbox') control.checked = descriptor.normalized >= 0.5;
  else if (control.tagName === 'SELECT') {
    control.value = String(optionIndexForNormalized(descriptor.normalized, entry.item.options.length));
  }
}

export function mountParamsSurface(root = document, options = {}) {
  const url = options.url || realtimeUrl(options.locationLike || location);
  const session = options.session || new RealtimeSession({
    socketFactory: value => new WebSocket(value),
    url,
    channels: ['device', 'script', 'params'],
  });
  const status = root.getElementById('params-status');
  const revision = root.getElementById('params-revision');
  const script = root.getElementById('params-script');
  const endpoint = root.getElementById('params-endpoint');
  const refresh = root.getElementById('params-refresh');
  const filter = root.getElementById('params-filter');
  const catalogEl = root.getElementById('params-catalog');
  const notice = root.getElementById('params-notice');
  endpoint.textContent = url;

  let generation = null;
  let catalog = null;
  let requestedGeneration = null;
  const settlements = new Map();
  const lanes = new Map();

  const render = () => {
    lanes.clear();
    settlements.clear();
    catalogEl.replaceChildren();
    if (!catalog || catalog.items.length === 0) {
      notice.textContent = catalog ? 'The active script published no supported parameters.' : 'Waiting for the parameter catalog…';
      return;
    }
    const query = filter.value.trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    for (const item of catalog.items) {
      const structural = item.kind === 'group' || item.kind === 'separator';
      if (query && !structural && !`${item.name} ${item.id}`.toLowerCase().includes(query)) continue;
      fragment.append(createControl(item, session, settlements, lanes));
    }
    catalogEl.append(fragment);
    notice.textContent = `${catalog.items.length} catalog entries · generation ${catalog.generation}`;
    setReady(root, session.state.status === 'synced');
  };

  const requestCatalog = () => {
    requestedGeneration = generation;
    command(session, 'catalog');
    notice.textContent = 'Refreshing parameter catalog…';
  };

  refresh.addEventListener('click', requestCatalog);
  filter.addEventListener('input', render);

  session.addEventListener('state', event => {
    const state = event.detail;
    const ready = state.status === 'synced' && Boolean(state.data);
    status.textContent = state.status;
    revision.textContent = state.revision ?? '—';
    script.textContent = ready && state.data.script?.active ? state.data.script.name : 'no active script';
    setReady(root, ready);
    if (!ready) {
      notice.textContent = state.status === 'reconnecting'
        ? 'Connection lost. Continuous controls will converge after reconnect.'
        : 'Waiting for authoritative session state…';
      return;
    }
    try {
      const next = normalizeCatalog(state.data.params);
      if (next.generation !== generation) {
        generation = next.generation;
        catalog = next;
        render();
        if (generation === 'none' && requestedGeneration !== generation) requestCatalog();
      } else if (!catalog && requestedGeneration !== generation) {
        requestCatalog();
      }
    } catch (error) {
      notice.textContent = `Parameter catalog error: ${error.message}`;
    }
  });

  session.addEventListener('command', event => {
    const detail = event.detail;
    const lane = settlements.get(detail.id);
    if (lane) {
      settlements.delete(detail.id);
      const next = lane.settle(detail.id, detail.status);
      if (next) settlements.set(next, lane);
    }
    if (detail.result?.param) updateFromDescriptor(lanes.get(detail.result.param.id), detail.result.param);
    if (detail.status === 'reject' || detail.status === 'uncertain') {
      notice.textContent = detail.error || `Parameter command ${detail.status}`;
    }
  });
  session.addEventListener('protocolerror', event => {
    notice.textContent = `Protocol error: ${event.detail.message}`;
  });

  setReady(root, false);
  session.connect();
  return session;
}
