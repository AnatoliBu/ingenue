function send(session, target, action, args) {
  return session.command({target, action, args});
}

export function normalizeArcConfiguration(value) {
  const port = Number(value?.port);
  const rings = Number(value?.rings);
  if (!Number.isInteger(port) || port < 1 || port > 4) throw new Error('Arc vport must be 1–4.');
  if (rings !== 2 && rings !== 4) throw new Error('Arc must expose 2 or 4 rings.');
  return {port, rings};
}

export function mountArcHardening(session, root = document) {
  const displayPort = root.getElementById('arc-port');
  const configPort = root.getElementById('arc-config-port');
  const rings = root.getElementById('arc-config-rings');
  const apply = root.getElementById('arc-apply');
  const notice = root.getElementById('arc-notice');
  if (!displayPort || !configPort || !rings || !apply || !notice) return null;

  let pending = null;
  const syncFromState = state => {
    const ports = state?.data?.arc?.ports || {};
    const raw = ports[String(Number(displayPort.value) || 0)];
    if (raw?.virtual) {
      configPort.value = String(raw.port);
      rings.value = String(raw.rings);
    }
  };

  displayPort.addEventListener('change', () => syncFromState(session.state));
  apply.addEventListener('click', () => {
    try {
      const config = normalizeArcConfiguration({
        port: Number(configPort.value),
        rings: Number(rings.value),
      });
      pending = send(session, 'arc', 'configure', config);
      notice.textContent = 'Applying persistent virtual Arc configuration…';
    } catch (error) {
      notice.textContent = error.message;
    }
  });

  session.addEventListener('state', event => syncFromState(event.detail));
  session.addEventListener('command', event => {
    if (event.detail.id !== pending) return;
    if (event.detail.status === 'ack') {
      notice.textContent = 'Virtual Arc saved. The active script can reconnect to the selected vport now.';
    } else {
      notice.textContent = event.detail.error || `Arc configuration ${event.detail.status}`;
    }
    pending = null;
  });

  syncFromState(session.state);
  return {syncFromState};
}
