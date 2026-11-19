// Compras selladas: carga de compras a proveedores desde una sesión que NO
// tiene la clave del Worker y desde un repo público.
//
// El Worker genera una clave RSA-OAEP la primera vez que se la piden y guarda la
// parte privada en D1. Quien arma las compras (una sesión de Claude que leyó los
// mails y PDF) las cifra con la parte pública (scripts/purchases/sellar.mjs) y
// dispara la acción de GitHub "Importar compras", que entrega el texto cifrado
// con la clave del Worker que ya tiene. Los costos nunca quedan en claro en un
// lugar público: el texto cifrado sólo lo abre el Worker.
//
// Sellado: JSON {v:1,z,k,iv,ct} en base64url. k = clave AES-256 cifrada con RSA-OAEP
// (SHA-256); ct = documentos (comprimidos con gzip si z=1) cifrados con AES-GCM.
//
// Sólo importa documentos NUEVOS: uno ya cargado (mismo proveedor, año y número,
// aunque cambie el guion) se saltea para no pisar lo que se corrigió a mano
// (destino de la compra, fecha de recepción).
import { importPurchases, normalizeDocument, ensurePurchases, PurchaseError } from './purchases.js';

const KEY_SCHEMA = 'CREATE TABLE IF NOT EXISTS purchases_seal_key(id TEXT PRIMARY KEY,public_jwk TEXT NOT NULL,private_jwk TEXT NOT NULL,created_at INTEGER NOT NULL)';
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };

const fromB64 = value => Uint8Array.from(atob(String(value).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function ensureSealKey(db, now = Date.now()) {
  await db.prepare(KEY_SCHEMA).run();
  const read = async () => {
    const row = await db.prepare("SELECT public_jwk,private_jwk FROM purchases_seal_key WHERE id='main'").first();
    return row ? { publicJwk: JSON.parse(row.public_jwk), privateJwk: JSON.parse(row.private_jwk) } : null;
  };
  const existing = await read();
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey), privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await db.prepare("INSERT OR IGNORE INTO purchases_seal_key(id,public_jwk,private_jwk,created_at) VALUES('main',?,?,?)").bind(JSON.stringify(publicJwk), JSON.stringify(privateJwk), now).run();
  // Si dos pedidos llegaron a la vez gana el primero que se guardó.
  return read();
}

export async function openSealed(privateJwk, sealed) {
  const envelope = JSON.parse(new TextDecoder().decode(fromB64(sealed)));
  if (envelope?.v !== 1) throw new Error('unsupported_version');
  const priv = await crypto.subtle.importKey('jwk', privateJwk, RSA, false, ['decrypt']);
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, fromB64(envelope.k));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  let plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, aes, fromB64(envelope.ct)));
  if (envelope.z === 1) plain = new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(plain));
}

const digits = value => String(value ?? '').replace(/\D/g, '');

// ¿Ya está cargado? Mismo proveedor, mismo año y mismos dígitos de número.
async function alreadyLoaded(db, doc) {
  const wanted = digits(doc.document_number ?? doc.supplier_order_id);
  if (!wanted) return false;
  const { results } = await db.prepare('SELECT document_number,supplier_order_id FROM purchase_orders WHERE supplier=? AND substr(purchase_date,1,4)=?').bind(doc.supplier, doc.purchase_date.slice(0, 4)).all();
  return results.some(r => digits(r.document_number) === wanted || digits(r.supplier_order_id) === wanted);
}

// Descifra e importa los documentos nuevos. Devuelve sólo conteos y códigos de
// error: nunca títulos, ISBN ni precios (los registros de Actions son públicos).
export async function importSealed(db, sealed, now = Date.now()) {
  if (typeof sealed !== 'string' || sealed.length < 100 || sealed.length > 200000) throw new PurchaseError('sealed_invalid');
  const { privateJwk } = await ensureSealKey(db, now);
  let payload;
  try { payload = await openSealed(privateJwk, sealed); } catch { throw new PurchaseError('decrypt_failed'); }
  const docs = Array.isArray(payload) ? payload : Array.isArray(payload?.documents) ? payload.documents : payload?.items ? [payload] : [];
  const coverage = Array.isArray(payload?.coverage) ? payload.coverage : [];
  if (!docs.length && !coverage.length) throw new PurchaseError('documents_1_to_50');
  await ensurePurchases(db);
  const fresh = [], errors = [];
  let skipped = 0;
  for (const [index, raw] of docs.entries()) {
    try {
      const normalized = normalizeDocument(raw);
      if (await alreadyLoaded(db, normalized)) skipped++; else fresh.push(raw);
    } catch (error) { errors.push({ index, error: error instanceof PurchaseError ? error.code : 'internal_error' }); }
  }
  const result = fresh.length || coverage.length ? await importPurchases(db, { documents: fresh, coverage }, now) : { imported: 0, results: [], errors: 0 };
  for (const r of result.results) if (r.status === 'error') errors.push({ index: r.index, error: r.error });
  return { imported: result.imported, skipped_existing: skipped, errors, review: result.results.reduce((n, r) => n + (r.review?.length ?? 0), 0) };
}
