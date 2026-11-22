// Publica en Amado VINTAGE (nunca Amado Libros) fichas de catálogo: 1 unidad.
//  - Hermes: a 1 % menos que el precio de Hermes.
//  - Arnoia (--fuente=arnoia): libros de la lista de Arnoia con el precio ya calculado, por EAN, plazo "a demanda".
//
//   node hermes-monitor/publicar.mjs <fichas.json> <publicadas.json> [--real] [--max=N]
//
// Sin --real sólo VALIDA con /items/validate (Mercado Libre dice si la publicación sería válida y no
// crea nada). Con --real publica de a una, con pausa; ante cualquier error de una ficha sigue con la
// siguiente y frena si hay 5 errores seguidos. Nunca reactiva ni toca publicaciones existentes.
// Lo publicado queda en publicadas.json (ficha -> publicación) para que el chequeo diario las pause
// cuando Hermes deje de ofrecer la ficha.
import fs from 'node:fs/promises';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {leerFicha} from './chequeo.mjs';
import {d1Client} from '../scripts/vintage-cloud/d1.mjs';
import {brakeOn, blockedIsbns} from '../scripts/vintage-cloud/vigia-pi.mjs';
import {ipRisk} from '../worker-sync/ip-risk.js';
import {normalizarTitulo, normalizarAutor, titulo1, textoNoPermitido} from './lib.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {exigirVintage, exigirItemDeVintage} from './guardia.mjs';
import {precioMio, precioDesdeLista, GLIC_SELLER_ID, PRECIO_MINIMO, paqueteDeVendedor, armarPayload, armarPayloadTradicional, CUENTA_HERMES, TOPE_DIARIO_COMPARTIDO, cupoParaOtros, inicioDiaUy} from './lib.mjs';

const pausa = ms => new Promise(r => setTimeout(r, ms));

