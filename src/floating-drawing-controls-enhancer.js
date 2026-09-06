function syncFloatingOpacity(root = document) {
  const labels = root.querySelectorAll?.('.floating-drawing-controls label[title^="Прозрачность"]') ?? [];
  labels.forEach((label) => {
    const input = label.querySelector('input[type="range"]');
    if (!input) return;
    const value = Number(input.value);
    const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value * 100)) : 100;
    label.style.setProperty('--opacity-stop', `${percent}%`);
  });
}

function handleInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'range') return;
  const label = input.closest('.floating-drawing-controls label[title^="Прозрачность"]');
  if (!label) return;
  syncFloatingOpacity(label.parentElement ?? document);
}

if (typeof document !== 'undefined') {
  const observer = new MutationObserver(() => syncFloatingOpacity(document));
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleInput, true);
  queueMicrotask(() => syncFloatingOpacity(document));
}
