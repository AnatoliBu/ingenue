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

export function mountSharedNavigation(root = document) {
  const hosts = root.querySelectorAll('[data-ingenue-nav]');
  hosts.forEach(host => {
    if (host.dataset.ingenueNavMounted === 'true') return;
    const current = host.dataset.ingenueNav || '';
    const fragment = document.createDocumentFragment();
    for (const [id, href, label] of PAGES) {
      const link = document.createElement('a');
      link.className = 'ingenue-nav-link';
      link.href = href;
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
