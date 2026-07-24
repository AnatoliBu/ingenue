import {RealtimeSession} from './realtime-session.js';
import {realtimeUrl} from './realtime-inspector.js';
import {AppliedValueLane, PressLedger} from './performance-core.js';
import {
  BuilderError,
  BuilderStore,
  appendBuilderWidget,
  createBuilderWidget,
  defaultBuilderSchema,
  moveBuilderWidget,
  parseBuilderSchema,
  removeBuilderWidget,
  serializeBuilderSchema,
  updateBuilderLayout,
  updateBuilderWidget,
  writableParameterOptions,
} from './builder-core.js';

function element(root, id) {
  const value = root.getElementById(id);
  if (!value) throw new BuilderError(`builder element #${id} is missing`);
  return value;
}

function option(value, label = value) {
  const node = document.createElement('option');
  node.value = String(value);
  node.textContent = String(label);
  return node;
}

function button(label, title = label) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.title = title;
  node.dataset.builderAction = '';
  return node;
}

function labelField(caption, control, full = false) {
  const label = document.createElement('label');
  if (full) label.className = 'full';
  const span = document.createElement('span');
  span.textContent = caption;
  label.append(span, control);
  return label;
}

function fileName(script) {
  const safe = String(script || 'surface').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'surface';
  return `${safe}-ingenue-ui.json`;
}

function formattedParameter(item, fallback) {
  return String(item?.formatted || item?.value_text || (Number.isFinite(fallback) ? fallback.toFixed(3) : '—'));
}

