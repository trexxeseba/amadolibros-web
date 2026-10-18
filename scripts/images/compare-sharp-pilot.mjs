import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVariant } from './build-permanent-variants.mjs';
import { CF_CARD_VARIANTS } from '../../shared/image-variants.js';
import { pilotClient } from './pilot-client.mjs';

// Comparación de calidad Sharp (v1, la receta que ya se sirve) frente a Cloudflare (v2) a
// partir de los MISMOS bytes del master. No decide nada: produce métricas y hojas de
// contacto para la revisión visual de Seba, y marca (sin bloquear) lo que merece mirarse.
// Que q85 de Sharp y q85 de Cloudflare produzcan la misma calidad NO se asume.
export const REVIEW_THRESHOLDS = Object.freeze({ psnrDropDb: 1.5, bytesRatio: 1.5, ssimDrop: 0.03 });

async function rgb(sharp, input) {
  const { data, info } = await sharp(input).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export function psnr(a, b) {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) { const d = a.data[i] - b.data[i]; sum += d * d; }
  const mse = sum / a.data.length;
  return mse === 0 ? 100 : 10 * Math.log10(255 * 255 / mse);
}

// SSIM medio por bloques 8×8 sobre luminancia (sin ventana gaussiana: aproximación
// suficiente para comparar dos codificadores entre sí con la misma métrica).
export function ssim(a, b) {
  const luma = img => { const out = new Float64Array(img.width * img.height);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * img.data[i * 3] + 0.587 * img.data[i * 3 + 1] + 0.114 * img.data[i * 3 + 2]; return out; };
  const x = luma(a), y = luma(b), c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let total = 0, blocks = 0;
  for (let by = 0; by + 8 <= a.height; by += 8) for (let bx = 0; bx + 8 <= a.width; bx += 8) {
    let mx = 0, my = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (by + j) * a.width + bx + i; mx += x[k]; my += y[k]; }
    mx /= 64; my /= 64;
    let vx = 0, vy = 0, cov = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (by + j) * a.width + bx + i; vx += (x[k] - mx) ** 2; vy += (y[k] - my) ** 2; cov += (x[k] - mx) * (y[k] - my); }
    vx /= 63; vy /= 63; cov /= 63;
    total += ((2 * mx * my + c1) * (2 * cov + c2)) / ((mx * mx + my * my + c1) * (vx + vy + c2)); blocks++;
  }
  return blocks ? total / blocks : 1;
}

export async function compareRecipe({ sharp, masterBytes, cloudflareBytes, width }) {
  const sharpBytes = await createVariant(masterBytes, { width, quality: 85 }, sharp);
  const [ref, v1, v2] = await Promise.all([
    rgb(sharp, await sharp(masterBytes).resize({ width, withoutEnlargement: true, kernel: 'lanczos3' }).png().toBuffer()),
    rgb(sharp, sharpBytes), rgb(sharp, cloudflareBytes)]);
  const dimsEqual = ref.width === v1.width && v1.width === v2.width && Math.abs(ref.height - v2.height) <= 1 && Math.abs(ref.height - v1.height) <= 1;
  const result = { width: v2.width, height: v2.height, sharp_bytes: sharpBytes.length, cloudflare_bytes: cloudflareBytes.length,
    bytes_ratio: Number((cloudflareBytes.length / sharpBytes.length).toFixed(3)), dims_equal: dimsEqual, review: [] };
  if (!dimsEqual) { result.review.push('dimensions-differ'); return { result, sharpBytes, cloudflareBytes }; }
  const h = Math.min(ref.height, v1.height, v2.height); // ±1 px de alto es válido: se compara el área común
  const cut = img => ({ width: img.width, height: h, data: img.data.subarray(0, img.width * h * 3) });
  const [R, A, B] = [cut(ref), cut(v1), cut(v2)];
  result.psnr_sharp = Number(psnr(R, A).toFixed(2));
  result.psnr_cloudflare = Number(psnr(R, B).toFixed(2));
  result.ssim_sharp = Number(ssim(R, A).toFixed(4));
  result.ssim_cloudflare = Number(ssim(R, B).toFixed(4));
  if (result.psnr_sharp - result.psnr_cloudflare > REVIEW_THRESHOLDS.psnrDropDb) result.review.push('cloudflare-psnr-lower');
  if (result.ssim_sharp - result.ssim_cloudflare > REVIEW_THRESHOLDS.ssimDrop) result.review.push('cloudflare-ssim-lower');
  if (result.bytes_ratio > REVIEW_THRESHOLDS.bytesRatio) result.review.push('cloudflare-heavier');
  return { result, sharpBytes, cloudflareBytes };
}

