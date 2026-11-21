// Temporal: elimina publicaciones de Vintage en revisión por "etiquetas de Mercado Libre" (orden de Seba: "en estos casos eliminarlas").
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
import {exigirVintage, exigirItemDeVintage} from './guardia.mjs';
const ids = ['MLU704421015'];
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
const pausa = ms => new Promise(r => setTimeout(r, ms));
await exigirVintage(ml);
for (const id of ids) {
  const it = await ml.get(`/items/${id}`).catch(() => null);
  if (!it) { console.log('ELIM', id, 'no se pudo leer'); continue; }
  exigirItemDeVintage(it);
  console.log('ELIM', id, 'antes', it.status, JSON.stringify(it.sub_status));
  if (it.status !== 'closed') { try { await ml.put(`/items/${id}`, {status: 'closed'}); } catch (e) { /* en revisión no deja cerrar */ } await pausa(400); }
  try { await ml.put(`/items/${id}`, {deleted: true}); } catch (e) { console.log('ELIM', id, 'fallo baja', e.code); }
  await pausa(500);
  const d = await ml.get(`/items/${id}`).catch(() => null);
  console.log('ELIM', id, 'despues', d?.status, JSON.stringify(d?.sub_status));
}