export function mountBuilderSurface(root = document, options = {}) {
  const locationLike = options.locationLike || globalThis.location;
  const url = options.url || realtimeUrl(locationLike);
  const session = options.session || new RealtimeSession({
    socketFactory: value => new WebSocket(value),
    url,
    channels: ['device', 'script', 'params', 'control'],
  });
  const store = options.store || new BuilderStore(options.storage || globalThis.localStorage);
  const navigatorLike = options.navigatorLike || globalThis.navigator;
  const confirmLike = options.confirmLike || globalThis.confirm?.bind(globalThis) || (() => true);

  const endpoint = element(root, 'builder-endpoint');
  const status = element(root, 'builder-status');
  const revision = element(root, 'builder-revision');
  const scriptEl = element(root, 'builder-script');
  const nameInput = element(root, 'builder-name');
  const columnsSelect = element(root, 'builder-columns');
  const editor = element(root, 'builder-editor');
  const count = element(root, 'builder-count');
  const preview = element(root, 'builder-preview');
  const previewName = element(root, 'builder-preview-name');
  const notice = element(root, 'builder-notice');
  const jsonArea = element(root, 'builder-json');
  const paramOptions = element(root, 'builder-param-options');
  const exportButton = element(root, 'builder-export');
  const copyButton = element(root, 'builder-copy');
  const downloadButton = element(root, 'builder-download');
  const importButton = element(root, 'builder-import');
  const resetButton = element(root, 'builder-reset');

  endpoint.textContent = url;

  let activeScript = null;
  let schema = null;
  let ready = false;
  let catalogGeneration = null;
  let catalogRequestedFor = null;
  let parameterDescriptors = new Map();
  let pressLedger = makePressLedger();
  const lanes = new Map();
  const settlements = new Map();

  function makePressLedger() {
    return new PressLedger((target, z) => {
      if (!ready) return;
      session.command({target: 'control', action: 'key', args: {n: target.n, z}});
    });
  }

  function setNotice(message, error = false) {
    notice.textContent = message || '';
    notice.dataset.error = error ? 'true' : 'false';
  }

  function setEditorEnabled(enabled) {
    root.querySelectorAll('[data-builder-action]').forEach(control => {
      if ('disabled' in control) control.disabled = !enabled;
    });
    nameInput.disabled = !enabled;
    columnsSelect.disabled = !enabled;
    jsonArea.disabled = !enabled;
  }

  function setPreviewEnabled(enabled) {
    ready = enabled;
    root.body?.toggleAttribute('data-builder-ready', enabled);
    preview.querySelectorAll('button,input').forEach(control => { control.disabled = !enabled; });
  }

  function nextWidgetId() {
    const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `w-${token}`.slice(0, 64);
  }

  function persist(next, message = 'Surface saved for this script.') {
    schema = store.save(next);
    renderAll();
    setNotice(message);
    return schema;
  }

  function mutate(operation, message) {
    if (!schema || !activeScript) return;
    try { persist(operation(schema), message); }
    catch (error) { setNotice(`Builder change rejected: ${error.message}`, true); }
  }

  function loadScript(script) {
    pressLedger.releaseAll();
    pressLedger = makePressLedger();
    lanes.clear();
    settlements.clear();
    activeScript = script;
    catalogGeneration = null;
    catalogRequestedFor = null;
    parameterDescriptors = new Map();
    if (!script) {
      schema = null;
      renderAll();
      setNotice('Start a script to create or use its control surface.');
      return;
    }
    try {
      schema = store.load(script);
      setNotice('Loaded the surface stored for this exact script.');
    } catch (error) {
      schema = defaultBuilderSchema(script);
      setNotice(`Stored surface was ignored: ${error.message}. Edit or reset to replace it.`, true);
    }
    renderAll();
  }

  function spanSelect(widget) {
    const select = document.createElement('select');
    select.dataset.builderAction = '';
    for (let value = 1; value <= schema.columns; value += 1) select.append(option(value));
    select.value = String(Math.min(widget.span, schema.columns));
    select.addEventListener('change', () => mutate(
      current => updateBuilderWidget(current, widget.id, {span: Number(select.value)}),
      `${widget.type} width updated.`,
    ));
    return select;
  }

  function textInput(value, max = 80) {
    const input = document.createElement('input');
    input.value = value;
    input.maxLength = max;
    input.autocomplete = 'off';
    input.dataset.builderAction = '';
    return input;
  }

  function numberSelect(value, low, high) {
    const select = document.createElement('select');
    select.dataset.builderAction = '';
    for (let current = low; current <= high; current += 1) select.append(option(current));
    select.value = String(value);
    return select;
  }

  function renderWidgetEditor(widget, index) {
    const shell = document.createElement('article');
    shell.className = 'builder-widget-editor';
    shell.dataset.widgetId = widget.id;

    const head = document.createElement('div');
    head.className = 'builder-widget-head';
    const kind = document.createElement('div');
    kind.className = 'builder-widget-kind';
    const kindText = document.createElement('span');
    kindText.textContent = widget.type;
    const id = document.createElement('code');
    id.textContent = widget.id;
    kind.append(kindText, id);
    const actions = document.createElement('div');
    actions.className = 'builder-widget-actions';
    const up = button('↑', 'Move up');
    const down = button('↓', 'Move down');
    const remove = button('×', 'Remove widget');
    up.disabled = index === 0;
    down.disabled = index === schema.widgets.length - 1;
    up.addEventListener('click', () => mutate(current => moveBuilderWidget(current, widget.id, 'up'), 'Widget moved.'));
    down.addEventListener('click', () => mutate(current => moveBuilderWidget(current, widget.id, 'down'), 'Widget moved.'));
    remove.addEventListener('click', () => mutate(current => removeBuilderWidget(current, widget.id), 'Widget removed.'));
    actions.append(up, down, remove);
    head.append(kind, actions);

    const fields = document.createElement('div');
    fields.className = 'builder-widget-fields';
    fields.append(labelField('span', spanSelect(widget)));

    if (widget.type === 'key') {
      const label = textInput(widget.label);
      const n = numberSelect(widget.n, 1, 3);
      label.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {label: label.value}), 'Key label updated.'));
      n.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {n: Number(n.value)}), 'Key target updated.'));
      fields.prepend(labelField('label', label));
      fields.append(labelField('K number', n));
    } else if (widget.type === 'encoder') {
      const label = textInput(widget.label);
      const n = numberSelect(widget.n, 1, 3);
      const step = document.createElement('input');
      step.type = 'number'; step.min = '1'; step.max = '64'; step.step = '1'; step.value = String(widget.step); step.dataset.builderAction = '';
      label.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {label: label.value}), 'Encoder label updated.'));
      n.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {n: Number(n.value)}), 'Encoder target updated.'));
      step.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {step: Number(step.value)}), 'Encoder step updated.'));
      fields.prepend(labelField('label', label));
      fields.append(labelField('E number', n), labelField('step', step));
    } else if (widget.type === 'param') {
      const label = textInput(widget.label);
      const paramId = textInput(widget.paramId, 128);
      paramId.setAttribute('list', 'builder-param-options');
      const step = document.createElement('input');
      step.type = 'number'; step.min = '0.0001'; step.max = '1'; step.step = '0.0001'; step.value = String(widget.step); step.dataset.builderAction = '';
      label.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {label: label.value}), 'Parameter label updated.'));
      paramId.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {paramId: paramId.value.trim()}), 'Parameter target updated.'));
      step.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {step: Number(step.value)}), 'Parameter step updated.'));
      fields.prepend(labelField('label', label));
      fields.append(labelField('parameter id', paramId, true), labelField('normalized step', step));
    } else if (widget.type === 'label') {
      const label = document.createElement('textarea');
      label.rows = 3; label.maxLength = 500; label.value = widget.label; label.dataset.builderAction = '';
      label.addEventListener('change', () => mutate(current => updateBuilderWidget(current, widget.id, {label: label.value}), 'Label updated.'));
      fields.prepend(labelField('text', label, true));
    }

    shell.append(head, fields);
    return shell;
  }

  function renderEditor() {
    editor.replaceChildren();
    if (!schema) {
      const empty = document.createElement('div');
      empty.className = 'builder-empty';
      empty.textContent = 'No active script.';
      editor.append(empty);
      count.textContent = '0 widgets';
      return;
    }
    count.textContent = `${schema.widgets.length} widget${schema.widgets.length === 1 ? '' : 's'}`;
    if (!schema.widgets.length) {
      const empty = document.createElement('div');
      empty.className = 'builder-empty';
      empty.textContent = 'Add a Key, Encoder, Parameter, Label or Spacer.';
      editor.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    schema.widgets.forEach((widget, index) => fragment.append(renderWidgetEditor(widget, index)));
    editor.append(fragment);
  }

  function releasePointer(buttonNode, pointerId) {
    buttonNode.dataset.pressed = 'false';
    pressLedger.release(pointerId);
  }

  function previewKey(widget) {
    const shell = document.createElement('article');
    shell.className = 'preview-widget preview-key';
    shell.dataset.type = widget.type;
    const control = button(widget.label);
    control.addEventListener('pointerdown', event => {
      if (!ready || event.button !== 0) return;
      event.preventDefault();
      control.setPointerCapture?.(event.pointerId);
      control.dataset.pressed = 'true';
      pressLedger.press(event.pointerId, {n: widget.n});
    });
    const release = event => releasePointer(control, event.pointerId);
    control.addEventListener('pointerup', release);
    control.addEventListener('pointercancel', release);
    control.addEventListener('lostpointercapture', release);
    shell.append(control);
    return shell;
  }

  function previewEncoder(widget) {
    const shell = document.createElement('article');
    shell.className = 'preview-widget preview-encoder';
    shell.dataset.type = widget.type;
    const title = document.createElement('strong');
    title.textContent = widget.label;
    const dial = document.createElement('div');
    dial.className = 'preview-encoder-dial';
    dial.tabIndex = 0;
    const actions = document.createElement('div');
    actions.className = 'preview-encoder-actions';
    const minus = button('−');
    const plus = button('+');
    const send = sign => { if (ready) session.command({target: 'control', action: 'enc', args: {n: widget.n, d: sign * widget.step}}); };
    minus.addEventListener('click', () => send(-1));
    plus.addEventListener('click', () => send(1));
    dial.addEventListener('wheel', event => { event.preventDefault(); send(event.deltaY > 0 ? -1 : 1); }, {passive: false});
    dial.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); send(-1); }
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); send(1); }
    });
    actions.append(minus, plus);
    shell.append(title, dial, actions);
    return shell;
  }

  function previewParam(widget) {
    const shell = document.createElement('article');
    shell.className = 'preview-widget preview-param';
    shell.dataset.type = widget.type;
    const descriptor = parameterDescriptors.get(widget.paramId);
    const current = Number.isFinite(Number(descriptor?.normalized)) ? Number(descriptor.normalized) : 0;
    const head = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = widget.label;
    title.title = widget.paramId;
    const output = document.createElement('output');
    output.textContent = formattedParameter(descriptor, current);
    head.append(title, output);
    const range = document.createElement('input');
    range.type = 'range'; range.min = '0'; range.max = '1'; range.step = String(widget.step); range.value = String(current);
    let lane;
    lane = new AppliedValueLane(value => {
      const commandId = session.command({target: 'param', action: 'set_normalized', args: {id: widget.paramId, value}});
      settlements.set(commandId, lane);
      return commandId;
    });
    lane.lastApplied = current;
    lanes.set(widget.id, {lane, widget, range, output});
    range.addEventListener('input', () => {
      const value = Number(range.value);
      output.textContent = value.toFixed(3);
      lane.push(value);
    });
    shell.append(head, range);
    return shell;
  }

  function renderPreview() {
    pressLedger.releaseAll();
    pressLedger = makePressLedger();
    lanes.clear();
    settlements.clear();
    preview.replaceChildren();
    if (!schema) {
      previewName.textContent = 'Surface';
      preview.style.setProperty('--builder-columns', '1');
      return;
    }
    previewName.textContent = schema.name;
    preview.style.setProperty('--builder-columns', String(schema.columns));
    const fragment = document.createDocumentFragment();
    for (const widget of schema.widgets) {
      let node;
      if (widget.type === 'key') node = previewKey(widget);
      else if (widget.type === 'encoder') node = previewEncoder(widget);
      else if (widget.type === 'param') node = previewParam(widget);
      else {
        node = document.createElement('article');
        node.className = widget.type === 'label' ? 'preview-widget preview-label' : 'preview-widget';
        node.dataset.type = widget.type;
        if (widget.type === 'label') node.textContent = widget.label;
      }
      node.style.setProperty('--widget-span', String(widget.span));
      fragment.append(node);
    }
    preview.append(fragment);
    setPreviewEnabled(ready);
  }

  function renderParameterOptions() {
    paramOptions.replaceChildren();
    for (const descriptor of parameterDescriptors.values()) {
      const item = option(descriptor.id, descriptor.name);
      item.label = descriptor.name;
      paramOptions.append(item);
    }
  }

  function renderAll() {
    const enabled = Boolean(schema && activeScript);
    setEditorEnabled(enabled);
    if (schema) {
      nameInput.value = schema.name;
      columnsSelect.value = String(schema.columns);
      jsonArea.value = serializeBuilderSchema(schema);
    } else {
      nameInput.value = '';
      columnsSelect.value = '1';
      jsonArea.value = '';
    }
    renderEditor();
    renderPreview();
  }

  function updateDescriptor(raw) {
    if (!raw || typeof raw.id !== 'string') return;
    const previous = parameterDescriptors.get(raw.id) || {};
    const descriptor = {...previous, ...raw, normalized: Number(raw.normalized)};
    parameterDescriptors.set(raw.id, descriptor);
    for (const entry of lanes.values()) {
      if (entry.widget.paramId !== raw.id || !Number.isFinite(descriptor.normalized)) continue;
      entry.lane.lastApplied = descriptor.normalized;
      entry.range.value = String(descriptor.normalized);
      entry.output.textContent = formattedParameter(descriptor, descriptor.normalized);
    }
  }

  root.querySelectorAll('[data-add-widget]').forEach(control => {
    control.addEventListener('click', () => mutate(current => appendBuilderWidget(
      current,
      createBuilderWidget(control.dataset.addWidget, nextWidgetId()),
    ), `${control.dataset.addWidget} widget added.`));
  });

  nameInput.addEventListener('change', () => mutate(current => updateBuilderLayout(current, {name: nameInput.value}), 'Surface name updated.'));
  columnsSelect.addEventListener('change', () => mutate(current => updateBuilderLayout(current, {columns: Number(columnsSelect.value)}), 'Surface columns updated.'));
  exportButton.addEventListener('click', () => {
    if (!schema) return;
    jsonArea.value = serializeBuilderSchema(schema);
    setNotice('Current schema exported below.');
  });
  copyButton.addEventListener('click', async () => {
    if (!schema) return;
    const serialized = serializeBuilderSchema(schema);
    jsonArea.value = serialized;
    try {
      if (typeof navigatorLike.clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
      await navigatorLike.clipboard.writeText(serialized);
      setNotice('Schema copied to the clipboard.');
    } catch { setNotice('Clipboard unavailable. Copy the JSON field manually.', true); }
  });
  downloadButton.addEventListener('click', () => {
    if (!schema) return;
    const blob = new Blob([serializeBuilderSchema(schema)], {type: 'application/json'});
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl; anchor.download = fileName(schema.script); anchor.hidden = true;
    root.body?.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(objectUrl);
    setNotice('Schema download prepared.');
  });
  importButton.addEventListener('click', () => {
    if (!activeScript) return;
    try { persist(parseBuilderSchema(jsonArea.value, activeScript), 'Schema imported and saved for the active script.'); }
    catch (error) { setNotice(`Import rejected: ${error.message}`, true); }
  });
  resetButton.addEventListener('click', () => {
    if (!activeScript || !confirmLike(`Reset the UI surface for ${activeScript}?`)) return;
    schema = store.remove(activeScript);
    renderAll();
    setNotice('Surface reset to an empty per-script layout.');
  });

  session.addEventListener('state', event => {
    const state = event.detail;
    status.textContent = state.status;
    revision.textContent = state.revision ?? '—';
    const nextScript = state.data?.script?.active ? state.data.script.name : null;
    scriptEl.textContent = nextScript || 'no active script';
    if (nextScript !== activeScript) loadScript(nextScript);

    const wasReady = ready;
    const nextReady = state.status === 'synced' && Boolean(nextScript);
    if (!nextReady && wasReady) pressLedger = makePressLedger();
    setPreviewEnabled(nextReady);

    const rawCatalog = state.data?.params;
    if (rawCatalog && rawCatalog.generation !== catalogGeneration) {
      catalogGeneration = rawCatalog.generation;
      parameterDescriptors = new Map(
        writableParameterOptions(rawCatalog).map(item => [item.id, {
          ...item,
          ...rawCatalog.items.find(raw => raw?.id === item.id),
        }]),
      );
      renderParameterOptions();
      renderPreview();
    }
    if (nextScript && rawCatalog?.generation === 'none' && catalogRequestedFor !== nextScript) {
      catalogRequestedFor = nextScript;
      session.command({target: 'param', action: 'catalog', args: {}});
      setNotice('Requesting the active script parameter catalog…');
    }
    if (state.status === 'reconnecting') setNotice('Connection lost. The server released held controls; the editor remains available.');
  });

  session.addEventListener('command', event => {
    const detail = event.detail;
    const lane = settlements.get(detail.id);
    if (lane) {
      settlements.delete(detail.id);
      const next = lane.settle(detail.id, detail.status);
      if (next) settlements.set(next, lane);
      if (detail.status === 'reject') {
        for (const entry of lanes.values()) {
          if (entry.lane === lane && Number.isFinite(lane.lastApplied)) {
            entry.range.value = String(lane.lastApplied);
            entry.output.textContent = lane.lastApplied.toFixed(3);
          }
        }
      }
    }
    if (detail.result?.param) updateDescriptor(detail.result.param);
    if (detail.status === 'reject' || detail.status === 'uncertain') {
      setNotice(detail.error || `Builder command ${detail.status}`, true);
    }
  });
  session.addEventListener('protocolerror', event => setNotice(`Protocol error: ${event.detail.message}`, true));

  const releaseAll = () => {
    if (ready) pressLedger.releaseAll();
  };
  globalThis.addEventListener?.('pagehide', releaseAll);
  root.addEventListener?.('visibilitychange', () => { if (root.visibilityState === 'hidden') releaseAll(); });

  setEditorEnabled(false);
  setPreviewEnabled(false);
  renderAll();
  session.connect();
  return {session, store, get schema() { return schema; }};
}
