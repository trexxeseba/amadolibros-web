// Parte corto de Amado Vintage, una vez por día, sin IA (.github/workflows/vintage-parte.yml).
// Reemplaza a la tarea programada de Claude "Parte corto de Vintage" (Seba, 18/11/2026).
//
// Sólo lee la API de GitHub: la última corrida del vigía (vintage-vigia.yml) y las últimas del
// publicador (vintage-nube.yml). No llama a Mercado Libre ni a D1, no cambia nada y no publica.
// Si hay freno, infracción o aviso, el freno ya lo puso el vigía: acá sólo se avisa fuerte.
// El mail lleva conteos y estados, nunca claves ni montos.
//
//   node scripts/partes/vintage-parte.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { cliente, ultimoJson, jsonDespuesDe, horasDesde, horaUy } from './github.mjs';
import { sendMail } from '../vintage-cloud/aviso.mjs';

export const VIGIA_MAX_HORAS = 2;
const pct = n => n === null || n === undefined ? 'sin dato' : `${(n * 100).toFixed(1).replace('.', ',')} %`;

// Arma el parte con lo leído. Pura: sin red.
//  vigia: {corrida, salida}  ·  nube: {corridas, ultimaOk, reporte}
export function armar({ vigia, nube, ahora = Date.now() }) {
  const fuerte = [];
  const v = vigia?.salida, pi = v?.vigia_pi, s = v?.senales;

  // 1. Publicador
  const corridas = nube?.corridas ?? [], fallidas = corridas.filter(c => c.conclusion !== 'success').length;
  const r = nube?.reporte, freno = r?.freno;
  let publicador = 'Publicador: sin corridas para leer.';
  if (nube?.ultimaOk) {
    const partes = [`última corrida buena ${horaUy(nube.ultimaOk.updated_at)}`];
    if (r?.estado) partes.push(`estado ${r.estado}`);
    if (freno) partes.push(`${freno.altas_hoy} altas hoy de ${freno.tope_diario}`);
    if (r?.publicacion?.publicados_total != null) partes.push(`total ${r.publicacion.publicados_total}`);
    partes.push(fallidas ? `${fallidas} de las últimas ${corridas.length} corridas fallaron` : `las últimas ${corridas.length} corridas terminaron bien`);
    publicador = `Publicador: ${partes.join(', ')}.`;
  }
  if (fallidas) fuerte.push(`el publicador falló en ${fallidas} de las últimas ${corridas.length} corridas`);
  if (!nube?.ultimaOk) fuerte.push('no hay ninguna corrida buena del publicador entre las últimas');
  if (r?.estado === 'frenado_por_infraccion_pi') fuerte.push('el publicador está frenado');

  // 2. Riesgo
  let riesgo = 'Riesgo: no se pudo leer la salida del vigía.';
  if (!vigia?.corrida) fuerte.push('no hay corridas del vigía');
  else if (horasDesde(vigia.corrida.updated_at, ahora) > VIGIA_MAX_HORAS) fuerte.push(`el vigía no corre desde ${horaUy(vigia.corrida.updated_at)}`);
  if (vigia?.corrida && !v) fuerte.push('la última corrida del vigía no dejó su resultado');
  if (v && v.ok === false) { fuerte.push(`el vigía falló (${v.error ?? 'sin detalle'})`); riesgo = `Riesgo: el vigía falló (${v.error ?? 'sin detalle'}).`; }
  if (v?.ok) {
    riesgo = `Riesgo: ${pi?.nuevas_pi ?? 0} infracciones nuevas, ${pi?.denuncias_abiertas ?? 'sin dato de'} denuncias abiertas, ${s?.avisos_nuevos ?? 0} avisos nuevos, freno ${pi?.freno ? 'PUESTO' : 'libre'}.`;
    if (pi?.freno) fuerte.push(`freno puesto (${pi.freno.motivo ?? 'sin motivo'})`);
    if (pi?.nuevas_pi > 0) fuerte.push(`${pi.nuevas_pi} infracciones nuevas`);
    if (s?.avisos_pi > 0) fuerte.push(`${s.avisos_pi} avisos de propiedad intelectual`);
    if (s?.avisos_graves > 0) fuerte.push(`${s.avisos_graves} avisos de sanción`);
    if (s?.reputacion_frena) fuerte.push('la reputación empeoró');
    if (s?.error) fuerte.push(`no se leyeron avisos ni reputación (${s.error})`);
  }

  // 3. Reputación
  const rep = s?.reputacion;
  const reputacion = rep ? `Reputación: nivel ${rep.level ?? 'sin dato'}, cancelaciones ${pct(rep.cancelaciones)}, reclamos ${pct(rep.reclamos)}, demoras ${pct(rep.demoras)}, ${rep.ventas ?? 'sin dato de'} ventas.` : 'Reputación: sin dato.';

  // 4. Restricción: mientras todas las muestras digan non_trusted_seller, sigue puesta.
  const comp = s?.competencia;
  let restriccion = 'Restricción: sin dato de la foto de competencia.';
  if (comp?.total > 0) {
    const no = Object.entries(comp.por_razon ?? {}).filter(([k]) => /non_trusted_seller/.test(k)).reduce((a, [, n]) => a + n, 0);
    restriccion = `Restricción: ${no} de ${comp.total} muestras con non_trusted_seller (${Math.round(no * 100 / comp.total)} %).`;
    if (no < comp.total) fuerte.push(`la proporción non_trusted_seller bajó de 100 % (${no} de ${comp.total}): señal de que levantaron la restricción`);
  }

  const lineas = [publicador, riesgo, reputacion, restriccion];
  return {
    atencion: fuerte.length > 0,
    asunto: fuerte.length ? `ATENCIÓN: ${fuerte[0]}` : 'todo normal',
    texto: (fuerte.length ? `ATENCIÓN:\n${fuerte.map(f => `- ${f}`).join('\n')}\n\n` : '') + lineas.join('\n'),
    lineas, fuerte,
  };
}

export async function leer({ gh, repo }) {
  const [corridaVigia] = await gh.corridas(repo, 'vintage-vigia.yml', 1);
  const salida = corridaVigia ? ultimoJson(await gh.registro(repo, corridaVigia.id), '{"ok":') : null;
  const corridas = await gh.corridas(repo, 'vintage-nube.yml', 6);
  const ultimaOk = corridas.find(c => c.conclusion === 'success') ?? null;
  const reporte = ultimaOk ? jsonDespuesDe(await gh.registro(repo, ultimaOk.id), '=== REPORTE ===') : null;
  return { vigia: { corrida: corridaVigia ?? null, salida }, nube: { corridas, ultimaOk, reporte } };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  let parte;
  try { parte = armar(await leer({ gh: cliente(), repo })); }
  catch (error) { parte = { atencion: true, asunto: 'ATENCIÓN: el parte no pudo leer GitHub', texto: `El parte de Vintage no pudo leer las corridas (${/^[a-z0-9_]{1,60}$/.test(error.message) ? error.message : 'error'}).`, fuerte: ['sin lectura'] }; }
  const pie = process.env.RUN_URL ? `\n\nDetalle: ${process.env.RUN_URL}` : '';
  const mail = await sendMail({ asunto: parte.asunto, texto: parte.texto + pie, prefijo: 'Vintage parte' });
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Parte de Vintage\n\n${parte.texto.replace(/\n/g, '  \n')}\n`);
  console.log(JSON.stringify({ atencion: parte.atencion, motivos: parte.fuerte.length, mail }));
  if (mail !== 'enviado') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
