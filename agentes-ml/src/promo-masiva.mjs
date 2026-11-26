// Descuento masivo en una promoción de Mercado Libre de Amado Libros (pedido de Seba, 26/11/2026).
//
//   PROMOCION="black friday" MODO=prueba|real DESDE=0 CANTIDAD=1500 [ITEMS="MLU..,MLU.."] \
//     node agentes-ml/src/promo-masiva.mjs --salida DIR
//
// Para cada publicación de la promoción (las que ya están adheridas y las candidatas) calcula el
// precio con el MAYOR descuento que permiten los topes de Seba y lo escribe:
//   - Libros: descuento visible de hasta 26 % sobre el precio regular; lo que no es libro, hasta 20 %.
//   - El total con el cupón más fuerte que podría usar el comprador (cupones de vendedor vigentes,
//     con su compra mínima y su tope) nunca pasa el 40 % (piso de 60 %: perder poco).
//   - Nunca deja el precio más caro que el que se ve hoy ni que el que ya tenía en la promoción.
//   - El 60 % es el mínimo provisorio de Precio Ganador (los costos de Amado Libros no están cargados).
//   - Fuera: libros médicos y la lista manual de config/exclusiones.json.
// Después de escribir relee la entrada de la publicación en la promoción y confirma el precio.
// El repo es público: el log sólo lleva conteos; el detalle va al archivo de salida (repo privado).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTA } from './config.mjs';
import { crearCliente } from './ml.mjs';
import { detalleError } from './sanear.mjs';
import { esLibroMedico } from './guardas.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';

// Seba 26/11 (segundo mensaje): promo hasta 26 % en libros (20 % lo que no es libro); el cupón se puede
// sumar, pero el total con el cupón más fuerte nunca baja del 60 % del regular (piso de Precio Ganador).
export const TOPES = Object.freeze({ visibleMaxPct: 26, visibleNoLibroMaxPct: 20, totalConCuponMaxPct: 40, pisoPct: 60 });
const V2 = 'app_version=v2';
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : [];
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);

// Descuento del cupón más fuerte que se le aplicaría a una compra de `precio`. Función pura.
// cupones: [{ fijo, pct, tope, minimo }]
export function cuponMaximo(precio, cupones) {
  let max = 0;
  for (const c of cupones) {
    if (c.minimo !== null && precio < c.minimo) continue;
    const v = c.fijo !== null ? c.fijo : c.pct !== null ? Math.min(precio * c.pct / 100, c.tope ?? Infinity) : 0;
    if (v > max) max = v;
  }
  return max;
}

// Precio con el mayor descuento dentro de los topes. Función pura. Devuelve { precio, pct, total_pct }
// o { error } si ni siquiera el precio de hoy entra (entonces no se toca).
export function precioConTopes({ regular, techo, min = null, max = null, cupones = [], topes = TOPES }) {
  const R = num(regular), T = num(techo);
  if (!(R > 0) || !(T > 0)) return { error: 'sin_precio' };
  const total = d => (R - d + cuponMaximo(d, cupones)) / R * 100;
  const desde = Math.max(Math.ceil(R * (1 - topes.visibleMaxPct / 100)), Math.ceil(R * topes.pisoPct / 100), num(min) ?? 0);
  const hasta = Math.min(Math.floor(T), num(max) ?? Infinity);
  for (let d = desde; d <= hasta; d++) {
    if (total(d) <= topes.totalConCuponMaxPct + 1e-9) return { precio: d, pct: Math.round((1 - d / R) * 10000) / 100, total_pct: Math.round(total(d) * 100) / 100 };
  }
  return { error: desde > hasta ? 'sin_rango' : 'pasa_el_tope_con_cupon' };
}

