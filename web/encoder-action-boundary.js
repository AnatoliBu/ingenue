export function mountEncoderActionBoundary(root = document) {
  root.querySelectorAll('[data-encoder] [data-delta]').forEach(button => {
    if (button.dataset.encoderBoundaryMounted === 'true') return;
    button.addEventListener('pointerdown', event => {
      // Keep the parent encoder drag handler from capturing clicks intended for
      // the explicit +/- action buttons. The click event remains available to
      // the button's own command handler.
      event.stopPropagation();
    });
    button.dataset.encoderBoundaryMounted = 'true';
  });
}
