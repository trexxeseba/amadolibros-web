// Vuelve al precio original todas las publicaciones que el sistema bajó.
//
//   node precio-ganador/src/restaurar.mjs --cuenta libros [--real] [--estado DIR] [--ids MLU1,MLU2]
//
// Sin --real sólo lista lo que haría. Toca únicamente las publicaciones cuyo
// precio actual sigue siendo el que puso el sistema: si alguien lo cambió a
// mano, se deja como está. Con --ids sólo esas publicaciones (Seba, 12/11/2026:
// Fantastic Mr. Fox, que el competidor persigue).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const cuenta = CUENTAS[opt('cuenta')];
if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
const real = args.includes('--real');
const soloIds = (opt('ids') ?? '').split(',').map(x => x.trim()).filter(Boolean);
const archivo = join(opt('estado', 'state'), `${cuenta.clave}.json`);
const estado = JSON.parse(readFileSync(archivo, 'utf8'));
const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 2 });

const yo = await ml.get('/users/me');
if (String(yo?.id) !== cuenta.sellerId) { console.error('token_de_otra_cuenta'); process.exit(1); }
// En Actions (repo público) los logs no muestran precios, sólo IDs y conteos.
const detalle = (id, texto) => console.log(process.env.GITHUB_ACTIONS ? id : `${id}: ${texto}`);
const cuenta_ = { restauradas: 0, editadas_a_mano: 0, errores: 0, a_restaurar: 0 };
for (const [id, e] of Object.entries(estado.publicaciones)) {
  if (soloIds.length && !soloIds.includes(id)) continue;
  try {
    const item = await ml.get(`/items/${id}?attributes=id,price,available_quantity`);
    if (Number(item.price) !== Number(e.precio_aplicado)) { cuenta_.editadas_a_mano++; detalle(id, `precio actual ${item.price}, se deja`); continue; }
    const body = { price: Number(e.precio_original), ...(e.stock_original !== undefined ? { available_quantity: Number(e.stock_original) } : {}) };
    cuenta_.a_restaurar++;
    detalle(id, `${item.price} → ${body.price}${body.available_quantity !== undefined ? `, stock → ${body.available_quantity}` : ''}`);
    if (!real) continue;
    await ml.put(`/items/${id}`, body);
    const leido = await ml.get(`/items/${id}?attributes=id,price`);
    if (Number(leido?.price) !== body.price) { cuenta_.errores++; detalle(id, `no se verificó (ML muestra ${leido?.price})`); continue; }
    delete estado.publicaciones[id]; cuenta_.restauradas++;
    writeFileSync(archivo + '.tmp', JSON.stringify(estado, null, 2) + '\n'); renameSync(archivo + '.tmp', archivo);
  } catch (err) { cuenta_.errores++; console.log(`${id}: error ${err?.code ?? 'error'}`); }
}
console.log(JSON.stringify({ modo: real ? 'real' : 'dry_run', ...cuenta_ }));
if (cuenta_.errores) process.exit(1);