// Cupones vigentes de la cuenta a la forma que usa cuponMaximo. Función pura.
export function cuponesDeDetalle(detalles) {
  return detalles.filter(d => d && ['started', 'active'].includes(String(d.status ?? '').toLowerCase())).map(d => ({
    nombre: d.name ?? null, fijo: num(d.fixed_amount), pct: num(d.fixed_percentage), tope: num(d.max_purchase_amount), minimo: num(d.min_purchase_amount),
  })).filter(c => c.fijo !== null || c.pct !== null);
}

async function main() {
  const env = process.env, args = process.argv.slice(2);
  const salida = args[args.indexOf('--salida') + 1] || '.';
  const real = String(env.MODO ?? 'prueba') === 'real';
  const nombre = String(env.PROMOCION ?? '').trim().toLowerCase();
  const desde = Math.max(0, Number(env.DESDE) || 0), cantidad = Math.min(3000, Math.max(1, Number(env.CANTIDAD) || 1500));
  const soloItems = String(env.ITEMS ?? '').split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(s => /^MLU\d{6,15}$/.test(s));
  const config = JSON.parse(readFileSync(new URL('../config/exclusiones.json', import.meta.url), 'utf8'));
  const excluidos = new Set((config.items ?? []).map(s => String(s).toUpperCase()));
  const ml = crearCliente(fuenteTokenD1(CUENTA), { intentos: 4, concurrencia: 4, soloLectura: !real });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== CUENTA.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const promos = lista(await ml.get(`/seller-promotions/users/${CUENTA.sellerId}?${V2}`));
  const promo = promos.find(p => String(p.name ?? '').trim().toLowerCase() === nombre);
  if (!promo) throw Object.assign(new Error('promo_no_encontrada'), { fatal: true });
  if (!['DEAL', 'SELLER_CAMPAIGN'].includes(promo.type)) throw Object.assign(new Error('tipo_no_permitido'), { fatal: true });
  const detCup = [];
  for (const p of promos.filter(p => p.type === 'SELLER_COUPON_CAMPAIGN')) {
    const r = await ml.sonda(`/seller-promotions/promotions/${encodeURIComponent(p.id)}?promotion_type=SELLER_COUPON_CAMPAIGN&${V2}`);
    if (!r.ok) throw Object.assign(new Error('cupon_no_leido'), { fatal: true }); // sin cupones leídos no se puede respetar el 25 %
    detCup.push({ ...r.json, status: r.json?.status ?? p.status, name: p.name });
  }
  const cupones = cuponesDeDetalle(detCup);
  console.log(`Promo ${promo.type} | cupones vigentes leídos: ${cupones.length} | modo ${real ? 'real' : 'prueba'}`);

  // Entradas de la promoción: adheridas (pending/started) y candidatas.
  const entradas = [];
  for (const st of ['started', 'pending', 'candidate']) {
    let token = null;
    for (let i = 0; i < 400; i++) {
      const r = await ml.get(`/seller-promotions/promotions/${encodeURIComponent(promo.id)}/items?promotion_type=${promo.type}&status=${st}&${V2}&limit=50${token ? `&search_after=${encodeURIComponent(token)}` : ''}`);
      const res = lista(r); entradas.push(...res.map(e => ({ ...e, status: e.status ?? st })));
      token = r?.paging?.searchAfter ?? r?.paging?.search_after ?? null;
      if (!res.length || !token) break;
    }
  }
  const unicas = [...new Map(entradas.map(e => [e.id, e])).values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const tanda = soloItems.length ? unicas.filter(e => soloItems.includes(e.id)) : unicas.slice(desde, desde + cantidad);
  console.log(`Entradas en la promo: ${unicas.length} | esta tanda: ${tanda.length}`);

  const filas = [], cuenta = {};
  const anotar = (f) => { filas.push(f); cuenta[f.estado] = (cuenta[f.estado] ?? 0) + 1; };
  const cola = [...tanda];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cola.length) {
      const e = cola.shift(); const id = e.id;
      try {
        if (excluidos.has(id)) { anotar({ id, estado: 'excluido_lista' }); continue; }
        const [it, sp] = await Promise.all([ml.get(`/items/${id}?attributes=id,title,price,available_quantity,status,domain_id`), ml.sonda(`/items/${id}/sale_price`)]);
        if (it?.status !== 'active' || !(it?.available_quantity > 0)) { anotar({ id, estado: 'no_activa' }); continue; }
        if (esLibroMedico(it.title, config)) { anotar({ id, estado: 'excluido_medico' }); continue; }
        const regular = num(sp.json?.regular_amount) ?? num(e.original_price) ?? num(it.price);
        const visible = num(sp.json?.amount) ?? regular;
        const enPromo = num(e.price) > 0 ? num(e.price) : null;
        const techo = Math.min(visible, enPromo ?? Infinity);
        const esLibro = String(it.domain_id ?? '').toUpperCase().endsWith('-BOOKS');
        const obj = precioConTopes({ regular, techo, min: e.min_discounted_price, max: e.max_discounted_price, cupones, topes: esLibro ? TOPES : { ...TOPES, visibleMaxPct: TOPES.visibleNoLibroMaxPct } });
        if (obj.error) { anotar({ id, estado: obj.error, regular, visible, en_promo: enPromo }); continue; }
        if (enPromo !== null && obj.precio >= enPromo) { anotar({ id, estado: 'ya_estaba_al_maximo', regular, precio: enPromo }); continue; }
        if (!real) { anotar({ id, estado: 'haria', regular, visible, en_promo: enPromo, precio: obj.precio, pct: obj.pct, total_pct: obj.total_pct }); continue; }
        const body = { promotion_id: promo.id, promotion_type: promo.type, deal_price: obj.precio };
        let via = 'post';
        try { await ml.post(`/seller-promotions/items/${id}?${V2}`, body); }
        catch (err) {
          if (enPromo === null) throw err;
          // Ya adherida: Mercado Libre no deja cambiar el precio con otro POST; se sale y se vuelve a entrar.
          via = 'delete_post';
          await ml.delete(`/seller-promotions/items/${id}?promotion_type=${promo.type}&promotion_id=${encodeURIComponent(promo.id)}&${V2}`);
          try { await ml.post(`/seller-promotions/items/${id}?${V2}`, body); }
          catch (err2) {
            // Si el precio nuevo no entra, se vuelve a dejar como estaba.
            try { await ml.post(`/seller-promotions/items/${id}?${V2}`, { ...body, deal_price: enPromo }); } catch { /* queda anotado */ }
            anotar({ id, estado: 'error_reingreso', regular, precio_previo: enPromo, intento: obj.precio, detalle: detalleError(err2) }); continue;
          }
        }
        await new Promise(r => setTimeout(r, 1500));
        const r2 = await ml.sonda(`/seller-promotions/items/${id}?${V2}`);
        const entrada = lista(r2.json).find(x => x.id === promo.id);
        const ok = entrada && Math.abs(num(entrada.price) - obj.precio) < 0.01;
        anotar({ id, estado: ok ? 'aplicado' : 'no_verificado', via, regular, precio_previo: enPromo, precio: obj.precio, pct: obj.pct, total_pct: obj.total_pct, leido: num(entrada?.price), estado_entrada: entrada?.status ?? null });
      } catch (err) { anotar({ id, estado: 'error', detalle: detalleError(err) }); }
    }
  }));

  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `promo-masiva-${Date.now()}.json`), JSON.stringify({ promo: { id: promo.id, type: promo.type, name: promo.name }, modo: real ? 'real' : 'prueba', desde, cantidad, cupones, cuenta, filas }, null, 1));
  console.log('Resultado por estado:', JSON.stringify(cuenta)); // sólo conteos
  if ((cuenta.error ?? 0) + (cuenta.no_verificado ?? 0) + (cuenta.error_reingreso ?? 0) > tanda.length * 0.2) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('promo-masiva:', e?.code ?? e?.message); process.exit(1); });
