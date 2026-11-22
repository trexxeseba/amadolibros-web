// Arma el catálogo ampliado de Arnoia (export del 22/11/2026) con los libros que NO están en la lista de 4.709.
//   node hermes-monitor/armar_arnoia_nuevo.mjs <arnoia.csv> <salida.json>
// Filtros: sin arroba, sin riesgo de PI, con autor, con tapa, 8 a 60 euros. Tapa: carpeta imagenes_medium (la small es muy chica).
// Precio: ajuste lineal sobre los precios con costo real de la lista anterior (euro, peso estimado por franja de precio).
import fs from 'node:fs';
import {ipRisk} from '../worker-sync/ip-risk.js';
const [, , csvPath, salida] = process.argv;
const texto = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const [cab, ...lineas] = texto.split(/\r?\n/).filter(Boolean);
const cols = cab.split(';');
const previos = new Set(JSON.parse(fs.readFileSync(new URL('./data/arnoia-catalogo-19-11.json', import.meta.url), 'utf8')).libros.map(l => l.ean));
const pesoPorPrecio = eur => eur < 12 ? 316 : eur < 20 ? 364 : eur < 30 ? 517 : 815;
const precioArnoia = eur => Math.max(1200, Math.round((59.6 * eur + 0.8517 * pesoPorPrecio(eur) + 669.6) / 10) * 10);
const cuenta = {archivo: lineas.length};
const libros = [];
for (const l of lineas) {
  const v = l.split(';'); const r = Object.fromEntries(cols.map((c, i) => [c, (v[i] ?? '').trim()]));
  const eur = Number(r.precio.replace(',', '.'));
  if (!/^\d{13}$/.test(r.ean) || !(eur >= 8 && eur <= 60) || v.length !== cols.length) { cuenta.fila_rota = (cuenta.fila_rota || 0) + 1; continue; }
  if (previos.has(r.ean)) { cuenta.ya_en_lista = (cuenta.ya_en_lista || 0) + 1; continue; }
  if (/@/.test([r.titulo, r.autor, r.editorial].join(' '))) { cuenta.arroba = (cuenta.arroba || 0) + 1; continue; }
  if (ipRisk(r.titulo + ' ' + r.autor, r.editorial)) { cuenta.riesgo_pi = (cuenta.riesgo_pi || 0) + 1; continue; }
  if (!r.autor) { cuenta.sin_autor = (cuenta.sin_autor || 0) + 1; continue; }
  if (!r.url_imagen_tapa) { cuenta.sin_tapa = (cuenta.sin_tapa || 0) + 1; continue; }
  libros.push({ean: r.ean, titulo: r.titulo, autor: r.autor, editorial: r.editorial, precio: precioArnoia(eur), peso_g: pesoPorPrecio(eur), fecha: r.fecha, precio_eur: eur, url_portada: r.url_imagen_tapa.replace('/imagenes_small/', '/imagenes_medium/')});
}
libros.sort((a, b) => b.precio - a.precio);
fs.writeFileSync(salida, JSON.stringify({origen: 'Arnoia, export castellano disponible 8-60 EUR (22/11/2026)', cotizacion: 'BROU venta 18/11/2026: euro 46,99 y dólar 41,80', plazo_dias: 20, nota: 'Precio por ajuste sobre los costos reales de la lista de 4.709 (error mediano $45); peso estimado por franja.', libros}));
console.log(JSON.stringify({...cuenta, para_publicar: libros.length}));
