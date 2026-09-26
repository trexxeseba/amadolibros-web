// scripts/ux/cover-shape-audit.mjs
//
// Mide la primera imagen de cada publicación (activas y por encargo) para
// detectar las que no son una tapa: las tapas son verticales; los banners
// promocionales, collages y fotos de estuches suelen ser horizontales.
// Solo lectura: baja el catálogo público de R2 y las imágenes de mlstatic.
//
// Salidas:
//   artifacts/covers/horizontales.csv  → lista para revisar en Mercado Libre
//   artifacts/covers/resumen.json
//   astro-front/public/data/cover-flags.json → { landscape: [MLU…] } que usa
//     el catálogo para no mostrar esas publicaciones primero.
//
// Uso: node scripts/ux/cover-shape-audit.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fetchAndConsolidate } from '../categorize/fetch-catalog.js';

const LANDSCAPE_RATIO = 1.15; // ancho / alto por encima del cual no parece una tapa
const CONCURRENCY = 24;

export function imageSize(buf) {
  const b = new Uint8Array(buf);
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const v = new DataView(b.buffer, b.byteOffset);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  // JPEG: buscar un marcador SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) + b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: (b[i + 5] << 8) + b[i + 6], w: (b[i + 7] << 8) + b[i + 8] };
      }
      i += 2 + len;
    }
    return null;
  }
  // WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (chunk === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function firstImage(item) {
  const pic = Array.isArray(item.pictures) && item.pictures[0];
  const url = (pic && (pic.secure_url || pic.url)) || item.thumbnail || item.image || '';
  return String(url).replace(/^http:/, 'https:');
}

async function measure(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'AmadoLibros cover audit' } });
    if (!res.ok) return null;
    return imageSize(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function main() {
  const snapshot = await fetchAndConsolidate();
  const items = snapshot.items.filter(item => firstImage(item));
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      const url = firstImage(item);
      const size = await measure(url);
      results.push({ item, url, size });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const landscape = results
    .filter(r => r.size && r.size.w / r.size.h > LANDSCAPE_RATIO)
    .sort((a, b) => a.item.id.localeCompare(b.item.id));
  const clean = v => String(v || '').replace(/[\t\r\n",]+/g, ' ').trim();
  mkdirSync('artifacts/covers', { recursive: true });
  const csv = ['mlu,estado,proporcion,titulo,imagen,mercadolibre',
    ...landscape.map(r => [r.item.id, r.item.status === 'paused' ? 'encargo' : 'disponible',
      (r.size.w / r.size.h).toFixed(2), clean(r.item.title), r.url, clean(r.item.permalink)].join(','))];
  writeFileSync('artifacts/covers/horizontales.csv', `${csv.join('\n')}\n`);
  const summary = {
    generado: new Date().toISOString(),
    medidas: results.filter(r => r.size).length,
    sin_medida: results.filter(r => !r.size).length,
    horizontales: landscape.length,
    horizontales_disponibles: landscape.filter(r => r.item.status !== 'paused').length,
    umbral_ancho_sobre_alto: LANDSCAPE_RATIO,
  };
  writeFileSync('artifacts/covers/resumen.json', `${JSON.stringify(summary, null, 2)}\n`);
  mkdirSync(path.join('astro-front', 'public', 'data'), { recursive: true });
  writeFileSync(path.join('astro-front', 'public', 'data', 'cover-flags.json'),
    JSON.stringify({ generated_at: summary.generado, landscape: landscape.map(r => r.item.id) }));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error); process.exit(1); });
}
