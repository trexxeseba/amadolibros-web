// Libros que ganamos muy por debajo del competidor más barato (sólo lee, no cambia precios).
// Seba, 12/11/2026: "subir los que ganamos baratos", con la lista a la vista para aprobar.
//
//   node precio-ganador/src/baratos.mjs --cuenta libros --salida DIR [--razon 1.25]
//
// Para cada publicación de catálogo con ficha: el precio más barato de OTRO vendedor en la
// ficha. Si es 25 % o más caro que el nuestro y la ficha la ganamos (price_to_win), entra a la
// lista con un precio sugerido (97 % del competidor, sin subir más de 30 % de una vez).
// Mercado Libre pesa envío y reputación: por eso sólo se propone subir, nunca se aplica solo.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { ofertasCatalogo } from './competencia.mjs';

export const RAZON_MINIMA = 1.25, FACTOR_SUGERIDO = 0.97, SUBIDA_MAXIMA = 1.30;

// Parte pura (con tests).
export function candidatos(filas, { razon = RAZON_MINIMA } = {}) {
  return filas.filter(f => f.mas_barato && f.precio > 0 && f.mas_barato / f.precio >= razon && f.gana)
    .map(f => {
      const tope = Math.floor(f.precio * SUBIDA_MAXIMA), objetivo = Math.floor(f.mas_barato * FACTOR_SUGERIDO);
      const sugerido = Math.max(f.precio, Math.min(objetivo, tope));
      return { ...f, sugerido, ganancia_por_unidad: sugerido - f.precio, razon: Math.round(f.mas_barato / f.precio * 100) / 100, en_un_paso: objetivo <= tope };
    })
    .filter(f => f.ganancia_por_unidad >= 10)
    .sort((a, b) => b.ganancia_por_unidad - a.ganancia_por_unidad);
}

export function markdown(lista, { cuenta, fecha, total }) {
  const l = [`# Libros que ganamos baratos · ${cuenta.nombre} · ${fecha}`, '',
    `Revisadas ${total} fichas de catálogo. ${lista.length} libros donde ganamos la ficha con un precio muy por debajo del competidor más barato.`,
    'Sólo es una propuesta: nada se cambió. El "sugerido" es el 97 % del competidor, sin subir más de 30 % de una vez.',
    'Ojo: no distingue si el competidor es usado u otra edición. Abrí el link y mirá la ficha antes de aprobar cada uno.', '',
    '| Libro | Nuestro precio | Competidor más barato | Veces más caro | Precio sugerido | Ganancia por unidad |', '|---|---:|---:|---:|---:|---:|'];
  for (const f of lista) l.push(`| [${String(f.titulo).slice(0, 55).replace(/\|/g, '/')}](https://articulo.mercadolibre.com.uy/${f.id.replace('MLU', 'MLU-')}) | ${f.precio} | ${f.mas_barato} | ${f.razon} | ${f.sugerido}${f.en_un_paso ? '' : ' (en 2 pasos)'} | +${f.ganancia_por_unidad} |`);
  return l.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta) { console.error('Usar --cuenta libros|vintage'); process.exit(2); }
  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });
  const ids = await idsActivos(ml, cuenta.sellerId);
  const items = [...(await detalle(ml, ids)).values()].filter(i => i.status === 'active' && i.catalog_listing && i.catalog_product_id && i.currency_id === 'UYU' && !i.variaciones);
  const filas = [];
  const cola = [...items];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cola.length) {
      const it = cola.shift();
      try {
        const ofertas = (await ofertasCatalogo(ml, it.catalog_product_id))
          .filter(o => String(o.seller_id) !== String(cuenta.sellerId) && o.item_id !== it.id && Number.isFinite(Number(o.price)));
        if (!ofertas.length) continue;
        filas.push({ id: it.id, titulo: it.title, precio: it.price, mas_barato: Math.min(...ofertas.map(o => Number(o.price))), gana: null, pid: it.catalog_product_id });
      } catch (e) { if (e?.fatal || e?.status === 429) throw e; }
    }
  }));
  // Sólo a los que pasan el filtro de precio se les pregunta si ganan la ficha.
  const previa = filas.filter(f => f.mas_barato / f.precio >= RAZON_MINIMA);
  for (const f of previa) {
    try { const p = await ml.get(`/items/${f.id}/price_to_win?version=v2`); f.gana = p?.status === 'winning' || p?.status === 'sharing_first_place'; } catch { f.gana = false; }
  }
  const lista = candidatos(previa);
  mkdirSync(opt('salida', '.'), { recursive: true });
  writeFileSync(join(opt('salida', '.'), `${cuenta.clave}-baratos.md`), markdown(lista, { cuenta, fecha: new Date().toISOString().slice(0, 10), total: items.length }));
  console.log(JSON.stringify({ fichas_revisadas: items.length, con_competidor: filas.length, candidatos: lista.length }));
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('baratos:', e.message); process.exit(1); });
