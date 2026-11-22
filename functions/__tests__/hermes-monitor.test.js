import test from 'node:test';
import assert from 'node:assert/strict';
import {ofertaDeHermes, estadoFicha, cambioDePrecio, fallaGeneral, ultimosPorFicha, armarResumen} from '../../hermes-monitor/lib.mjs';
import {correr} from '../../hermes-monitor/chequeo.mjs';

test('ofertaDeHermes encuentra al vendedor de Hermes o devuelve null', () => {
  assert.equal(ofertaDeHermes([{seller_id: 1}, {seller_id: 471589392, price: 10}]).price, 10);
  assert.equal(ofertaDeHermes([{seller_id: 1}]), null);
  assert.equal(ofertaDeHermes(undefined), null);
});

test('estadoFicha: un error nunca cuenta como sin oferta', () => {
  assert.equal(estadoFicha({error: 'http_500'}), 'error');
  assert.equal(estadoFicha({oferta: null}), 'sin_oferta');
  assert.equal(estadoFicha({oferta: {price: 1}}), 'ofrece');
});

test('cambioDePrecio solo avisa por más del 5 %', () => {
  assert.equal(cambioDePrecio(1000, 1040), null);
  assert.ok(cambioDePrecio(1000, 1060) > 0.05);
  assert.ok(cambioDePrecio(1000, 900) < -0.05);
  assert.equal(cambioDePrecio(null, 900), null);
});

test('fallaGeneral frena cuando casi todas desaparecen', () => {
  assert.equal(fallaGeneral(Array(30).fill('sin_oferta')), true);
  assert.equal(fallaGeneral([...Array(28).fill('ofrece'), 'sin_oferta', 'sin_oferta']), false);
  assert.equal(fallaGeneral(['sin_oferta', 'sin_oferta']), false);
});

function mlFalso({ofrecen, items = {}}) {
  const puts = [];
  return {puts, get: async p => {
    const m = p.match(/\/products\/(MLU\d+)\/items/);
    if (m) return {paging: {total: 1}, results: ofrecen.includes(m[1]) ? [{seller_id: 471589392, price: 1000, item_id: 'MLU1'}] : [{seller_id: 9, price: 500}]};
    const it = p.match(/\/items\/(MLU\d+)$/)?.[1];
    return items[it] ?? null;
  }, put: async (p, b) => { puts.push([p, b]); items[p.split('/').pop()] = {...items[p.split('/').pop()], status: b.status}; return {}; }};
}
const fichas = n => Array.from({length: n}, (_, i) => ({n: i + 1, titulo: `L${i + 1}`, producto: `MLU${100 + i}`, mi_mlu: i === 0 ? 'MLU900' : null}));

test('pausa la publicación mía solo si Hermes dejó de ofrecer y es de Amado Libros', async () => {
  const f = fichas(25);
  const ml = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 2341378249, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: true, ml, pausaMs: 0});
  assert.equal(r.pausadas.length, 1);
  assert.deepEqual(ml.puts, [['/items/MLU900', {status: 'paused'}]]);
  assert.match(r.resumen, /1 sin oferta/);
});

test('sin --real no pausa y no toca publicaciones de otra cuenta', async () => {
  const f = fichas(25);
  const ml = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 2341378249, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: false, ml, pausaMs: 0});
  assert.equal(ml.puts.length, 0);
  assert.equal(r.pausadas[0].resultado, 'se_pausaria');
  const ml2 = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 123, status: 'active'}}});
  const r2 = await correr({fichas: f, historial: [], real: true, ml: ml2, pausaMs: 0});
  assert.equal(ml2.puts.length, 0);
  assert.equal(r2.pausadas[0].resultado, 'no_es_de_vintage_no_se_toca');
});

