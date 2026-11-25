// Control de Precio Ganador sin IA (.github/workflows/precio-ganador-control.yml).
// Reemplaza a la tarea programada de Claude "Estado horario de Precio Ganador" (Seba, 18/11/2026).
//
// Sólo mira y cuenta, no cambia nada:
//  1. las últimas corridas de precio-ganador.yml y la del vigía (API de GitHub);
//  2. el resumen de cada cuenta en la rama de estado del repo privado (ultima/<cuenta>-resumen.json):
//     sólo contadores, nunca precios.
// Manda mail únicamente si hay algo para mirar; si está todo bien queda en el resumen de la corrida.
//
//   node scripts/partes/precio-ganador-control.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { cliente, horasDesde, horaUy } from './github.mjs';
import { enviarAlarma } from '../../precio-ganador/src/alarma.mjs';

export const CUENTAS = ['libros', 'vintage'];
// De 21:00 a 09:00 no corre (12 h); con el atraso habitual del cron, 15 h sin resumen nuevo ya es raro.
export const RESUMEN_MAX_HORAS = 15;
const CLAVES = ['bajadas', 'ajustadas', 'subidas', 'restauradas', 'verificadas', 'errores', 'ganador_inmediato'];

// Pura: sin red. corridas y vigia son corridas de la API; resumenes es {cuenta: resumen|null}.
export function evaluar({ corridas = [], vigia = null, resumenes = {}, ahora = Date.now() }) {
  const atencion = [], lineas = [];
  const fallidas = corridas.filter(c => c.conclusion !== 'success');
  lineas.push(corridas.length
    ? `Corridas: ${corridas.map(c => `${horaUy(c.updated_at)} ${c.conclusion === 'success' ? 'bien' : c.conclusion}`).join(' · ')}.`
    : 'Corridas: ninguna terminada para leer.');
  if (!corridas.length) atencion.push('no hay corridas terminadas de Precio Ganador');
  else if (corridas[0].conclusion !== 'success') atencion.push(`la última corrida terminó en ${corridas[0].conclusion} (${corridas[0].html_url})`);
  else if (fallidas.length) atencion.push(`${fallidas.length} de las últimas ${corridas.length} corridas no terminaron bien`);
  if (vigia && vigia.conclusion !== 'success') atencion.push(`el vigía de Precio Ganador terminó en ${vigia.conclusion} (${vigia.html_url})`);

  for (const cuenta of CUENTAS) {
    const r = resumenes[cuenta], c = r?.contadores;
    if (!c) { atencion.push(`no se pudo leer el resumen de ${cuenta}`); lineas.push(`${cuenta}: sin resumen.`); continue; }
    lineas.push(`${cuenta} (${horaUy(c.fecha)}, modo ${c.modo}): ${CLAVES.map(k => `${k.replace('_', ' ')} ${c[k] ?? 0}`).join(', ')}; activas ${c.activas ?? 'sin dato'}.`);
    if (horasDesde(c.fecha, ahora) > RESUMEN_MAX_HORAS) atencion.push(`el resumen de ${cuenta} es del ${horaUy(c.fecha)}`);
    if (c.errores > 0) atencion.push(`${cuenta}: ${c.errores} errores en la última corrida`);
    if (c.no_verificadas > 0) atencion.push(`${cuenta}: ${c.no_verificadas} cambios sin verificar`);
    if (c.modo !== 'real') atencion.push(`${cuenta}: está en modo ${c.modo}`);
  }
  lineas.push('Corre cada 2 horas de 09:00 a 21:00 de Montevideo.');
  return { atencion, lineas, texto: `${atencion.length ? `Atención:\n${atencion.map(a => `- ${a}`).join('\n')}` : 'Todo bien.'}\n\n${lineas.join('\n')}` };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY, gh = cliente();
  const estadoRepo = process.env.ESTADO_REPO, rama = process.env.ESTADO_RAMA, tokenEstado = process.env.ESTADO_TOKEN;
  let salida;
  try {
    const corridas = await gh.corridas(repo, 'precio-ganador.yml', 3);
    const [vigia] = await gh.corridas(repo, 'precio-ganador-vigia.yml', 1);
    const resumenes = {};
    for (const cuenta of CUENTAS) resumenes[cuenta] = tokenEstado ? await gh.json(estadoRepo, `ultima/${cuenta}-resumen.json`, rama, tokenEstado).catch(() => null) : null;
    salida = evaluar({ corridas, vigia: vigia ?? null, resumenes });
  } catch (error) {
    const motivo = /^[a-z0-9_]{1,60}$/.test(error.message) ? error.message : 'error';
    salida = { atencion: [`el control no pudo leer GitHub (${motivo})`], lineas: [], texto: `Atención:\n- el control no pudo leer GitHub (${motivo})` };
  }
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Control de Precio Ganador\n\n${salida.texto.replace(/\n/g, '  \n')}\n`);
  let mail = 'no_hacia_falta';
  if (salida.atencion.length) mail = (await enviarAlarma({ aviso: true, asunto: `control: ${salida.atencion[0].slice(0, 90)}`, texto: salida.texto + (process.env.RUN_URL ? `\n\nDetalle: ${process.env.RUN_URL}` : '') })).status;
  console.log(JSON.stringify({ atencion: salida.atencion.length, mail }));
  if (salida.atencion.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
