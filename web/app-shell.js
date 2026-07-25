const SESSION_EVENT = 'ingenuesession';
const DRAWER_STORAGE_KEY = 'ingenue.shell.diagnostics.open';
const DEGRADED_EVENTS = new Set([
  'heartbeat timeout',
  'protocol parse failed',
  'runtime capability registry rejected',
]);

function element(root, tag, className, text = '') {
  const node = root.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function safeStorage(globalLike) {
  try { return globalLike.localStorage || null; } catch { return null; }
}

function readOpenState(storage) {
  try { return storage?.getItem(DRAWER_STORAGE_KEY) === 'true'; } catch { return false; }
}

function writeOpenState(storage, open) {
  try { storage?.setItem(DRAWER_STORAGE_KEY, open ? 'true' : 'false'); } catch {}
}

function injectStylesheet(root) {
  if (root.querySelector('link[data-ingenue-app-shell]')) return;
  const link = root.createElement('link');
  link.rel = 'stylesheet';
  link.href = './app-shell.css';
  link.dataset.ingenueAppShell = 'true';
  root.head?.append(link);
}

function first(root, selectors) {
  for (const selector of selectors) {
    const match = root.querySelector(selector);
    if (match) return match;
  }
  return null;
}

function statusElements(root) {
  return {
    status: first(root, ['#hub-connection', '#status', '[id$="-status"]']),
    revision: first(root, ['#revision', '[id$="-revision"]']),
    script: first(root, ['#script', '[id$="-script"]']),
    endpoint: first(root, ['#endpoint', '[id$="-endpoint"]']),
  };
}

function clone(value) {
  if (value == null) return value;
  try { return structuredClone(value); } catch { return String(value); }
}

export function connectionPresentation(status, degraded = false) {
  const raw = String(status || 'connecting');
  if (raw === 'synced' && degraded) return {state: 'degraded', label: 'degraded'};
  if (raw === 'synced') return {state: 'synced', label: 'synced'};
  if (raw === 'resyncing') return {state: 'resyncing', label: 'resyncing'};
  if (raw === 'reconnecting') return {state: 'reconnecting', label: 'reconnecting'};
  if (raw === 'disconnected') return {state: 'disconnected', label: 'disconnected'};
  if (raw === 'subscribing') return {state: 'subscribing', label: 'subscribing'};
  return {state: 'connecting', label: 'connecting'};
}

function eventDetailText(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  try {
    const serialized = JSON.stringify(detail);
    return serialized.length > 1600 ? `${serialized.slice(0, 1597)}…` : serialized;
  } catch {
    return String(detail);
  }
}

function timestamp(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : '—';
}

async function copyText(root, globalLike, text) {
  try {
    if (typeof globalLike.navigator?.clipboard?.writeText === 'function') {
      await globalLike.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const area = root.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  root.body?.append(area);
  area.select();
  let copied = false;
  try { copied = Boolean(root.execCommand?.('copy')); } catch {}
  area.remove();
  return copied;
}

function summaryItem(root, label, wide = false) {
  const item = element(root, 'div', 'ingenue-shell-summary-item');
  if (wide) item.dataset.wide = 'true';
  const caption = element(root, 'span', 'ingenue-shell-summary-label', label);
  const value = element(root, 'span', 'ingenue-shell-summary-value', '—');
  item.append(caption, value);
  return {item, value};
}

function createDrawer(root) {
  const drawer = element(root, 'aside', 'ingenue-shell-drawer');
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Ingenue runtime diagnostics');
  drawer.tabIndex = -1;

  const head = element(root, 'header', 'ingenue-shell-drawer-head');
  const title = element(root, 'h2', 'ingenue-shell-drawer-title', 'runtime diagnostics');
  const actions = element(root, 'div', 'ingenue-shell-drawer-actions');
  const copy = element(root, 'button', '', 'copy');
  copy.type = 'button';
  copy.title = 'Copy structured runtime diagnostics';
  const clear = element(root, 'button', '', 'clear');
  clear.type = 'button';
  clear.title = 'Clear the local diagnostics buffer';
  const close = element(root, 'button', '', 'close');
  close.type = 'button';
  close.title = 'Close diagnostics';
  actions.append(copy, clear, close);
  head.append(title, actions);

  const summary = element(root, 'section', 'ingenue-shell-drawer-summary');
  const state = summaryItem(root, 'state');
  const revision = summaryItem(root, 'revision');
  const script = summaryItem(root, 'script');
  const generations = summaryItem(root, 'generations');
  const commands = summaryItem(root, 'commands');
  const endpoint = summaryItem(root, 'endpoint', true);
  summary.append(state.item, revision.item, script.item, generations.item, commands.item, endpoint.item);

  const events = element(root, 'ol', 'ingenue-shell-events');
  events.setAttribute('aria-live', 'polite');
  drawer.append(head, summary, events);
  root.body?.append(drawer);

  return {
    drawer,
    copy,
    clear,
    close,
    events,
    values: {
      state: state.value,
      revision: revision.value,
      script: script.value,
      generations: generations.value,
      commands: commands.value,
      endpoint: endpoint.value,
    },
  };
}

function renderEvents(root, list, entries) {
  list.replaceChildren();
  if (!entries.length) {
    list.append(element(root, 'li', 'ingenue-shell-events-empty', 'No runtime events yet.'));
    return;
  }
  const fragment = root.createDocumentFragment();
  for (const entry of entries.slice(-120).reverse()) {
    const row = element(root, 'li', 'ingenue-shell-event');
    row.dataset.level = entry.level || 'info';
    row.dataset.sequence = String(entry.sequence ?? '');
    const time = element(root, 'time', 'ingenue-shell-event-time', timestamp(entry.at));
    const name = element(root, 'span', 'ingenue-shell-event-name', entry.event || 'event');
    const detail = element(root, 'pre', 'ingenue-shell-event-detail', eventDetailText(entry.detail));
    row.append(time, name, detail);
    fragment.append(row);
  }
  list.append(fragment);
}

function sessionSummary(session, degraded) {
  const state = session?.state || {};
  const script = state.data?.script;
  const runtime = state.data?.runtime;
  const presentation = connectionPresentation(state.status, degraded);
  return {
    presentation,
    revision: state.revision ?? '—',
    script: script?.active ? String(script.name || script.shortname || 'active script') : 'no active script',
    generations: runtime ? `${runtime.session_generation || '—'} / ${runtime.script_generation ?? '—'}` : 'legacy',
    commands: session?.registry?.size ?? 0,
    endpoint: session?.url || '—',
  };
}

export function installApplicationShell(root = document, globalLike = globalThis) {
  const nav = root.querySelector('[data-ingenue-nav]');
  if (!nav) return null;
  const existing = root.querySelector('[data-ingenue-app-shell-root]');
  if (existing?._ingenueShell) return existing._ingenueShell;

  injectStylesheet(root);
  nav.dataset.ingenueAppShellRoot = 'true';

  const liveState = element(root, 'span', 'ingenue-shell-state', 'connecting');
  liveState.dataset.state = 'connecting';
  liveState.setAttribute('aria-live', 'polite');
  liveState.title = 'Shared Ingenue runtime state';

  const toggle = element(root, 'button', 'ingenue-shell-diagnostics-toggle', 'diagnostics');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.title = 'Runtime diagnostics (Ctrl/⌘+Shift+D)';
  nav.append(liveState, toggle);

  const panel = createDrawer(root);
  const storage = safeStorage(globalLike);
  const targets = statusElements(root);
  let session = null;
  let degraded = false;
  let teardownSession = () => {};

  const setOpen = (open, focus = true) => {
    const next = Boolean(open);
    panel.drawer.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
    writeOpenState(storage, next);
    if (next) {
      render();
      if (focus) panel.close.focus();
    } else if (focus) {
      toggle.focus();
    }
  };

  const render = () => {
    const summary = sessionSummary(session, degraded);
    liveState.dataset.state = summary.presentation.state;
    liveState.textContent = summary.presentation.label;
    nav.dataset.connectionState = summary.presentation.state;
    if (root.body) root.body.dataset.ingenueState = summary.presentation.state;

    if (targets.status) {
      targets.status.textContent = summary.presentation.label;
      targets.status.dataset.state = summary.presentation.state;
    }
    if (targets.revision) targets.revision.textContent = String(summary.revision);
    if (targets.script) targets.script.textContent = summary.script;
    if (targets.endpoint) targets.endpoint.textContent = summary.endpoint;

    panel.values.state.textContent = summary.presentation.label;
    panel.values.revision.textContent = String(summary.revision);
    panel.values.script.textContent = summary.script;
    panel.values.generations.textContent = summary.generations;
    panel.values.commands.textContent = String(summary.commands);
    panel.values.endpoint.textContent = summary.endpoint;
    if (!panel.drawer.hidden) renderEvents(root, panel.events, session?.eventSnapshot?.() || []);
  };

  const bindSession = nextSession => {
    if (!nextSession || nextSession === session) return;
    teardownSession();
    session = nextSession;
    degraded = false;
    const onState = () => {
      if (session.state?.status === 'synced' && session.state?.resyncRequired === false) degraded = false;
      render();
    };
    const onRuntimeEvent = event => {
      if (DEGRADED_EVENTS.has(event.detail?.event)) degraded = true;
      if (event.detail?.event === 'snapshot') degraded = false;
      render();
    };
    const onProtocolError = () => { degraded = true; render(); };
    const onStale = () => { degraded = true; render(); };
    session.addEventListener('state', onState);
    session.addEventListener('runtimeevent', onRuntimeEvent);
    session.addEventListener('protocolerror', onProtocolError);
    session.addEventListener('stale', onStale);
    teardownSession = () => {
      session?.removeEventListener?.('state', onState);
      session?.removeEventListener?.('runtimeevent', onRuntimeEvent);
      session?.removeEventListener?.('protocolerror', onProtocolError);
      session?.removeEventListener?.('stale', onStale);
    };
    render();
  };

  const onSession = event => bindSession(event.detail);
  globalLike.addEventListener?.(SESSION_EVENT, onSession);
  bindSession(globalLike.ingenueDebug?.latest);

  toggle.addEventListener('click', () => setOpen(panel.drawer.hidden));
  panel.close.addEventListener('click', () => setOpen(false));
  panel.clear.addEventListener('click', () => {
    session?.events?.clear?.();
    render();
  });
  panel.copy.addEventListener('click', async () => {
    const payload = JSON.stringify({
      exported_at: new Date().toISOString(),
      url: globalLike.location?.href || null,
      client_id: session?.clientId || null,
      state: clone(session?.state || null),
      capabilities: clone(session?.capabilities || null),
      events: session?.eventSnapshot?.() || [],
    }, null, 2);
    const copied = await copyText(root, globalLike, payload);
    panel.copy.textContent = copied ? 'copied' : 'select log';
    globalLike.setTimeout?.(() => { panel.copy.textContent = 'copy'; }, 1200);
  });

  const keydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      setOpen(panel.drawer.hidden);
      return;
    }
    if (event.key === 'Escape' && !panel.drawer.hidden) {
      event.preventDefault();
      setOpen(false);
    }
  };
  globalLike.addEventListener?.('keydown', keydown);

  const api = {
    bindSession,
    render,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(panel.drawer.hidden),
    get session() { return session; },
    get state() { return liveState.dataset.state; },
    destroy() {
      teardownSession();
      globalLike.removeEventListener?.(SESSION_EVENT, onSession);
      globalLike.removeEventListener?.('keydown', keydown);
      panel.drawer.remove();
      liveState.remove();
      toggle.remove();
      delete nav._ingenueShell;
    },
  };
  nav._ingenueShell = api;
  if (readOpenState(storage)) setOpen(true, false);
  else render();
  return api;
}