test('si casi todas desaparecen de golpe no pausa nada', async () => {
  const f = fichas(30);
  const ml = mlFalso({ofrecen: [], items: {MLU900: {seller_id: 2341378249, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: true, ml, pausaMs: 0});
  assert.equal(r.falla, true);
  assert.equal(ml.puts.length, 0);
});

test('detecta cambio de precio contra el historial', async () => {
  const f = fichas(1).map(x => ({...x, mi_mlu: null}));
  const ml = mlFalso({ofrecen: [f[0].producto]});
  const r = await correr({fichas: f, historial: [{fecha: '2026-11-17', producto: f[0].producto, precio: 800}], real: false, ml, pausaMs: 0});
  assert.equal(r.cambios.length, 1);
  assert.match(r.resumen, /de \$800 a \$1000/);
});

import {precioMio, precioDesdeLista, armarPayload, cupoParaOtros, SBS_RESERVA_DIARIA, TOPE_DIARIO_COMPARTIDO} from '../../hermes-monitor/lib.mjs';
test('precioMio es 1 % menos que Hermes, en pesos enteros', () => {
  assert.equal(precioMio(1810), 1792);
  assert.equal(precioMio(1000), 990);
});
test('armarPayload: catálogo directo, 1 unidad, UYU, nuevo, sin tocar nada más', () => {
  const p = armarPayload({producto: 'MLU1', precio: 990, categoria: 'MLU1196', nombre: 'Libro', familyName: 'Fam', usaFamilyName: false, isbn: '978'});
  assert.equal(p.available_quantity, 1);
  assert.equal(p.catalog_listing, true);
  assert.equal(p.catalog_product_id, 'MLU1');
  assert.equal(p.currency_id, 'UYU');
  assert.equal(p.title, 'Libro');
  assert.equal(armarPayload({producto: 'MLU1', precio: 1, categoria: 'x', nombre: 'a', familyName: 'Fam', usaFamilyName: true}).family_name, 'Fam');
});

import {CUENTA_HERMES, inicioDiaUy} from '../../hermes-monitor/lib.mjs';
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
test('Hermes va siempre a Amado Vintage y nunca a Amado Libros', () => {
  assert.equal(CUENTA_HERMES, 'vintage');
  assert.equal(CUENTAS[CUENTA_HERMES].sellerId, '2341378249');
});
test('inicioDiaUy cae a las 00:00 de Montevideo (03:00 UTC)', () => {
  const i = inicioDiaUy(Date.UTC(2026, 10, 18, 13, 0));
  assert.equal(new Date(i).toISOString(), '2026-11-18T03:00:00.000Z');
});

test('armarPayload con plazo declara disponibilidad a demanda y una sola unidad', () => {
  const p = armarPayload({producto: 'MLU1', precio: 2040, categoria: 'MLU1196', nombre: 'Libro', familyName: 'Fam', usaFamilyName: false, isbn: '978', plazoDias: 20});
  assert.deepEqual(p.sale_terms, [{id: 'MANUFACTURING_TIME', value_name: '20 días'}]);
  assert.equal(p.available_quantity, 1);
  assert.equal(armarPayload({producto: 'MLU1', precio: 1, categoria: 'x', nombre: 'a', familyName: 'f', usaFamilyName: false}).sale_terms, undefined);
});
test('la lista de Arnoia: 395 libros, EAN únicos y precios sobre el mínimo de Vintage', async () => {
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-semana-45.json', 'utf8'));
  assert.equal(d.libros.length, 395);
  assert.equal(new Set(d.libros.map(l => l.ean)).size, 395);
  assert.ok(d.libros.every(l => /^\d{13}$/.test(l.ean) && l.precio >= 1200));
  assert.equal(d.plazo_dias, 20);
});

import {armarPayloadTradicional, paqueteDeVendedor, normalizarTitulo, normalizarAutor} from '../../hermes-monitor/lib.mjs';
test('publicación normal de Arnoia: sin catálogo, con portada, medidas del paquete y plazo', () => {
  const p = armarPayloadTradicional({ean: '9788408328834', titulo: 'HORA ANTES DEL ALBA, LA (PREMIO PLANETA 2026)', autor: 'ALLENDE, ISABEL', editorial: 'PLANETA', precio: 2630, plazoDias: 20, usaFamilyName: false, imagenes: ['https://x/y.jpg'], pesoGramos: 500});
  assert.equal(p.catalog_listing, false);
  assert.equal(p.catalog_product_id, undefined);
  assert.equal(p.title, 'La Hora Antes Del Alba - Isabel Allende');
  assert.equal(p.available_quantity, 1);
  assert.deepEqual(p.pictures, [{source: 'https://x/y.jpg'}]);
  assert.deepEqual(p.sale_terms, [{id: 'MANUFACTURING_TIME', value_name: '20 días'}]);
  assert.ok(['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_WEIGHT'].every(id => p.attributes.some(a => a.id === id)));
  assert.equal(paqueteDeVendedor(500).find(a => a.id === 'SELLER_PACKAGE_WEIGHT').value_name, '800 g');
  assert.equal(normalizarAutor('ALLENDE, ISABEL'), 'Isabel Allende');
  assert.equal(normalizarTitulo('MURDOKU: 80 ACERTIJOS'), 'Murdoku: 80 Acertijos');
});

test('la lista nueva de Arnoia (19/11): libros disponibles, sin riesgo de propiedad intelectual, sobre el mínimo, con ranking primero', async () => {
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8'));
  assert.ok(d.libros.length > 4000);
  assert.equal(new Set(d.libros.map(l => l.ean)).size, d.libros.length);
  assert.ok(d.libros.every(l => /^\d{13}$/.test(l.ean) && l.precio >= 1200 && l.peso_g > 0));
  assert.ok(d.libros[0].unidades >= d.libros[100].unidades);
  assert.equal(d.plazo_dias, 20);
});

test('la lista de Arnoia solo trae libros disponibles', async () => {
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8'));
  assert.match(d.nota, /Disponible/);
});

test('los 15 libros aprobados por Seba solo se eximen del grupo copia', async () => {
  const fs = await import('node:fs');
  const {ipRisk} = await import('../../worker-sync/ip-risk.js');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8'));
  const ap = d.libros.filter(l => l.aprobado_por_seba);
  assert.equal(ap.length, 15);
  for (const l of ap) assert.equal(ipRisk(`${l.titulo} ${l.autor ?? ''}`, l.editorial), 'copia', l.titulo);
  assert.match(fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8'), /riesgo && !\(ctx\.aprobado && riesgo === 'copia'\)/);
});

import {textoNoPermitido} from '../../hermes-monitor/lib.mjs';
test('control de tapas: frena direcciones web, @, redes, teléfonos y etiquetas de Mercado Libre; deja pasar una tapa común', () => {
  assert.equal(textoNoPermitido('SACAPUNTAS DINOSAURIOS WWW. EDITORIALGUADAL.COM.AR Guadal'), 'direccion_web');
  assert.equal(textoNoPermitido('@Lusatnam Lourdes Muñoz Guía completa de MUDRAS'), 'arroba_o_correo');
  assert.equal(textoNoPermitido('Seguinos en Instagram'), 'red_social');
  assert.equal(textoNoPermitido('Llamanos al 099 841 325'), 'telefono');
  assert.equal(textoNoPermitido('ENVÍO GRATIS en Mercado Libre'), 'etiqueta_mercado_libre');
  assert.equal(textoNoPermitido('ISBN 978-84-08-32883-4 La hora antes del alba PREMIO PLANETA 2026'), null);
  assert.equal(textoNoPermitido('Isabel Allende La hora antes del alba'), null);
  assert.equal(textoNoPermitido(''), null);
});
test('la serie Arcolores queda vetada para publicación normal', async () => {
  const fs = await import('node:fs');
  const v = JSON.parse(fs.readFileSync('hermes-monitor/data/portadas-vetadas.json', 'utf8'));
  assert.ok(v.titulo_regex.some(r => new RegExp(r, 'i').test('Dinosaurios ("Arcolores")')));
});

test('el publicador tiene topes: libros revisados por tanda y tiempo', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /examinadas >= MAX_EXAMINADAS/);
  assert.match(src, /Date\.now\(\) - INICIO > MAX_MS/);
  assert.match(fs.readFileSync('.github/workflows/hermes-publicar.yml', 'utf8'), /timeout-minutes: 55/);
});

test('los libros sin portada se anotan y se reintentan a la semana', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /marcar: \{sin_portada: true, v: VERSION_REGLA_PORTADA\}/);
  assert.match(src, /previo\?\.sin_portada && previo\.v === VERSION_REGLA_PORTADA && Date\.now\(\) - Date\.parse\(previo\.fecha \?\? 0\) < 7 \* 86400e3/);
});

