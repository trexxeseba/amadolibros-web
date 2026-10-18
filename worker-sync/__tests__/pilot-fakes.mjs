// Simuladores compartidos por las pruebas del piloto (no es una prueba: el glob *.test.js lo ignora).
import { createHash } from 'node:crypto';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function png(width, height, salt = 0) {
  const bytes = new Uint8Array(64);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); bytes[40] = salt; return bytes;
}
export function webp(width, height) {
  const bytes = new Uint8Array(40);
  bytes.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88]);
  const w = width - 1, h = height - 1; bytes.set([w & 255, (w >> 8) & 255, 0, h & 255, (h >> 8) & 255, 0], 24); return bytes;
}

// R2 simulado con ETag y precondiciones reales; registra cada operación.
export function bucket() {
  const store = new Map(); const log = []; let n = 0;
  const wrap = (key, e) => e && { key, etag: e.etag, size: e.bytes.length, customMetadata: e.customMetadata, httpMetadata: e.httpMetadata,
    body: new Blob([e.bytes]).stream(), text: async () => new TextDecoder().decode(e.bytes) };
  return { store, log,
    async get(key) { log.push(['get', key]); return wrap(key, store.get(key)) || null; },
    async head(key) { log.push(['head', key]); const e = store.get(key); return e ? { ...wrap(key, e), body: undefined } : null; },
    async put(key, value, o = {}) { log.push(['put', key]); const ex = store.get(key);
      if (o.onlyIf?.etagDoesNotMatch === '*' && ex) return null;
      if (o.onlyIf?.etagMatches && ex?.etag !== o.onlyIf.etagMatches) return null;
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      store.set(key, { bytes, etag: 'e' + (++n), customMetadata: o.customMetadata, httpMetadata: o.httpMetadata }); return { etag: 'e' + n }; },
    async delete() { throw new Error('delete must never be reachable'); }, async list() { throw new Error('list must never be reachable'); } };
}

// Images simulado: el ancho de salida es min(ancho del master, solicitado).
export function fakeImages() {
  const images = { calls: 0, input(stream) { images.calls++; const read = new Response(stream).arrayBuffer().then(b => new DataView(b));
    return { transform: t => ({ output: async () => { const v = await read; const w = Math.min(v.getUint32(16), t.width), h = Math.round(v.getUint32(20) * w / v.getUint32(16));
      return { response: () => new Response(webp(w, h), { headers: { 'content-type': 'image/webp' } }) }; } }) }; } };
  return images;
}
