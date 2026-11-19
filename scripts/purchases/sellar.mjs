// Cifra compras con la clave pública del Worker (RSA-OAEP + AES-GCM) para
// entregarlas por la acción "Importar compras" sin dejar costos en claro en un
// repo público. Formato: ver worker-sync/purchases-sealed.js.
import { normalizeDocument } from '../../worker-sync/purchases.js';

const b64 = bytes => Buffer.from(bytes).toString('base64url');

// Valida con las mismas reglas del Worker: un error acá evita mandar basura.
export function validateDocuments(docs) {
  if (!Array.isArray(docs) || !docs.length) throw new Error('sin_documentos');
  return docs.map((doc, i) => { try { return normalizeDocument(doc); } catch (e) { throw new Error(`documento_${i}_invalido:${e.message}`); } });
}

export async function seal(publicJwk, payload) {
  const rsa = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // gzip antes de cifrar: la entrada de la acción admite 65.535 caracteres y el JSON se comprime mucho.
  const packed = await new Response(new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, packed);
  const k = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsa, await crypto.subtle.exportKey('raw', aes));
  return b64(new TextEncoder().encode(JSON.stringify({ v: 1, z: 1, k: b64(k), iv: b64(iv), ct: b64(ct) })));
}
