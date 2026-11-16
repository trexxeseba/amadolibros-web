// Cambio de precio a mano, pedido por Seba, sobre publicaciones concretas.
//
//   node precio-ganador/src/precio-manual.mjs --cuenta libros --cambios "MLU1=1500,MLU2=1100" [--real]
//
// Usa la misma conexión que Precio Ganador (token de D1, cliente con reintentos) y
// antes de tocar cada publicación vuelve a comprobar:
//   - sigue activa, en pesos, sin variaciones y sin precio administrado por ML;
//   - sin descuento a la vista ni promoción activa (un PUT de precio los pisa);
//   - el precio nuevo es un entero, no baja del piso de la cuenta y es distinto al actual.
// Escribe con PUT, relee y verifica. Sin --real sólo lista lo que haría. El stock no se toca.
// Si la publicación estaba en el estado de Precio Ganador, el motor la saca solo en la
// próxima corrida (precio cambiado a mano): acá no se toca el estado.
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { detalle } from './publicaciones.mjs';
import { promocionActiva } from './competencia.mjs';

// "MLU1=1500, MLU2=1100" → Map. Rechaza ids repetidos, precios no enteros o no positivos.
export function parsearCambios(texto) {
  const out = new Map();
  for (const parte of String(texto ?? '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean)) {
    const m = parte.match(/^(MLU\d{6,})\s*=\s*(\d+)$/i);
    if (!m) throw new Error(`cambio_invalido: "${parte}" (esperado MLU123=1500)`);
    const id = m[1].toUpperCase(), precio = Number(m[2]);
    if (!Number.isInteger(precio) || precio <= 0) throw new Error(`precio_invalido: "${parte}"`);
    if (out.has(id)) throw new Error(`id_repetido: ${id}`);
    out.set(id, precio);
  }
  if (!out.size) throw new Error('sin_cambios');
  return out;
}

// Parte pura (con tests): decide una publicación con todo lo ya leído.
export function planManual({ item, precio, promo, minimo = 0 }) {
  if (!item) return { accion: 'omitir', motivo: 'no se pudo leer la publicación' };
  if (item.status !== 'active') return { accion: 'omitir', motivo: `no está activa (${item.status})` };
  if (item.currency_id !== 'UYU') return { accion: 'omitir', motivo: 'no está en pesos' };
  if (item.variaciones) return { accion: 'omitir', motivo: 'tiene variaciones' };
  if (item.precio_dinamico) return { accion: 'omitir', motivo: 'precio administrado por Mercado Libre' };
  if (item.original_price !== null && item.original_price !== undefined) return { accion: 'omitir', motivo: 'descuento a la vista' };
  if (promo !== false) return { accion: 'omitir', motivo: promo === true ? 'promoción activa' : 'no se pudo confirmar la promoción' };
  if (!Number.isInteger(precio) || precio <= 0) return { accion: 'omitir', motivo: 'precio pedido inválido' };
  if (precio < minimo) return { accion: 'omitir', motivo: `por debajo del piso de la cuenta (${minimo})` };
  if (Number(item.price) === precio) return { accion: 'omitir', motivo: 'ya tiene ese precio' };
  return { accion: 'cambiar', objetivo: precio, motivo: `${item.price} → ${precio}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
  const real = args.includes('--real');
  const cambios = parsearCambios(opt('cambios'));
  if (cambios.size > 50) throw new Error('mas_de_50_cambios');
  // En Actions (repo público) los logs no muestran precios, sólo IDs y resultado.
  const log = (id, publico, texto) => console.log(process.env.GITHUB_ACTIONS ? `${id}: ${publico}` : `${id}: ${texto}`);

  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 2 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const ids = [...cambios.keys()];
  const items = await detalle(ml, ids);
  const conteo = { pedidas: ids.length, cambiadas: 0, omitidas: 0, errores: 0 };
  for (const id of ids) {
    const item = items.get(id) ?? null;
    let promo = null;
    try { if (item) promo = await promocionActiva(ml, id); } catch (e) { if (e?.fatal || e?.status === 429) throw e; }
    const plan = planManual({ item, precio: cambios.get(id), promo, minimo: cuenta.minimo ?? 0 });
    if (plan.accion !== 'cambiar') { conteo.omitidas++; log(id, `omitida (${plan.motivo.replace(/\d+/g, 'N')})`, `omitida (${plan.motivo})`); continue; }
    log(id, real ? 'cambia' : 'cambiaría', plan.motivo);
    if (!real) continue;
    try {
      await ml.put(`/items/${id}`, { price: plan.objetivo });
      const leido = await ml.get(`/items/${id}?attributes=id,price`);
      if (Number(leido?.price) !== plan.objetivo) { conteo.errores++; log(id, 'no se verificó', `no se verificó (ML muestra ${leido?.price})`); continue; }
      conteo.cambiadas++; log(id, 'verificada', `verificada en ${leido.price}`);
    } catch (err) { conteo.errores++; console.log(`${id}: error ${err?.code ?? 'error'}`); }
  }
  console.log(JSON.stringify({ modo: real ? 'real' : 'dry_run', ...conteo }));
  if (conteo.errores) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(e => { console.error(e?.code ?? e?.message ?? 'error'); process.exit(1); });
}