// /items/validate con el cuerpo completo de las causas: 2xx acepta; un 400 acepta solo si todas las
// causas son de tipo warning (misma regla que el publicador de la cola de Amado Libros).
async function validar(payload) {
  const res = await fetch('https://api.mercadolibre.com/items/validate', {
    method: 'POST', signal: AbortSignal.timeout(25000),
    headers: {Authorization: 'Bearer ' + await fuente.getToken(), Accept: 'application/json', 'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!res) return {ok: false, causas: [{type: 'error', code: 'transporte'}]};
  if (res.ok) return {ok: true, causas: []};
  const j = await res.json().catch(() => null);
  const causas = (Array.isArray(j?.cause) ? j.cause : []).map(c => ({type: c?.type ?? null, code: c?.code ?? null, message: String(c?.message ?? '').slice(0, 160)}));
  const soloAdvertencias = res.status === 400 && causas.length > 0 && causas.every(c => c.type === 'warning');
  return {ok: soloAdvertencias, causas, status: res.status};
}
const [, , fichasPath, pubPath, ...flags] = process.argv;
const real = flags.includes('--real');
const celesa = flags.includes('--fuente=celesa'); // mismo flujo que Arnoia (catálogo por EAN, tapa propia), con la tapa que trae el archivo de Celesa
const arnoia = flags.includes('--fuente=arnoia') || celesa;
const glic = flags.includes('--fuente=glic'); // mismas fichas de catálogo que Hermes, pero la oferta de referencia es la de GLIC
const ambos = flags.includes('--ambos'); // catálogo si la ficha existe; si no, publicación normal con portada
const tradicional = flags.includes('--tradicional'); // solo libros SIN ficha de catálogo (publicación normal con portada)
const maxPedido = Number(flags.find(f => f.startsWith('--max='))?.slice(6) || 1e9);
let max = maxPedido;
const require_text = await fs.readFile(pubPath, 'utf8').catch(() => '');
const datos = JSON.parse(await fs.readFile(fichasPath, 'utf8'));
const fichas = arnoia ? datos.libros : datos;
// Plazo "a demanda" (disponibilidad): Arnoia 20 días (en la lista); Hermes 18 días, igual que SBS (Seba, 20/11/2026: antes Hermes salía sin plazo y
// prometía despacho rápido de libros que no están en mano).
const PLAZO_HERMES_DIAS = 18;
const PLAZO_DIAS = arnoia ? Number(datos.plazo_dias) || 20 : PLAZO_HERMES_DIAS;
const descartadas = new Set(JSON.parse(await fs.readFile(new URL('./descartadas.json', import.meta.url), 'utf8').catch(() => '{"descartadas":[]}')).descartadas.map(d => d.producto));
const publicadas = (() => { try { return JSON.parse(require_text) ?? {}; } catch { return {}; } })();
const cuenta = CUENTAS[CUENTA_HERMES];
const fuente = fuenteTokenD1(cuenta);
const ml = crearCliente(fuente, {concurrencia: 1});
const seller = cuenta.sellerId;
const query = d1Client();

// Candado de cuenta: el token tiene que ser el de Vintage, verificado con Mercado Libre, antes de cualquier cosa.
await exigirVintage(ml);

// Protecciones de Vintage: freno del vigía de propiedad intelectual, ISBN bloqueados y techo diario
// compartido con la subida de SBS (lo publicado hoy por SBS + lo de Hermes hoy no pasa del tope).
const freno = await brakeOn(query);
if (freno) { console.log('FRENO DEL VIGIA ACTIVO: no se publica nada.', JSON.stringify(freno).slice(0, 200)); process.exit(0); }
const bloqueados = await blockedIsbns(query);
const inicio = inicioDiaUy();
const hoyHermes = Object.values(publicadas).filter(p => p.item_id && Number(p.ts) >= inicio).length;
const hoySbs = Number((await query("SELECT COUNT(*) n FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND created_at>=?", [seller, inicio]))[0]?.n ?? 0);
let cupo = cupoParaOtros(hoySbs, hoyHermes);
console.log(`hoy: SBS ${hoySbs}, Hermes+Arnoia ${hoyHermes}, tope compartido ${TOPE_DIARIO_COMPARTIDO}, cupo ${cupo}`);
// El cupo solo limita publicar de verdad; validar no crea nada y se puede hacer sin cupo.
if (real && cupo === 0) { console.log('Sin cupo diario: no se publica nada.'); process.exit(0); }
max = real ? Math.min(maxPedido, cupo) : maxPedido;

const prefs = await ml.get(`/users/${seller}/shipping_preferences`).catch(() => null);
const yo = await ml.get(`/users/${seller}`).catch(() => null);
const usaFamilyName = Array.isArray(yo?.tags) && yo.tags.includes('user_product_seller');
const logistica = (prefs?.logistics ?? []).find(l => l?.mode === 'me2')?.types?.find(t => t.default)?.type ?? null;
const base = {mode: 'me2', local_pick_up: false, free_shipping: true, free_methods: []};
const variantes = [base, ...(logistica ? [{...base, logistic_type: logistica}, {...base, logistic_type: logistica, local_pick_up: true}] : [{...base, local_pick_up: true}])];
console.log(`modo ${real ? 'REAL' : 'solo validar'} | family_name ${usaFamilyName} | logística ${logistica}`);

let hechas = 0, erroresSeguidos = 0, examinadas = 0;
// Topes de seguridad: el máximo cuenta solo lo publicado, así que en una tanda donde casi nada califica (por ejemplo solo catálogo)
// el recorrido podía durar horas (19/11/2026: una tanda de casi una hora). Se mira como mucho 4 veces el máximo y hasta 25 minutos.
const MAX_EXAMINADAS = Math.max(80, Math.min(maxPedido, 1000) * 4);
// --minutos=N acorta el tope cuando varias fuentes comparten la misma hora de tanda (22/11/2026).
const minutosPedidos = Number(process.argv.find(a => a.startsWith('--minutos='))?.split('=')[1]);
const INICIO = Date.now(), MAX_MS = (minutosPedidos > 0 && minutosPedidos <= 25 ? minutosPedidos : 25) * 60e3;
const filas = [];
// Portada por ISBN (decisión de Seba, 18/11/2026: tapas de una librería española). Casa del Libro primero, Open Library
// como respaldo. Solo se acepta una imagen real: JPEG, de al menos 40 KB (una imagen genérica o de error pesa mucho menos),
// y con las tapas revisadas a mano en la primera tanda. Sin portada no se publica.
// 21/11/2026: el piso era de 40 KB y descartaba tapas reales chicas (Casa del Libro devuelve 404 cuando no tiene la tapa, así que un 200 es una tapa de verdad):
// 653 libros quedaron "sin portada" por eso. Ahora el piso es de 8 KB, el lector exige al menos 200 px de lado y la tapa chica se agranda antes de subirla.
const MIN_BYTES_PORTADA = 8000;
const VERSION_REGLA_PORTADA = 2; // las marcas "sin_portada" anteriores a esta regla se vuelven a probar
const vetadas = JSON.parse(await fs.readFile(new URL('./data/portadas-vetadas.json', import.meta.url), 'utf8').catch(() => '{"titulo_regex":[]}')).titulo_regex.map(r => new RegExp(r, 'i'));
const execFileP = promisify(execFile);
// Revisa la tapa con hermes-monitor/limpiar_tapa.py (lector de texto con la tapa agrandada). Devuelve:
// {estado:'limpia'} | {estado:'borrada', bytes} | {estado:'no_se_pudo', motivo}. Si el lector falla, la tapa NO se usa.
async function revisarTapa(bytes) {
  const base = path.join(os.tmpdir(), `tapa-${process.pid}-${Date.now()}`);
  const entrada = base + '-in.jpg', salida = base + '-out.jpg';
  await fs.writeFile(entrada, Buffer.from(bytes));
  try {
    const {stdout} = await execFileP('python3', [fileURLToPath(new URL('./limpiar_tapa.py', import.meta.url)), entrada, salida], {timeout: 240000, maxBuffer: 4e6});
    const r = JSON.parse(stdout.trim().split('\n').pop());
    return r.estado === 'borrada' ? {estado: 'borrada', motivo: (r.borradas ?? []).join(','), bytes: await fs.readFile(salida)} : r;
  } finally { await fs.rm(entrada, {force: true}); await fs.rm(salida, {force: true}); }
}
// Rehace la imagen (JPEG nuevo, sin datos ocultos): Mercado Libre dejó en revisión tapas limpias a la vista con "etiquetas de Mercado Libre"
// (20/11/2026) y al subir la misma tapa rehecha se reactivaron. Devuelve los bytes nuevos o null.
async function recodificarTapa(bytes) {
  const base = path.join(os.tmpdir(), `tapa-${process.pid}-${Date.now()}`);
  const entrada = base + '-r-in.jpg', salida = base + '-r-out.jpg';
  await fs.writeFile(entrada, Buffer.from(bytes));
  try {
    await execFileP('python3', ['-c', 'import sys\nfrom PIL import Image\nIm=Image.open(sys.argv[1]).convert("RGB")\nm=max(Im.size)\nIm=Im.resize((round(Im.size[0]*800/m),round(Im.size[1]*800/m)),Image.LANCZOS) if m<800 else Im\nIm.save(sys.argv[2],"JPEG",quality=92,optimize=True)', entrada, salida], {timeout: 60000});
    return await fs.readFile(salida);
  } catch { return null; } finally { await fs.rm(entrada, {force: true}); await fs.rm(salida, {force: true}); }
}
// Sube una foto a Mercado Libre (pictures/items/upload) y devuelve su id. Con ella se publica {id} en vez de una URL externa.
async function subirFoto(buf) {
  const form = new FormData();
  form.append('file', new Blob([buf], {type: 'image/jpeg'}), 'tapa.jpg');
  const res = await fetch('https://api.mercadolibre.com/pictures/items/upload', {method: 'POST', headers: {Authorization: 'Bearer ' + await fuente.getToken()}, body: form, signal: AbortSignal.timeout(60000)});
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  return typeof j?.id === 'string' ? j.id : null;
}
const buscarPortada = async (ean, urlPropia) => {
  const candidatas = [...(urlPropia ? [urlPropia] : []), `https://imagessl3.casadellibro.com/a/l/t0/${ean.slice(-2)}/${ean}.jpg`, `https://covers.openlibrary.org/b/isbn/${ean}-L.jpg`];
  for (const url of candidatas) {
    const r = await fetch(url + (url.includes('openlibrary') ? '?default=false' : ''), {method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20000)}).catch(() => null);
    if (!r?.ok || !/image\/jpeg/.test(r.headers.get('content-type') ?? '')) continue;
    const bytes = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (bytes.byteLength < MIN_BYTES_PORTADA) continue;
    if (!real && process.env.HERMES_PORTADA_PRUEBA) return {url};
    let rev;
    try { rev = await revisarTapa(bytes); } catch (e) { console.log(`${ean}\tlector de tapas falló: ${String(e?.stderr ?? e?.message ?? e).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300)}`); return {rechazada: 'lector_de_texto_no_disponible', sinMarca: true}; }
    if (rev.estado === 'limpia') {
      const nueva = await recodificarTapa(bytes);
      const idNueva = nueva ? await subirFoto(nueva).catch(() => null) : null;
      return idNueva ? {pictureId: idNueva} : {url};
    }
    // Una @ en la tapa: el libro se salta, sin limpiar ni subir nada (regla de Seba, 20/11/2026).
    // Otros datos de contacto o referencias externas se borran de la tapa y se sube la limpia; si no se puede, el libro se salta.
    if (rev.estado !== 'borrada') return {rechazada: rev.motivo ?? 'tapa_no_apta'};
    const id = await subirFoto(rev.bytes).catch(() => null);
    if (id) console.log(`${ean}\ttapa limpiada (se borró: ${rev.motivo}) y subida a Mercado Libre`);
    return id ? {pictureId: id, limpiada: rev.motivo} : {rechazada: 'no_se_pudo_subir_la_tapa_limpia'};
  }
  return null;
};
const descripcionDe = f => `${normalizarTitulo(f.titulo)}${f.autor ? ', de ' + normalizarAutor(f.autor) : ''}.${f.editorial ? ' Editorial ' + titulo1(f.editorial) + '.' : ''}\n\nLibro nuevo, importado de España. Lo traemos especialmente para vos: la entrega se coordina en un plazo de ${PLAZO_DIAS} días. Envío a domicilio incluido.`;

// 22/11/2026: lo que se salta por un motivo que no cambia solo (propiedad intelectual) o que puede cambiar en unos días (la fuente dejó de ofrecerlo, precio bajo
// el mínimo) se ANOTA, y las tandas siguientes lo saltan sin gastar consultas. Antes se volvía a revisar en cada tanda: 240 libros revisados por tanda, 1 publicado.
const diasDesdeHoy = n => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);
const anotadoVigente = p => Boolean(p) && !(p.reintentar_desde && new Date().toISOString().slice(0, 10) >= p.reintentar_desde);
const resolverHermes = async f => {
  if (conArroba(f)) return {omitir: true}; // arroba en los datos: ni se busca, ni se anota, ni gasta cupo de revisión (regla de Seba)
  if (publicadas[f.producto]?.item_id || f.mi_mlu || descartadas.has(f.producto) || anotadoVigente(publicadas[f.producto])) return {omitir: true};
  const lec = await leerFicha(ml, f.producto, undefined, glic ? GLIC_SELLER_ID : undefined);
  if (!lec.oferta) return {etiqueta: f.n, clave: f.producto, saltar: glic ? 'glic_no_ofrece' : 'hermes_no_ofrece', marcar: {omitido: glic ? 'glic_no_ofrece' : 'hermes_no_ofrece', reintentar_desde: diasDesdeHoy(3)}};
  const precioFicha = glic ? precioDesdeLista({...lec.oferta, original_price: lec.oferta.original_price ?? f.precio_lista}) : precioMio(lec.oferta.price);
  if (glic && (!precioFicha || precioFicha < PRECIO_MINIMO)) return {etiqueta: f.n, clave: f.producto, saltar: 'precio_bajo_minimo', marcar: {omitido: 'precio_bajo_minimo', reintentar_desde: diasDesdeHoy(3)}};
  await pausa(500);
  const prod = await ml.get(`/products/${f.producto}`).catch(() => null);
  if (!prod || prod.status !== 'active') return {etiqueta: f.n, clave: f.producto, saltar: 'ficha_inactiva', marcar: {omitido: 'ficha_inactiva', reintentar_desde: diasDesdeHoy(3)}};
  return {etiqueta: f.n, clave: f.producto, producto: f.producto, prod, precio: precioFicha, categoria: lec.oferta.category_id, registro: glic ? {precio_glic: lec.oferta.price, precio_lista_glic: lec.oferta.original_price ?? null, fuente_glic: true} : {precio_hermes: lec.oferta.price}, nota: `${glic ? 'GLIC' : 'Hermes'} ${lec.oferta.price}`, titulo: f.titulo};
};
// Regla de Seba (20/11/2026): una @ en el título, el autor o la editorial deja el libro fuera. Va antes de todo: no se busca, no se limpia, no se sube, no se guarda.
const conArroba = f => /@/.test([f.titulo, f.autor, f.editorial].filter(Boolean).join(' '));
const resolverArnoia = async f => {
  if (conArroba(f)) return {omitir: true};
  const clave = 'arnoia:' + f.ean;
  const previo = publicadas[clave];
  if (previo?.item_id || previo?.no_valida || (previo?.omitido && anotadoVigente(previo))) return {omitir: true};
  // Anotados en una tanda anterior (21/11/2026): se saltan sin gastar ni una consulta. Antes el 'sin_catalogo' viejo impedía anotar 'sin_portada' y 139 libros
  // se revisaban de nuevo en cada tanda, gastando los 25 minutos sin publicar ninguno.
  if ((tradicional || ambos) && (previo?.portada_rechazada || previo?.sin_autor)) return {omitir: true};
  if ((tradicional || ambos) && previo?.sin_portada && previo.v === VERSION_REGLA_PORTADA && Date.now() - Date.parse(previo.fecha ?? 0) < 7 * 86400e3) return {omitir: true};
  // Sin ficha de catálogo y en modo solo-catálogo: no se vuelve a buscar. En modo publicación normal sí se reintenta.
  if (previo?.sin_catalogo && !tradicional && !ambos) return {omitir: true};
  await pausa(500);
  const busq = await ml.get('/products/search?' + new URLSearchParams({site_id: 'MLU', status: 'active', product_identifier: f.ean})).catch(() => null);
  const id = busq?.results?.[0]?.id;
  if (!/^MLU\d+$/.test(id ?? '')) {
    if (!tradicional && !ambos) return {etiqueta: f.ean, clave, saltar: 'sin_catalogo', marcar: {sin_catalogo: true}};
    if (vetadas.some(r => r.test(f.titulo))) return {etiqueta: f.ean, saltar: 'serie_vetada_por_fotos'};
    if (previo?.portada_rechazada || previo?.sin_autor) return {omitir: true};
    // Mercado Libre exige el autor en la publicación normal: sin autor no se valida (20/11/2026: 5 seguidos sin autor frenaron la tanda con solo 7 altas).
    if (!String(f.autor ?? '').trim()) return {etiqueta: f.ean, clave, saltar: 'sin_autor', marcar: {sin_autor: true}};
    // Sin portada disponible: se anota y se vuelve a probar a la semana (no se re-mira en cada tanda, que gasta el tope de libros revisados).
    if (previo?.sin_portada && previo.v === VERSION_REGLA_PORTADA && Date.now() - Date.parse(previo.fecha ?? 0) < 7 * 86400e3) return {omitir: true};
    const por = await buscarPortada(f.ean, f.url_portada); // la portada de prueba solo vale para validar, nunca para publicar
    if (!por) return {etiqueta: f.ean, clave, saltar: 'sin_portada', marcar: {sin_portada: true, v: VERSION_REGLA_PORTADA}};
    if (por.rechazada) return {etiqueta: f.ean, clave, saltar: 'portada_con_' + por.rechazada, ...(por.sinMarca ? {} : {marcar: {portada_rechazada: por.rechazada}})};
    const portada = por.pictureId ? {id: por.pictureId} : por.url;
    const payload = armarPayloadTradicional({ean: f.ean, titulo: f.titulo, autor: f.autor, editorial: f.editorial, precio: f.precio, plazoDias: PLAZO_DIAS, usaFamilyName, imagenes: [portada], pesoGramos: f.peso_g});
    return {etiqueta: f.ean, clave, producto: null, prod: {attributes: []}, isbn: f.ean, precio: f.precio, payload, registro: {ean: f.ean, tradicional: true, ...(por.limpiada ? {portada_limpiada: por.limpiada} : {})}, nota: f.titulo.slice(0, 30), titulo: f.titulo, editorial: f.editorial, descripcion: descripcionDe(f), aprobado: f.aprobado_por_seba === true};
  }
  if (publicadas[id]?.item_id) return {omitir: true}; // esa ficha de catálogo ya la publicó GLIC o Hermes: no se duplica
  if (tradicional) return {omitir: true};
  await pausa(500);
  const prod = await ml.get(`/products/${id}`).catch(() => null);
  if (!prod || prod.status !== 'active') return {etiqueta: f.ean, saltar: 'ficha_inactiva'};
  if ((prod.children_ids ?? []).length) return {etiqueta: f.ean, saltar: 'ficha_con_variantes'};
  return {etiqueta: f.ean, clave, producto: id, prod, precio: f.precio, categoria: 'MLU1196', registro: {ean: f.ean}, nota: f.titulo.slice(0, 30), titulo: f.titulo, autor: f.autor, editorial: f.editorial, aprobado: f.aprobado_por_seba === true};
};

for (const f of fichas) {
  if (hechas >= max || erroresSeguidos >= 5) break;
  if (examinadas >= MAX_EXAMINADAS) { console.log(`Tope de libros revisados (${MAX_EXAMINADAS}): se corta la tanda.`); break; }
  if (Date.now() - INICIO > MAX_MS) { console.log(`Tope de tiempo (${MAX_MS / 60e3} minutos): se corta la tanda.`); break; }
  const ctx = await (arnoia ? resolverArnoia(f) : resolverHermes(f));
  if (ctx.omitir) continue;
  examinadas++;
  if (ctx.saltar) {
    filas.push({n: ctx.etiqueta, resultado: ctx.saltar});
    console.log(`${ctx.etiqueta}\tsalteada: ${ctx.saltar}`);
    if (ctx.marcar && real && !publicadas[ctx.clave]?.item_id) { publicadas[ctx.clave] = {...(publicadas[ctx.clave] ?? {}), ...ctx.marcar, fecha: new Date().toISOString().slice(0, 10)}; await fs.writeFile(pubPath, JSON.stringify(publicadas, null, 1)); }
    continue;
  }
  const {prod} = ctx;
  const isbn = ctx.isbn ?? (prod.attributes ?? []).find(a => a.id === 'GTIN' || a.id === 'ISBN')?.value_name ?? null;
  if (isbn && bloqueados.has(String(isbn))) { filas.push({n: ctx.etiqueta, resultado: 'isbn_bloqueado_por_denuncia'}); console.log(`${ctx.etiqueta}\tsalteada: ISBN bloqueado por denuncia`); continue; }
  const editorial = (prod.attributes ?? []).find(a => ['BOOK_PUBLISHER', 'PUBLISHER'].includes(a.id))?.value_name;
  const riesgo = ipRisk([prod.name, prod.family_name, ctx.titulo, ctx.autor].filter(Boolean).join(' '), editorial || ctx.editorial);
  // Libros que Seba aprobó a mano: solo se exime del grupo "copia" (palabras sueltas como pirata, estilo, tipo); el resto de los grupos sigue frenando.
  if (riesgo && !(ctx.aprobado && riesgo === 'copia')) {
    filas.push({n: ctx.etiqueta, resultado: 'riesgo_pi_' + riesgo}); console.log(`${ctx.etiqueta}\tsalteada: riesgo de propiedad intelectual (${riesgo})`);
    if (real && ctx.clave && !publicadas[ctx.clave]?.item_id) { publicadas[ctx.clave] = {...(publicadas[ctx.clave] ?? {}), omitido: 'riesgo_pi_' + riesgo, fecha: new Date().toISOString().slice(0, 10)}; await fs.writeFile(pubPath, JSON.stringify(publicadas, null, 1)); }
    continue;
  }
  const precio = ctx.precio;
  let payload = ctx.payload ?? armarPayload({producto: ctx.producto, precio, categoria: ctx.categoria, nombre: prod.name, familyName: prod.family_name, usaFamilyName, isbn, plazoDias: PLAZO_DIAS});
  let valido = null, ultimo = null;
  for (const shipping of variantes) {
    await pausa(500);
    let v = await validar({...payload, shipping});
    // Fichas de catálogo sin medidas de paquete (pasa con muchos libros importados): se agregan las de la banda de un libro de 500 g y se valida de nuevo.
    if (!v.ok && v.causas.some(c => /package\.dimensions/.test(String(c.code))) && !payload.attributes?.some(a => /SELLER_PACKAGE/.test(a.id))) {
      payload = {...payload, attributes: [...(payload.attributes ?? []), ...paqueteDeVendedor(500)]};
      await pausa(500);
      v = await validar({...payload, shipping});
    }
    if (v.ok) { valido = shipping; ultimo = v; break; }
    ultimo = v;
    if (!v.causas.some(c => /shipping/.test(String(c.code)))) break;
  }
  if (!valido) {
    // 21/11/2026: las fichas que Mercado Libre rechaza por algo propio de ESA ficha (sin fotos, atributo obligatorio que falta, medidas) se anotan y se
    // saltan en las próximas tandas, y no cuentan como "errores seguidos". Antes cada tanda de GLIC se frenaba en los mismos 5 libros del principio y
    // nunca llegaba a los nuevos (0 altas en todo el día).
    const especifico = (ultimo?.causas ?? []).some(c => c.type === 'error' && /missing_required|requiresPictures|package\.dimensions|invalid/.test(String(c.code)));
    if (especifico && real && ctx.clave) {
      publicadas[ctx.clave] = {no_valida: true, causa: String((ultimo.causas.find(c => c.type === 'error') ?? {}).code ?? ''), fecha: new Date().toISOString().slice(0, 10)};
      await fs.writeFile(pubPath, JSON.stringify(publicadas, null, 1));
    } else erroresSeguidos++;
    filas.push({n: ctx.etiqueta, resultado: 'no_valida', causas: ultimo?.causas}); console.log(`${ctx.etiqueta}\tNO VALIDA ${JSON.stringify(ultimo?.causas)}`); continue;
  }
  if (ultimo?.causas?.length) console.log(`${ctx.etiqueta}\tadvertencias ${JSON.stringify(ultimo.causas)}`);
  if (!real) { erroresSeguidos = 0; hechas++; filas.push({n: ctx.etiqueta, resultado: 'valida', precio}); console.log(`${ctx.etiqueta}\tvalida\tprecio ${precio} (${ctx.nota})`); continue; }
  await pausa(1000);
  try {
    const r = await ml.post('/items', {...payload, shipping: valido});
    // Verificación posterior: si por cualquier razón quedó en otra cuenta, se pausa en el acto y se corta todo.
    try { exigirItemDeVintage(await ml.get(`/items/${r?.id}`)); }
    catch (e) { await ml.put(`/items/${r?.id}`, {status: 'paused'}).catch(() => {}); console.log(`${ctx.etiqueta}\tCORTE: ${e.code} (${r?.id}), se pausó y se frena todo`); process.exit(1); }
    if (ctx.descripcion && r?.id) await ml.post(`/items/${r.id}/description`, {plain_text: ctx.descripcion}).catch(e => console.log(`${ctx.etiqueta}\tdescripción no cargada (${e.code})`));
    publicadas[ctx.clave] = {item_id: r?.id, precio, ...ctx.registro, fuente: celesa ? 'celesa' : arnoia ? 'arnoia' : glic ? 'glic' : 'hermes', fecha: new Date().toISOString().slice(0, 10), ts: Date.now(), cuenta: CUENTA_HERMES};
    await fs.writeFile(pubPath, JSON.stringify(publicadas, null, 1));
    erroresSeguidos = 0; hechas++;
    console.log(`${ctx.etiqueta}\tPUBLICADA ${r?.id} precio ${precio}`);
  } catch (e) { erroresSeguidos++; console.log(`${ctx.etiqueta}\tERROR al publicar ${e.code} ${JSON.stringify(e.detalle)}`); }
}
console.log('\nRESUMEN', JSON.stringify({modo: real ? 'real' : 'validar', procesadas: hechas, errores_seguidos: erroresSeguidos, llamadas: ml.stats.llamadas}));
