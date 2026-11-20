// Temporal: cierra y borra publicaciones de Vintage con arroba (orden de Seba, 20/11/2026).
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
import {exigirVintage, exigirItemDeVintage} from './guardia.mjs';
const ids = ['MLU1542403078','MLU1542401480','MLU1541275374','MLU1541368842','MLU1542053998','MLU1542055560'];
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
const pausa = ms => new Promise(r => setTimeout(r, ms));
await exigirVintage(ml);
for (const id of ids) {
  const it = await ml.get(`/items/${id}`).catch(() => null);
  if (!it) { console.log(id, 'no se pudo leer'); continue; }
  exigirItemDeVintage(it);
  let estado = it.status;
  console.log(id, 'antes', it.status, JSON.stringify(it.sub_status));
  if (estado !== 'closed') {
    try { const r = await ml.put(`/items/${id}`, {status: 'closed'}); console.log(id, 'respuesta', r?.status, r?.sub_status); } catch (e) { console.log(id, 'fallo cerrar', e.code); }
    await pausa(400);
    const d = await ml.get(`/items/${id}`).catch(() => null); estado = d?.status; console.log(id, 'luego', d?.status, JSON.stringify(d?.sub_status));
  }
  let borrada = 'no';
  if (estado === 'closed' || true) {
    try { await ml.put(`/items/${id}`, {deleted: true}); borrada = 'pedido'; } catch (e) { borrada = 'fallo ' + e.code; }
  }
  console.log(id, 'estado', estado, 'borrado', borrada);
  await pausa(400);
}
