const PAGES = [
  ['controllers', './controllers.html', 'controllers'],
  ['performance', './performance.html', 'performance'],
  ['builder', './builder.html', 'UI Builder'],
  ['launchpad', './launchpad.html', 'Launchpad'],
  ['gamepad', './gamepad.html', 'Gamepad'],
  ['params', './params.html', 'Parameters'],
  ['midi', './midi.html', 'MIDI Learn'],
  ['inspector', './realtime-inspector.html', 'inspector'],
];

export function bridgeNavigationSearch(locationLike = globalThis.location) {
  const source = new URLSearchParams(locationLike?.search || '');
  if (source.get('bridge') !== 'localhost') return '';
  const device = String(source.get('device') || '').trim();
  const realtimePort = Number(source.get('rt'));
  if (!device || device.length > 255 || device.includes('/') || device.includes('@')) return '';
  if (!Number.isInteger(realtimePort) || realtimePort < 1 || realtimePort > 65535) return '';
  return `?${new URLSearchParams({device, rt: String(realtimePort), bridge: 'localhost'})}`;
}

export function mountSharedNavigation(root = document, locationLike = globalThis.location) {
  const hosts = root.querySelectorAll('[data-ingenue-nav]');
  const bridgeSearch = bridgeNavigationSearch(locationLike);
  hosts.forEach(host => {
    if (host.dataset.ingenueNavMounted === 'true') return;
    const current = host.dataset.ingenueNav || '';
    const fragment = document.createDocumentFragment();
    for (const [id, href, label] of PAGES) {
      const link = document.createElement('a');
      link.className = 'ingenue-nav-link';
      link.href = `${href}${bridgeSearch}`;
      link.textContent = label;
      if (id === current) {
        link.setAttribute('aria-current', 'page');
        link.tabIndex = -1;
      }
      fragment.append(link);
    }
    host.append(fragment);
    host.dataset.ingenueNavMounted = 'true';
  });
  return hosts;
}