test('control de tapas: también frena domicilios y datos fiscales; el payload acepta una foto por id', () => {
  assert.equal(textoNoPermitido('Domicilio del importador: Humboldt 1550 CUIT 33-70816221-9'), 'domicilio_o_datos_fiscales');
  const p = armarPayloadTradicional({ean: '9791388139604', titulo: 'Guia completa de mudras', autor: 'Muñoz, David', editorial: 'ROCA EDITORIAL', precio: 2550, plazoDias: 20, usaFamilyName: false, imagenes: [{id: '123456-MLU999'}], pesoGramos: 450});
  assert.deepEqual(p.pictures, [{id: '123456-MLU999'}]);
  const q = armarPayloadTradicional({ean: '1', titulo: 'x', precio: 1, usaFamilyName: false, imagenes: ['https://x/y.jpg']});
  assert.deepEqual(q.pictures, [{source: 'https://x/y.jpg'}]);
});

test('control de tapas: una @ suelta del dibujo no cuenta; un usuario o un correo sí', () => {
  assert.equal(textoNoPermitido('@ (@ @ue Ñ @ \\ > @)'), null);
  assert.equal(textoNoPermitido('@javihoy'), 'arroba_o_correo');
  assert.equal(textoNoPermitido('Seguime en @paufeel'), 'arroba_o_correo');
  assert.equal(textoNoPermitido('@Lusatnam Lourdes Muñoz'), 'arroba_o_correo');
  assert.equal(textoNoPermitido('escribí a hola@editorial.com'), 'arroba_o_correo');
  assert.equal(textoNoPermitido('1+1.700.0001'), null);
  assert.equal(textoNoPermitido('Llamanos al 099 841 325'), 'telefono');
});

