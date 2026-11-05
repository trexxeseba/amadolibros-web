#!/usr/bin/env node

// Promociones de Amado Libros por API: auditar, aplicar el tope y sumar a la oferta
// relámpago. Habla con el Worker (/meli-promos, detrás de SYNC_SECRET), que es quien
// tiene el token de Mercado Libre. Por defecto NO escribe nada (dry-run): solo manda
// escrituras con --confirm true y solo en aplicar_tope y relampago.
//
//   SYNC_SECRET=... node scripts/mercadolibre/promos.mjs --accion auditar --max 16 --out resultado.json
//   ... --accion aplicar_tope --max 16 [--confirm true]
//   ... --accion relampago --titulos "MLU1 MLU2" [--confirm true]
//
// Reglas (ver promos-policy.mjs): tope 16 %, excepción del 29 al 31/10, nunca subir
// precios, solo "salir de la promo", nada de cupones, publicidad ni Amado Liquidacion.

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_MAX_PCT, EXCEPTION, discountPct, uyDate, inExceptionWindow, isActiveStatus, isBlockedType,
  couponAmountUyu, planRemovals, planLightning,
} from './promos-policy.mjs';

const ORIGIN = 'https://amadolibros-sync.undiaes.workers.dev';
const ACTIONS = ['auditar', 'aplicar_tope', 'relampago'];
const READ_CHUNK = 10, WRITE_CHUNK = 10, MAX_PAGES = 200;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export function parseTitulos(text) {
  const out = [], seen = new Set();
  for (const raw of String(text ?? '').split(/[\s,;]+/).filter(Boolean)) {
    const id = raw.toUpperCase();
    if (!/^MLU\d+$/.test(id)) throw new Error(`Título no válido: ${raw} (se espera MLU seguido de números)`);
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export function parseArgs(argv) {
  const args = { accion: null, maxPct: DEFAULT_MAX_PCT, confirm: false, titulos: [], out: 'meli-promos.json' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--accion') args.accion = value;
    else if (flag === '--max') args.maxPct = Number(value);
    else if (flag === '--confirm') args.confirm = String(value).toLowerCase() === 'true';
    else if (flag === '--titulos') args.titulos = parseTitulos(value);
    else if (flag === '--out') args.out = value;
    else throw new Error(`Opción desconocida: ${flag}`);
  }
  if (!ACTIONS.includes(args.accion)) throw new Error(`Acción no válida: ${args.accion}. Usá ${ACTIONS.join(', ')}.`);
  if (!Number.isFinite(args.maxPct) || args.maxPct <= 0 || args.maxPct > 100) throw new Error('El máximo (--max) debe ser un número entre 1 y 100.');
  return args;
}

export function createClient({ secret, fetcher = fetch, origin = ORIGIN, wait = sleep } = {}) {
  if (!secret) throw new Error('SYNC_SECRET no está configurado');
  return {
    async call(action, payload = {}) {
      const write = action === 'remove' || action === 'join_lightning';
      const attempts = write ? 1 : 3;
      for (let attempt = 1; ; attempt += 1) {
        let response, body = null;
        try {
          response = await fetcher(new URL('/meli-promos', origin), {
            method: 'POST', redirect: 'manual',
            headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...payload }),
          });
          body = await response.json().catch(() => null);
        } catch (error) {
          if (attempt < attempts) { await wait(1500 * attempt); continue; }
          throw new Error(`No se pudo conectar con el Worker (${action}).`);
        }
        if (response.ok) return body;
        if (response.status === 404 && !body?.seller_id) throw new Error('La ruta /meli-promos no existe en el Worker: falta desplegar el Worker (deploy-worker-sync) con este cambio.');
        if (response.status === 401) throw new Error('El Worker rechazó SYNC_SECRET (401).');
        if ((response.status === 429 || response.status >= 500) && attempt < attempts) { await wait(1500 * attempt); continue; }
        throw new Error(`El Worker respondió HTTP ${response.status} en ${action}: ${body?.error ?? 'sin detalle'}`);
      }
    },
  };
}

