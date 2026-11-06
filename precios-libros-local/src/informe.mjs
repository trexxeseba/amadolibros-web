// Informe por publicación (CSV + Markdown + resumen JSON) en datos/informes/<corrida>/.
// Queda en la PC: tiene precios e IDs, no va al repo.
import { writeFileSync } from 'node:fs';
import { objetivo99 } from './regla.mjs';

const COLS = ['item_id', 'titulo', 'accion', 'motivo', 'precio_base', 'precio_actual', 'competidor_item', 'competidor_precio', 'fuente', 'ptw_status', 'ganador_precio', 'diferencia', 'objetivo_99', 'descuento_corrida', 'supera_400', 'piso', 'desc_acum_uyu', 'desc_acum_pct', 'resultado'];

export function filasInforme(filas) {
  return filas.filter(Boolean).map(f => {
    const c = f.decision?.calc ?? {}, comp = f.lectura?.comp ?? {};
    return {
      item_id: f.id, titulo: (f.item?.title ?? '').slice(0, 70), accion: f.decision?.accion, motivo: f.decision?.motivo ?? '',
      precio_base: c.base ?? null, precio_actual: c.P ?? null, competidor_item: comp.competidor ?? null, competidor_precio: c.C ?? comp.C ?? null,
      fuente: comp.fuente ?? null, ptw_status: f.ptw?.status ?? comp.ptwStatus ?? null, ganador_precio: f.ptw?.winnerPrice ?? null,
      diferencia: c.D ?? null, objetivo_99: f.decision?.objetivo ?? c.objetivo ?? null, descuento_corrida: c.descuentoCorrida ?? null,
      supera_400: c.supera400 ?? null, piso: c.piso ?? null, desc_acum_uyu: c.descAcumUyu ?? null,
      desc_acum_pct: c.descAcumPct != null ? Math.round(c.descAcumPct * 1000) / 10 : null, resultado: f.resultado ?? null,
    };
  });
}

const csv = v => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// Impacto del límite acumulado: cuántas bajas pasarían con cada límite (sin piso).
export function impactoLimites(filas, limites = [null, 0.10, 0.15, 0.20], tope = 600) {
  const cands = filas.filter(f => f.precio_actual != null && f.competidor_precio != null && f.diferencia > 0 && f.diferencia < 400);
  return limites.map(l => {
    const pasan = cands.filter(f => { const obj = objetivo99(f.competidor_precio); const base = f.precio_base ?? f.precio_actual; const u = base - obj; return l === null || (u / base <= l && u <= tope); });
    return { limite_pct: l, tope_uyu: l === null ? null : tope, bajas: pasan.length, de: cands.length, descuento_total_uyu: pasan.reduce((s, f) => s + (f.precio_actual - objetivo99(f.competidor_precio)), 0) };
  });
}

export function escribirInforme(dir, filas, { corrida, modo, regla, frenos, avisos }) {
  writeFileSync(`${dir}/informe.csv`, '﻿' + [COLS.join(','), ...filas.map(f => COLS.map(k => csv(f[k])).join(','))].join('\r\n'));
  const acciones = {};
  for (const f of filas) acciones[f.accion] = (acciones[f.accion] ?? 0) + 1;
  const impacto = impactoLimites(filas, [...new Set([null, 0.10, 0.15, 0.20, regla.limiteAcumPct])], regla.limiteAcumUyu);
  const bajas = filas.filter(f => f.accion === 'bajar');
  const supera = bajas.filter(f => f.supera_400);
  const md = [
    `# Motor de precios Amado Libros · ${modo} · ${corrida.inicio}`, '',
    `Regla: 0 < D < ${regla.umbralUyu} → C × ${regla.factor}; referencia "${regla.referencia}"; límite acumulado ${regla.limiteAcumPct * 100} % y ${regla.limiteAcumUyu} pesos sobre el precio base; recuperación ${regla.recuperacionHabilitada ? 'habilitada' : 'sólo propuesta'}.`, '',
    avisos.length ? '## Avisos\n\n' + avisos.map(x => `- ${x}`).join('\n') + '\n' : '',
    '## Acciones', '', '| Acción | Publicaciones |', '|---|---:|', ...Object.entries(acciones).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), '',
    `## Bajas (${bajas.length}${bajas.length > frenos.maxCambiosPorCorrida ? `; en real se aplicarían ${frenos.maxCambiosPorCorrida} por corrida` : ''})`, '',
    supera.length ? `En ${supera.length} el descuento total supera ${regla.umbralUyu} pesos por el 1 % adicional (columna "supera 400").\n` : '',
    '| Publicación | Base | Actual | Competidor | D | Objetivo 99 % | Descuento | Supera 400 | Piso | Acum. % |', '|---|---:|---:|---:|---:|---:|---:|---|---:|---:|',
    ...bajas.map(f => `| ${f.item_id} ${f.titulo.slice(0, 40)} | ${f.precio_base ?? f.precio_actual} | ${f.precio_actual} | ${f.competidor_precio} | ${f.diferencia} | ${f.objetivo_99} | ${f.descuento_corrida} | ${f.supera_400 ? 'sí' : 'no'} | ${f.piso} | ${f.desc_acum_pct} |`), '',
    '## Omitidas con objetivo calculado (piso, límite)', '',
    '| Publicación | Acción | Actual | Competidor | D | Objetivo 99 % | Piso | Motivo |', '|---|---|---:|---:|---:|---:|---:|---|',
    ...filas.filter(f => /^omitir_(sin_piso|bajo_piso|limite_acumulado)$/.test(f.accion)).map(f => `| ${f.item_id} ${f.titulo.slice(0, 40)} | ${f.accion} | ${f.precio_actual} | ${f.competidor_precio} | ${f.diferencia} | ${f.objetivo_99} | ${f.piso ?? '—'} | ${f.motivo} |`), '',
    '## Impacto del límite acumulado (candidatas con 0 < D < 400, antes del piso)', '',
    '| Límite | Bajas | De | Descuento total (pesos) |', '|---|---:|---:|---:|',
    ...impacto.map(i => `| ${i.limite_pct === null ? 'sin límite' : `${i.limite_pct * 100} % y ${i.tope_uyu} pesos`} | ${i.bajas} | ${i.de} | ${i.descuento_total_uyu} |`), '',
  ].join('\n');
  writeFileSync(`${dir}/informe.md`, md);
  const resumen = { corrida, modo, acciones, impacto, bajas: bajas.length, supera400: supera.length, avisos };
  writeFileSync(`${dir}/resumen.json`, JSON.stringify(resumen, null, 2));
  return resumen;
}