test('Hermes sale con plazo a demanda de 18 días, igual que SBS', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /const PLAZO_HERMES_DIAS = 18;/);
  assert.match(src, /const PLAZO_DIAS = PLAZO_HERMES_DIAS;/); // 22/11/2026: todas las fuentes a 18 días
  const p = armarPayload({producto: 'MLU1', precio: 100, categoria: 'MLU1196', nombre: 'x', familyName: 'x', usaFamilyName: false, plazoDias: 18});
  assert.deepEqual(p.sale_terms, [{id: 'MANUFACTURING_TIME', value_name: '18 días'}]);
});

test('precioDesdeLista: 3 % menos que el precio de lista de GLIC (antes del descuento), o del precio si no hay lista', () => {
  assert.equal(precioDesdeLista({price: 1520, original_price: 2000}), 1940);
  assert.equal(precioDesdeLista({price: 2000, original_price: null}), 1940);
  assert.equal(precioDesdeLista({price: 2000, original_price: 1500}), 1940);
  assert.equal(precioDesdeLista({}), null);
});

test('una marca vieja (sin_catalogo) no impide anotar sin_portada, y los ya anotados se saltan sin consultar (21/11/2026: 139 libros se revisaban en cada tanda)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /ctx\.marcar && real && !publicadas\[ctx\.clave\]\?\.item_id/);
  assert.match(src, /\(tradicional \|\| ambos\) && previo\?\.sin_portada && previo\.v === VERSION_REGLA_PORTADA && Date\.now\(\)/);
  assert.ok(src.indexOf("(tradicional || ambos) && previo?.sin_portada") < src.indexOf("/products/search?"), 'el salto va antes de la búsqueda en Mercado Libre');
});