// Hoja de contacto: referencia | Sharp v1 | Cloudflare v2, con etiquetas.
export async function contactSheet({ sharp, masterBytes, sharpBytes, cloudflareBytes, width, label }) {
  const panels = [['referencia', await sharp(masterBytes).resize({ width, withoutEnlargement: true, kernel: 'lanczos3' }).png().toBuffer()],
    ['Sharp v1', sharpBytes], ['Cloudflare v2', cloudflareBytes]];
  const decoded = await Promise.all(panels.map(async ([, bytes]) => ({ bytes: await sharp(bytes).png().toBuffer(), meta: await sharp(bytes).metadata() })));
  const w = Math.max(...decoded.map(d => d.meta.width)), h = Math.max(...decoded.map(d => d.meta.height)), gap = 12, head = 28;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w * 3 + gap * 4}" height="${head}"><style>text{font:14px sans-serif;fill:#111}</style>` +
    panels.map(([name], i) => `<text x="${gap + i * (w + gap)}" y="19">${name}${i === 0 ? ` — ${label}` : ''}</text>`).join('') + '</svg>');
  return sharp({ create: { width: w * 3 + gap * 4, height: h + head + gap, channels: 3, background: '#ffffff' } })
    .composite([{ input: svg, left: 0, top: 0 }, ...decoded.map((d, i) => ({ input: d.bytes, left: gap + i * (w + gap), top: head }))]).png().toBuffer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [selectionPath, outDir] = process.argv.slice(2);
  if (!outDir) throw new Error('usage: compare-sharp-pilot selection.json out-dir');
  const { default: sharp } = await import('sharp');
  const selection = JSON.parse(await readFile(selectionPath, 'utf8'));
  const call = pilotClient({ baseUrl: process.env.PILOT_URL, token: process.env.PILOT_TOKEN });
  await mkdir(outDir, { recursive: true });
  const rows = [];
  for (const item of selection.pilot.items) {
    const hash = item.file.slice(0, 64);
    const master = await call(`/master/${item.file}`);
    if (!master.ok) { rows.push({ file: item.file, error: `master-http-${master.status}` }); continue; }
    for (const recipe of CF_CARD_VARIANTS) {
      const object = await call(`/object/${hash}/${recipe.id}`);
      if (!object.ok) { rows.push({ file: item.file, recipe: recipe.id, error: `object-http-${object.status}` }); continue; }
      const { result, sharpBytes, cloudflareBytes } = await compareRecipe({ sharp, masterBytes: Buffer.from(master.bytes), cloudflareBytes: Buffer.from(object.bytes), width: recipe.width });
      rows.push({ file: item.file, recipe: recipe.id, master_width: item.width, master_height: item.height, ...result });
      const sheet = await contactSheet({ sharp, masterBytes: Buffer.from(master.bytes), sharpBytes, cloudflareBytes, width: recipe.width, label: `${hash.slice(0, 8)} ${recipe.width}px` });
      await writeFile(join(outDir, `sheet-${hash.slice(0, 12)}-${recipe.width}.png`), sheet);
    }
  }
  const compared = rows.filter(r => !r.error);
  const summary = { rows: rows.length, compared: compared.length, errors: rows.filter(r => r.error).length,
    flagged_for_review: compared.filter(r => r.review.length).length,
    mean_bytes_ratio: compared.length ? Number((compared.reduce((s, r) => s + r.bytes_ratio, 0) / compared.length).toFixed(3)) : null,
    thresholds: REVIEW_THRESHOLDS, note: 'Métricas de apoyo, no una decisión: la calidad visual la aprueba Seba sobre las hojas de contacto.' };
  await writeFile(join(outDir, 'comparison.json'), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary));
  if (summary.errors) process.exitCode = 1;
}