async function collectEntries(client, promotions) {
  const active = promotions.filter(p => isActiveStatus(p.status));
  const included = active.filter(p => !isBlockedType(p.type));
  const excluded = active.filter(p => isBlockedType(p.type));
  const entries = [];
  for (const promo of included) {
    const seen = new Set();
    for (const status of ['started', 'pending']) {
      let after = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = await client.call('promo_items', { promotion_id: promo.id, promotion_type: promo.type, status, ...(after ? { search_after: after } : {}) });
        if (!body.ok) throw new Error(`Mercado Libre respondió ${body.ml_status} al leer los ítems de la promoción ${promo.id}.`);
        for (const row of body.items ?? []) {
          if (!isActiveStatus(row.status) || seen.has(`${row.id}|${row.status}`)) continue;
          seen.add(`${row.id}|${row.status}`);
          entries.push({ item_id: row.id, promotion_id: promo.id, promotion_type: promo.type, promotion_name: promo.name ?? null, status: row.status, price: row.price ?? null, original_price: row.original_price ?? null, meli_percentage: row.meli_percentage, seller_percentage: row.seller_percentage, start_date: promo.start_date ?? null, finish_date: promo.finish_date ?? null });
        }
        after = body.search_after;
        if (!after || !(body.items ?? []).length) break;
      }
    }
  }
  return { entries, included, excluded };
}

async function readItems(client, ids) {
  const info = {};
  for (const group of chunks([...new Set(ids)], READ_CHUNK)) {
    const body = await client.call('item_promos', { ids: group });
    for (const item of body.items ?? []) info[item.id] = { price: item.price, available_quantity: item.available_quantity, promotions: item.promotions ?? [], coupon_uyu: couponAmountUyu(item.promotions, item.price) };
  }
  return info;
}

const slim = e => ({ item_id: e.item_id, promotion_id: e.promotion_id, promotion_type: e.promotion_type, promotion_name: e.promotion_name, status: e.status, price: e.price, original_price: e.original_price, discount_pct: discountPct(e) });

export async function runPromos({ accion, maxPct = DEFAULT_MAX_PCT, confirm = false, titulos = [], date = uyDate() }, client) {
  if (accion === 'relampago' && !titulos.length) throw new Error('relampago requiere titulos (lista de MLU).');
  const apply = Boolean(confirm) && accion !== 'auditar';
  const result = { accion, generado: new Date().toISOString(), fecha_uy: date, max_pct: maxPct, confirm: Boolean(confirm), dry_run: !apply, ventana_excepcion: { activa: inExceptionWindow(date), ...EXCEPTION } };
  if (accion === 'auditar' && confirm) result.nota = 'auditar es solo lectura: confirm se ignora.';

  const status = await client.call('status');
  if (!status.ok) {
    result.acceso = { ok: false, ml_status: status.ml_status, error: status.error, mensaje: `Mercado Libre respondió ${status.ml_status} (${status.error}). Hay que re-autorizar la MISMA app con permiso de promociones; ver docs/meli-promos.md.` };
    return result;
  }
  result.acceso = { ok: true, ml_status: status.ml_status };
  const promotions = status.promotions ?? [];

  if (accion === 'relampago') {
    const info = await readItems(client, titulos);
    const names = Object.fromEntries(promotions.map(p => [p.id, p.name]));
    const byItem = {}, itemInfo = {};
    for (const id of titulos) {
      if (!info[id]) continue;
      itemInfo[id] = { price: info[id].price, available_quantity: info[id].available_quantity };
      byItem[id] = info[id].promotions.map(p => ({ ...p, promotion_id: p.id, promotion_name: names[p.id] ?? p.name ?? null }));
    }
    result.plan = planLightning(titulos, { promotions: byItem, itemInfo, maxPct });
    result.resumen = { titulos: titulos.length, a_sumar: result.plan.joins.length, omitidos: result.plan.skipped.length };
    if (apply) {
      result.aplicado = [];
      for (const group of chunks(result.plan.joins, WRITE_CHUNK)) {
        const out = await client.call('join_lightning', { confirm: true, joins: group.map(({ item_id, promotion_id, promotion_type, deal_price, current_price, stock, available_quantity }) => ({ item_id, promotion_id, promotion_type, deal_price, current_price, stock, available_quantity })) });
        result.aplicado.push(...out.results);
      }
    }
    return result;
  }

  const { entries, included, excluded } = await collectEntries(client, promotions);
  const over = entries.filter(e => { const pct = discountPct(e); return pct === null || pct > maxPct; });
  const itemInfo = inExceptionWindow(date) && over.length ? await readItems(client, over.map(e => e.item_id)) : {};
  const plan = planRemovals(entries, { date, itemInfo, maxPct });
  const decisionOf = new Map();
  for (const r of plan.removals) decisionOf.set(`${r.item_id}|${r.promotion_id}`, 'quitar');
  for (const r of plan.kept_by_exception) decisionOf.set(`${r.item_id}|${r.promotion_id}`, 'conservar_excepcion');
  for (const r of plan.to_review) decisionOf.set(`${r.item_id}|${r.promotion_id}`, 'revisar');
  for (const r of plan.skipped) decisionOf.set(`${r.item_id}|${r.promotion_id}`, r.reason);

  result.promociones = included.map(p => ({ id: p.id, type: p.type, status: p.status, name: p.name, start_date: p.start_date, finish_date: p.finish_date, publicaciones: entries.filter(e => e.promotion_id === p.id).length }));
  result.promociones_excluidas = excluded.map(p => ({ id: p.id, type: p.type, status: p.status, name: p.name }));
  result.resumen = { promociones_activas_o_programadas: included.length, publicaciones_en_promo: entries.length, superan_el_maximo: over.length };
  result.superan = over.map(e => ({ ...slim(e), decision: decisionOf.get(`${e.item_id}|${e.promotion_id}`) ?? 'revisar' }));

  if (accion === 'aplicar_tope') {
    result.plan = plan;
    result.resumen = { ...result.resumen, a_quitar: plan.removals.length, conservadas_por_excepcion: plan.kept_by_exception.length, a_revisar: plan.to_review.length, no_se_tocan: plan.skipped.length };
    if (apply) {
      result.aplicado = [];
      for (const group of chunks(plan.removals, WRITE_CHUNK)) {
        const out = await client.call('remove', { confirm: true, removals: group.map(({ item_id, promotion_id, promotion_type }) => ({ item_id, promotion_id, promotion_type })) });
        result.aplicado.push(...out.results);
      }
      const done = result.aplicado.filter(r => r.ok);
      const after = done.length ? await readItems(client, done.map(r => r.item_id)) : {};
      for (const r of result.aplicado) {
        if (!r.ok) continue;
        const left = after[r.item_id];
        r.verificado = left ? !left.promotions.some(p => p.id === r.promotion_id && isActiveStatus(p.status)) : null;
      }
    }
  }
  return result;
}

