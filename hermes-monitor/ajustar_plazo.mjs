// Pone el plazo "a demanda" (MANUFACTURING_TIME) a publicaciones ya creadas de Vintage. Solo cambia ese dato: no toca precio ni stock.
//   node hermes-monitor/ajustar_plazo.mjs <ids.json> <dias> [--real]
// Sin --real solo lee y cuenta. Verifica antes y después que cada publicación sea de Amado Vintage; las cerradas no se tocan.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
import {exigirVintage, exigirItemDeVintage} from './guardia.mjs';

const [, , idsPath, diasTxt, ...flags] = process.argv;
const real = flags.includes('--real');
const dias = Number(diasTxt);
if (!Number.isInteger(dias) || dias < 1 || dias > 60) { console.error('uso: ajustar_plazo.mjs <ids.json> <dias 1-60> [--real]'); process.exit(2); }
const ids = [...new Set(JSON.parse(await fs.readFile(idsPath, 'utf8')))].filter(x => /^MLU\d+$/.test(x));
const ml = crearCliente(fuenteTokenD1(CUENTAS[CUENTA_HERMES]), {concurrencia: 1});
const pausa = ms => new Promise(r => setTimeout(r, ms));
await exigirVintage(ml);
const valor = `${dias} días`;
const cuenta = {};
const sumar = k => { cuenta[k] = (cuenta[k] || 0) + 1; };
for (const id of ids) {
  await pausa(450);
  const it = await ml.get(`/items/${id}`).catch(() => null);
  if (!it) { sumar('no_se_pudo_leer'); continue; }
  exigirItemDeVintage(it);
  if (it.status === 'closed') { sumar('cerrada_no_se_toca'); continue; }
  const actual = (it.sale_terms ?? []).find(t => t.id === 'MANUFACTURING_TIME')?.value_name ?? 'sin plazo';
  if (actual === valor) { sumar('ya_tenia_' + valor); continue; }
  if (!real) { sumar('se_cambiaria_desde_' + actual.replace(/\s+/g, '_')); continue; }
  const otros = (it.sale_terms ?? []).filter(t => t.id !== 'MANUFACTURING_TIME').map(t => ({id: t.id, value_name: t.value_name}));
  try { await ml.put(`/items/${id}`, {sale_terms: [...otros, {id: 'MANUFACTURING_TIME', value_name: valor}]}); } catch (e) { sumar('fallo_' + e.code); console.log(id, 'fallo', e.code, JSON.stringify(e.detalle)); continue; }
  await pausa(300);
  const d = await ml.get(`/items/${id}`).catch(() => null);
  const quedo = (d?.sale_terms ?? []).find(t => t.id === 'MANUFACTURING_TIME')?.value_name;
  sumar(quedo === valor ? 'cambiada' : 'no_quedo_' + quedo);
}
console.log('RESUMEN', JSON.stringify({modo: real ? 'real' : 'solo_lectura', total: ids.length, dias, ...cuenta}));