test('tapas chicas reales: el piso de peso es de 8 KB, el lector exige 200 px y la tapa se agranda; las marcas viejas de sin_portada se vuelven a probar', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /MIN_BYTES_PORTADA = 8000/);
  assert.match(src, /800\/m/);
  assert.match(src, /previo\.v === VERSION_REGLA_PORTADA/);
  assert.match(src, /marcar: \{sin_portada: true, v: VERSION_REGLA_PORTADA\}/);
  assert.match(fs.readFileSync('hermes-monitor/limpiar_tapa.py', 'utf8'), /tapa_chica/);
});

test('lo saltado por propiedad intelectual, fuente que no ofrece o precio bajo el mínimo se anota y no se vuelve a revisar en cada tanda; la arroba en los datos ni se anota ni gasta cupo (22/11/2026)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /omitido: 'riesgo_pi_' \+ riesgo/);
  assert.match(src, /reintentar_desde: diasDesdeHoy\(3\)/);
  assert.match(src, /if \(conArroba\(f\)\) return \{omitir: true\};/);
  assert.ok(!/saltar: 'arroba_en_datos'/.test(src), 'la arroba no se registra como salto');
  assert.match(src, /anotadoVigente\(publicadas\[f\.producto\]\)/);
});

test('SBS tiene prioridad: su reserva diaria no se la quitan Arnoia ni GLIC (22/11/2026)', () => {
  assert.equal(SBS_RESERVA_DIARIA, 2000);
  // con SBS en 626 se le sigue guardando su reserva de 2.000: los demás tienen 4.000 - 2.000 - lo ya publicado
  assert.equal(cupoParaOtros(626, 0), TOPE_DIARIO_COMPARTIDO - 2000);
  assert.equal(cupoParaOtros(626, 1500), 500);
  assert.equal(cupoParaOtros(626, 2000), 0);
  // si SBS ya pasó su reserva, cuenta lo real
  assert.equal(cupoParaOtros(2300, 500), TOPE_DIARIO_COMPARTIDO - 2300 - 500);
  assert.equal(cupoParaOtros(0, 9999), 0);
});

test('Celesa: precio estimado con 15 % de descuento, flete de USD 15 por kilo y ganancia de 25 % con piso de $500; sin duplicar ISBN con Arnoia (22/11/2026)', async () => {
  const {precioCelesa, CELESA, pesoEstimadoCelesa} = await import('../../hermes-monitor/lib.mjs');
  assert.equal(CELESA.descuento, 0.15); assert.equal(CELESA.ganancia, 0.25); assert.equal(CELESA.fleteUsdKg, 15);
  // 17,79 EUR, 450 g: libro 710,6; flete (550 g) 344,8; envío 230; ganancia mín. 500 => (710,6+344,8+230+500)/0,83 = 2.151 => 2.150
  assert.equal(precioCelesa(17.79, 450), 2150);
  assert.ok(precioCelesa(8.17, 300) >= 1200, 'respeta el mínimo de $1.200');
  assert.ok(precioCelesa(60, 900) > precioCelesa(20, 650));
  assert.equal(pesoEstimadoCelesa(10), 300); assert.equal(pesoEstimadoCelesa(35), 900);
  const fs = await import('node:fs');
  const d = JSON.parse(fs.readFileSync('hermes-monitor/data/celesa-catalogo-22-11.json', 'utf8'));
  const arnoia = JSON.parse(fs.readFileSync('hermes-monitor/data/arnoia-catalogo-19-11.json', 'utf8')).libros;
  const eans = new Set(arnoia.map(l => l.ean));
  assert.ok(d.libros.length > 3000 && d.libros.every(l => !eans.has(l.ean) && !/@/.test(l.titulo + l.autor + l.editorial) && l.url_portada && l.precio >= 1200));
  const src = fs.readFileSync('hermes-monitor/publicar.mjs', 'utf8');
  assert.match(src, /publicadas\[id\]\?\.item_id\) return \{omitir: true\}/);
  assert.match(src, /fuente: celesa \? 'celesa'/);
});