export function summaryMarkdown(result) {
  const lines = [`## Promociones: ${result.accion} (${result.dry_run ? 'dry-run, no se escribió nada' : 'APLICADO'})`, ''];
  if (!result.acceso?.ok) lines.push(`**Sin acceso a promociones:** ${result.acceso?.mensaje ?? 'sin dato'}`, '');
  else {
    lines.push(`Tope: ${result.max_pct} %. Fecha en Uruguay: ${result.fecha_uy}. Excepción 29 al 31/10: ${result.ventana_excepcion.activa ? 'activa' : 'inactiva'}.`, '');
    for (const [k, v] of Object.entries(result.resumen ?? {})) lines.push(`- ${k.replaceAll('_', ' ')}: ${v}`);
    const rows = (result.superan ?? []).slice(0, 60);
    if (rows.length) {
      lines.push('', '| Publicación | Promoción | % | Decisión |', '| --- | --- | ---: | --- |');
      for (const r of rows) lines.push(`| ${r.item_id} | ${r.promotion_name ?? r.promotion_id} | ${r.discount_pct ?? '?'} | ${r.decision} |`);
      if ((result.superan ?? []).length > rows.length) lines.push('', `Y ${result.superan.length - rows.length} más en el JSON.`);
    }
    for (const r of result.plan?.joins ?? []) lines.push(`- relámpago ${r.item_id}: $${r.deal_price} (${r.discount_pct} %), stock ${r.stock}`);
    for (const r of result.plan?.skipped ?? []) lines.push(`- omitido ${r.item_id}: ${r.reason}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = createClient({ secret: process.env.SYNC_SECRET });
  let result;
  try {
    result = await runPromos(args, client);
  } catch (error) {
    result = { accion: args.accion, error: error.message, dry_run: true };
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(result, null, 2));
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(result, null, 2));
  const summary = summaryMarkdown(result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!result.acceso?.ok) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
