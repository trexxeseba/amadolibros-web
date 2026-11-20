// Temporal: verifica el estado de las publicaciones con arroba y prueba cerrarlas mostrando el error completo.
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
  const it = await ml.get(`/items/${id}`).catch(e => ({error: e.code}));
  if (it.error) { console.log(id, 'lectura', it.error); continue; }
  exigirItemDeVintage(it);
  console.log(id, 'estado', it.status, JSON.stringify(it.sub_status), 'deleted', it.deleted);
  try { await ml.put(`/items/${id}`, {status: 'closed'}); console.log(id, 'cerrada'); } catch (e) { console.log(id, 'cerrar fallo', e.code, JSON.stringify(e.body ?? e.data ?? e.message).slice(0, 400)); }
  await pausa(400);
}
