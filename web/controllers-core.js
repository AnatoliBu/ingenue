export class ControllerHubError extends Error {}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function countPorts(value) {
  return Object.keys(object(value).ports || {}).length;
}

function card(id, label, href, status, detail) {
  return {id, label, href, status, detail};
}

export function buildControllerReadiness({hello=null, state=null, webMidiSupported=false, secureContext=false, pingMs=null}={}) {
  const capabilities = object(hello?.capabilities);
  const channels = new Set(list(capabilities.channels));
  const commands = new Set(list(capabilities.commands));
  const snapshot = object(state?.data);
  const synced = state?.status === 'synced' && Boolean(state?.data);
  const protocolReady = synced && channels.size > 0 && commands.size > 0;
  const script = object(snapshot.script);
  const gridPorts = countPorts(snapshot.grid);
  const arcPorts = countPorts(snapshot.arc);
  const paramItems = Array.isArray(object(snapshot.params).items) ? snapshot.params.items.length : 0;

  const cards = [
    card('performance', 'Performance', './performance.html',
      protocolReady && commands.has('control.enc') && commands.has('control.key') ? (script.active ? 'ready' : 'warn') : 'off',
      script.active ? `active script: ${script.name}` : 'waiting for an active script'),
    card('grid', 'Grid', './performance.html',
      protocolReady && channels.has('grid') && commands.has('grid.key') ? (gridPorts ? 'ready' : 'warn') : 'off',
      gridPorts ? `${gridPorts} published Grid port${gridPorts === 1 ? '' : 's'}` : 'no Grid frame published'),
    card('arc', 'Arc', './performance.html',
      protocolReady && channels.has('arc') && commands.has('arc.delta') ? (arcPorts ? 'ready' : 'warn') : 'off',
      arcPorts ? `${arcPorts} published Arc port${arcPorts === 1 ? '' : 's'}` : 'no Arc frame published'),
    card('params', 'Parameters', './params.html',
      protocolReady && channels.has('params') && commands.has('param.catalog') ? (paramItems ? 'ready' : 'warn') : 'off',
      paramItems ? `${paramItems} catalog entries` : 'catalog not published yet'),
    card('launchpad', 'Launchpad', './launchpad.html',
      protocolReady && commands.has('grid.key') ? (gridPorts ? 'ready' : 'warn') : 'off',
      gridPorts ? '8×8 paged Grid presentation available' : 'requires a published Grid frame'),
    card('gamepad', 'Gamepad', './gamepad.html',
      protocolReady && commands.has('gamepad.button') && commands.has('gamepad.analog') ? 'ready' : 'off',
      capabilities.gamepad?.normalized ? 'native norns callbacks available' : 'gamepad callbacks unavailable'),
  ];

  let midiStatus = 'off';
  let midiDetail = 'Web MIDI bridge unavailable';
  if (capabilities.midi?.normalized_params) {
    if (!webMidiSupported) {
      midiStatus = 'warn';
      midiDetail = 'this browser does not expose Web MIDI';
    } else if (!secureContext) {
      midiStatus = 'warn';
      midiDetail = 'browser requires a secure context for Web MIDI';
    } else {
      midiStatus = 'ready';
      midiDetail = 'Web MIDI Learn is available';
    }
  }
  cards.push(card('midi', 'MIDI Learn', './midi.html', midiStatus, midiDetail));

  const pingStatus = Number.isFinite(pingMs) ? 'ready' : protocolReady ? 'warn' : 'off';
  const pingDetail = Number.isFinite(pingMs) ? `${Math.max(0, Math.round(pingMs))} ms browser ↔ server` : 'run the safe ping check';
  cards.push(card('transport', 'Realtime transport', './realtime-inspector.html', pingStatus, pingDetail));

  return {
    synced,
    protocolReady,
    scriptActive: Boolean(script.active),
    scriptName: script.active ? String(script.name || 'active script') : 'no active script',
    cards,
    readyCount: cards.filter(item => item.status === 'ready').length,
    warningCount: cards.filter(item => item.status === 'warn').length,
  };
}
