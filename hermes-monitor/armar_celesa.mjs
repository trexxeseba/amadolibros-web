// Arma el catálogo de Celesa para publicar (mismo formato que el de Arnoia) desde el archivo que baja el portal.
//   node hermes-monitor/armar_celesa.mjs <celesa.csv> <salida.json>
// Filtros: sin arroba, sin riesgo de propiedad intelectual (mismo filtro que el publicador), con autor, con tapa, precio de 8 a 60 euros y 2 o más unidades.
// Precio: precioCelesa (descuento estimado de 15 %, ganancia de 25 % con piso de $500). Los EAN que ya están en Arnoia no se repiten.
import fs from 'node:fs';
import {ipRisk} from '../worker-sync/ip-risk.js';
import {precioCelesa, pesoEstimadoCelesa} from './lib.mjs';
const [, , csvPath, salida] = process.argv;
const texto = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const [cab, ...lineas] = texto.split(/\r?\n/).filter(Boolean);
const cols = cab.split(';');
const arnoia = JSON.parse(fs.readFileSync(new URL('./data/arnoia-catalogo-19-11.json', import.meta.url), 'utf8')).libros;
const deArnoia = new Set(arnoia.map(l => l.ean));
const cuenta = {archivo: lineas.length};
const libros = [];
for (const l of lineas) {
  const v = l.split(';'); const r = Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? '').trim()]));
  const eur = Number(r.precio.replace(',', '.'));
  if (!/^\d{13}$/.test(r.ean) || deArnoia.has(r.ean)) { cuenta.ya_en_arnoia = (cuenta.ya_en_arnoia || 0) + 1; continue; }
  if (/@/.test([r.titulo, r.autor, r.editorial].join(' '))) { cuenta.arroba = (cuenta.arroba || 0) + 1; continue; }
  if (ipRisk(r.titulo + ' ' + r.autor, r.editorial)) { cuenta.riesgo_pi = (cuenta.riesgo_pi || 0) + 1; continue; }
  if (!r.autor) { cuenta.sin_autor = (cuenta.sin_autor || 0) + 1; continue; }
  if (!r.url_imagen_tapa) { cuenta.sin_tapa = (cuenta.sin_tapa || 0) + 1; continue; }
  if (!(eur >= 8 && eur <= 60)) { cuenta.precio_fuera = (cuenta.precio_fuera || 0) + 1; continue; }
  if (r.unidades === '1' || !r.unidades) { cuenta.poco_stock = (cuenta.poco_stock || 0) + 1; continue; }
  const peso_g = pesoEstimadoCelesa(eur);
  libros.push({ean: r.ean, titulo: r.titulo, autor: r.autor, editorial: r.editorial, precio: precioCelesa(eur, peso_g), peso_g, unidades: r.unidades === '50+' ? 50 : Number(r.unidades), fecha: r.fecha, precio_eur: eur, url_portada: r.url_imagen_tapa});
}
// Más caros primero (más ganancia en pesos por publicación)
libros.sort((a, b) => b.precio - a.precio);
fs.writeFileSync(salida, JSON.stringify({origen: 'Celesa, novedades de 3 meses (archivo del 22/11/2026)', cotizacion: 'BROU venta 18/11/2026: euro 46,99 y dólar 41,80', plazo_dias: 20, nota: 'Costo estimado: precio en euros menos 15 %, ganancia 25 % con piso de $500, peso estimado por precio. Cambiar cuando se tenga el costo real de Celesa.', libros}));
console.log(JSON.stringify({...cuenta, para_publicar: libros.length}));
