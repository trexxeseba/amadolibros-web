// Sensor del monitor sintético. Todavía no se incluye en la tienda.
// Se instala antes de cargar la página. No envía datos ni contiene credenciales.
export function installImageSensor({ slowMs = 8000 } = {}) {
  const events = []; const tracked = new WeakMap(); const timers = new Set();
  const safePath = value => {
    try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) ? u.pathname.slice(0, 300) : null; } catch { return null; }
  };
  const emit = (img, state, resource) => {
    const path = safePath(resource);
    if (!path || events.length >= 100) return;
    events.push({ state, resource: path, page: location.pathname.slice(0, 300), time: Date.now() });
  };
  const entry = img => {
    let value = tracked.get(img);
    if (!value) { value = { failed: new Set(), slow: new Set() }; tracked.set(img, value); }
    return value;
  };
  const onError = event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const value = entry(img); const resource = img.currentSrc || img.src;
    if (!value.failed.has(resource)) { value.failed.add(resource); emit(img, 'broken', resource); }
  };
  const onLoad = event => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    const value = entry(img); const resource = img.currentSrc || img.src;
    if (img.naturalWidth === 0) { onError(event); return; }
    if (value.failed.has(resource)) { value.failed.delete(resource); emit(img, 'recovered', resource); }
    else if (value.failed.size) emit(img, 'fallback_loaded', resource);
    if (value.slow.has(resource)) { value.slow.delete(resource); emit(img, 'loaded_after_delay', resource); }
  };
  const observer = new IntersectionObserver(entries => {
    for (const item of entries) {
      const img = item.target; const value = entry(img);
      if (!item.isIntersecting) { if (value.timer) { clearTimeout(value.timer); timers.delete(value.timer); value.timer = null; } continue; }
      if (img.complete) { if (img.currentSrc && img.naturalWidth === 0) onError({ target: img }); continue; }
      if (value.timer) continue;
      const resource = img.currentSrc || img.src;
      value.timer = setTimeout(() => {
        timers.delete(value.timer); value.timer = null;
        if (img.isConnected && !img.complete && (img.currentSrc || img.src) === resource && !value.slow.has(resource)) {
          value.slow.add(resource); emit(img, 'slow', resource);
        }
      }, slowMs);
      timers.add(value.timer);
    }
  });
  const observe = root => {
    if (root instanceof HTMLImageElement) observer.observe(root);
    root.querySelectorAll?.('img').forEach(img => observer.observe(img));
  };
  const mutation = new MutationObserver(records => records.forEach(r => {
    r.addedNodes.forEach(observe);
    if (r.type === 'attributes' && r.target instanceof HTMLImageElement) {
      const value = entry(r.target); if (value.timer) { clearTimeout(value.timer); timers.delete(value.timer); value.timer = null; }
      observer.unobserve(r.target); observer.observe(r.target);
    }
  }));
  document.addEventListener('error', onError, true);
  document.addEventListener('load', onLoad, true);
  mutation.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes'] });
  observe(document);
  window.__amadoImageMonitor = { events, stop() {
    mutation.disconnect(); observer.disconnect(); timers.forEach(clearTimeout);
    document.removeEventListener('error', onError, true); document.removeEventListener('load', onLoad, true);
  } };
}
