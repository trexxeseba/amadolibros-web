// Lista (solo lectura) las publicaciones activas de Vintage que tienen plazo a demanda distinto del pedido, más los ids extra que se le pasen.
// Las que no tienen plazo (joyas y otros productos en stock) NO entran, salvo que vengan en la lista extra.
//   node hermes-monitor/ids_plazo_distinto.mjs <dias> <salida.json> [MLU1,MLU2,...]
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {idsActivos} from '../precio-ganador/src/publicaciones.mjs';
import {bulkItemsPath, bulkEntryItem} from '../worker-sync/meli-bulk.js';
import {CUENTA_HERMES} from './lib.mjs';
import {exigirVintage} from './guardia.mjs';
const [, , diasTxt, salida, extraTxt = ''] = process.argv;
const valor = `${Number(diasTxt)} días`;
const extra = extraTxt.split(',').map(s => s.trim()).filter(x => /^MLU\d+$/.test(x));
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 4});
await exigirVintage(ml);
const yo = await ml.get('/users/me');
const ids = await idsActivos(ml, yo.id);
const lotes = []; for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
const leer = async lote => { for (let n = 0; n < 3; n++) { try { return await ml.get(bulkItemsPath(lote, 'id,sale_terms')); } catch { await new Promise(r => setTimeout(r, 800)); } } return []; };
const cuenta = {}, cambiar = [];
for (let i = 0; i < lotes.length; i += 4) {
  for (const r of await Promise.all(lotes.slice(i, i + 4).map(leer))) for (const e of Array.isArray(r) ? r : []) {
    const it = bulkEntryItem(e); if (!it?.id) continue;
    const p = (it.sale_terms ?? []).find(t => t.id === 'MANUFACTURING_TIME')?.value_name ?? 'sin plazo';
    cuenta[p] = (cuenta[p] || 0) + 1;
    if (p !== 'sin plazo' && p !== valor) cambiar.push(it.id);
  }
}
const todos = [...new Set([...cambiar, ...extra])];
await fs.writeFile(salida, JSON.stringify(todos));
console.log('LISTA', JSON.stringify({activas: ids.length, por_plazo: cuenta, con_otro_plazo: cambiar.length, extra: extra.length, a_cambiar: todos.length}));
