// Reactivar publicaciones pausadas de Amado Libros (pedido de Seba, 26/11/2026: las que Mercado
// Libre pausó por "El precio tiene un cambio inusual").
//
//   ITEMS="MLU..,MLU.." MODO=prueba|real node agentes-ml/src/reactivar.mjs --salida DIR
//
// prueba: lee estado, motivo, precio, precio visible, stock e historial de precios de cada una y lo
// guarda en el archivo de salida (va al repo privado). real: además pone status=active en las que
// están pausadas, tienen stock y son de esta cuenta, y relee para verificar. Nunca cambia precios.
// El repo es público: el log sólo lleva conteos.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTA } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';

export const listaItems = s => [...new Set(String(s ?? '').split(/[\s,;]+/).map(x => x.trim().toUpperCase()).filter(x => /^MLU\d{6,15}$/.test(x)))].slice(0, 50);

// Se puede reactivar: de esta cuenta, pausada (no cerrada ni en revisión) y con stock.
export function sePuedeReactivar(it, sellerId) {
  if (!it || String(it.seller_id) !== String(sellerId)) return 'otra_cuenta';
  if (it.status === 'active') return 'ya_activa';
  if (it.status !== 'paused') return `estado_${it.status}`;
  if (!((it.available_quantity ?? 0) > 0)) return 'sin_stock';
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const salida = args[args.indexOf('--salida') + 1] || '.';
  const real = String(process.env.MODO) === 'real';
  const items = listaItems(process.env.ITEMS);
  if (!items.length) { console.error('Faltan ITEMS'); process.exit(2); }
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 2, soloLectura: !real });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const filas = [];
  for (const id of items) {
    const it = await ml.sonda(`/items/${id}?attributes=id,title,seller_id,status,sub_status,price,original_price,base_price,available_quantity,sold_quantity,last_updated,tags`);
    const sp = await ml.sonda(`/items/${id}/sale_price?context=channel_marketplace`);
    const pr = await ml.sonda(`/items/${id}/prices`);
    const f = { id, http: it.status, item: it.ok ? it.json : null, sale_price: sp.ok ? sp.json : null, precios: pr.ok ? pr.json?.prices ?? null : null };
    f.motivo = it.ok ? sePuedeReactivar(it.json, CUENTA.sellerId) : `http_${it.status}`;
    if (real && !f.motivo) {
      const r = await ml.put(`/items/${id}`, { status: 'active' }).then(() => ({ ok: true }), e => ({ ok: false, status: e?.status, detalle: e?.detalle ?? null }));
      await new Promise(r => setTimeout(r, 3000));
      const v = await ml.sonda(`/items/${id}?attributes=id,status,sub_status,price`);
      f.reactivar = { ...r, despues: v.ok ? v.json : null, verificada: v.ok && v.json?.status === 'active' };
    }
    filas.push(f);
  }
  const cuenta = {}; for (const f of filas) { const k = f.reactivar ? (f.reactivar.verificada ? 'reactivada' : 'no_reactivada') : (f.motivo ?? 'se_puede'); cuenta[k] = (cuenta[k] ?? 0) + 1; }
  console.log('Modo', real ? 'real' : 'prueba', '| resultado:', JSON.stringify(cuenta));
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'reactivar.json'), JSON.stringify({ modo: real ? 'real' : 'prueba', filas }, null, 1));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('reactivar:', e?.code ?? e?.message); process.exit(1); });
