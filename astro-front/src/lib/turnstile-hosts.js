// Lógica de coincidencia de hosts para el widget de Turnstile en carrito.astro.
//
// Copia probada/canónica de la función inline en astro-front/src/pages/carrito.astro
// (bloque <script is:inline>, que no puede usar `import` porque corre sin bundler).
// Si se modifica la lógica acá, replicar el cambio ahí también — ver el
// comentario recíproco junto a `hostMatchesEntry` en carrito.astro.
//
// Convención de cada entrada de `allowedHosts`:
//   - sin punto inicial ("amadolibros.com"): coincidencia EXACTA solamente,
//     nunca acepta subdominios.
//   - con punto inicial (".amadolibros-web.pages.dev"): acepta cualquier
//     subdominio ESTRICTO de ese dominio, nunca el host desnudo por sí solo.
// La comparación siempre es por labels completos del hostname (nunca
// substring/startsWith/endsWith sobre el string crudo).
export function hostMatchesEntry(hostname, entry) {
  if (!entry) return false;
  if (entry.charAt(0) === '.') {
    const domainLabels = entry.slice(1).split('.').filter(Boolean);
    const hostLabels = hostname.split('.');
    if (domainLabels.length === 0 || hostLabels.length <= domainLabels.length) return false;
    const tail = hostLabels.slice(hostLabels.length - domainLabels.length);
    for (let i = 0; i < domainLabels.length; i++) {
      if (tail[i] !== domainLabels[i]) return false;
    }
    return true;
  }
  return hostname === entry;
}

export function isTurnstileHostAllowed(hostname, allowedHosts) {
  for (const entry of allowedHosts) {
    if (hostMatchesEntry(hostname, entry)) return true;
  }
  return false;
}

// Falla cerrado: si el checkout está habilitado pero falta la site key o el
// host actual no está permitido, el widget nunca se carga y el intento de
// pago se bloquea (ver `turnstileBlocked` en carrito.astro).
export function isTurnstileConfigured(onlineCheckoutEnabled, siteKey, hostname, allowedHosts) {
  if (!onlineCheckoutEnabled) return false;
  if (!siteKey) return false;
  return isTurnstileHostAllowed(hostname, allowedHosts);
}
