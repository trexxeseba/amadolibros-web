import { nextInternalEmailAt } from '../../functions/_shared/internal-email-schedule.js';
// Texto diario de la poda y mail (desde el 26/11/2026 sin la mesa de Airtable).
// El detalle con montos va SOLO acá y a D1: nunca a los logs de Actions (repo público).
// Code nunca pone una fila en Aprobada ni en Rechazada.
export const MESA = { base: 'appElRtjx65dmtTgO', tabla: 'tblAoTEnKA2eC85g6' };
const F = { propuesta: 'fld7CSwhRc0P8GOm5', clave: 'fld0pPEWivLADcKOu', fecha: 'fld1qZXcIafkzAsF5', rama: 'fldyzCiuNdjm94MXj', tarea: 'fldaudDXzXw2BXnnV', tipo: 'fldrprG9mJLB3oBS8', prioridad: 'fldNBigULbTz2wuwI', publicacion: 'fld8TswPvRw2V2tkz', dato: 'fldwtSvMycZShRfJD', recomendada: 'fldDSqwG1qPTtteXZ', alternativa: 'fldUXvgYlcRlZAN0X', estado: 'fldsWM8HhUOOKlSSW' };
export const ROTULO = 'revisar ficha: precio, foto, título, competencia';

const peso = v => v === null || v === undefined ? '?' : `$${Math.round(Number(v))}`;
const mlu = f => (f.item_ids?.length ? f.item_ids.slice(0, 3).join(', ') : f.external_id) ?? f.ad_group_id;
const linea = f => `- ${String(f.titulo ?? '').slice(0, 70)} | ${mlu(f)} | precio ${peso(f.precio_lista ?? f.precio)} | gasto ${peso(f.gasto)} | ${f.clics} clics | clic ${peso(f.cpc)}${f.tope ? ` | tope ${peso(f.tope)}` : ''}`;
export const esSoloPromo = f => /promoci[oó]n/i.test(String(f?.motivo ?? '')) && !/baj[oó] el precio/i.test(String(f?.motivo ?? ''));
const bloqueConMotivo = (titulo, arr, max = 60) => arr.length ? [`${titulo} (${arr.length}):`, ...arr.slice(0, max).map(f => `${linea(f)} | ${String(f.motivo ?? 'sin motivo anotado')}${f.desde ? ` | propuesto el ${f.desde}` : ''}`), ...(arr.length > max ? [`... y ${arr.length - max} más`] : []), ''] : [];
const bloque = (titulo, arr, extra = '', max = 60) => arr.length ? [`${titulo} (${arr.length}):`, ...arr.slice(0, max).map(f => linea(f) + (extra ? ` | ${extra}` : '')), ...(arr.length > max ? [`... y ${arr.length - max} más`] : []), ''] : [];

export function armarFilaDiaria({ fecha, accion, modo, real, resultado }) {
  const { contadores: c, listas: L } = resultado;
  const prefijo = real ? '' : '[PRUEBA] ';
  const cab = `${prefijo}Poda ${accion === 'auditar' ? 'auditoría' : 'diaria'} ${fecha}: evaluados ${c.evaluados}, a pausar ${real ? c.pausar + c.pendientes_pausa : c.pausaria + c.pausar}, a reactivar ${c.reactivar}, en observación ${c.observacion}.`;
  const dato = [
    cab, '',
    real ? 'Modo real: la lista queda en el registro de la nube. El Agente único pausa y reactiva EXACTAMENTE lo que figura abajo, sin calcular ni decidir.' : 'Modo prueba: nada se registró y no hay nada que ejecutar todavía.', '',
    ...bloque(real ? 'A PAUSAR (nuevos)' : 'PAUSARÍA', [...L.pausar, ...(L.pausaria ?? [])], ROTULO),
    ...bloque('A PAUSAR (propuestos antes y todavía sin ejecutar)', L.pendientesPausa, ROTULO),
    // Cada reactivación lleva su motivo (Seba, 24/11/2026): una venta es razón fuerte; una baja de precio cambia
    // la oferta; entrar en una promoción sola es razón floja y va en un bloque aparte para decidir.
    ...bloqueConMotivo('A REACTIVAR: volvió a venderse (regla 5)', L.reactivar.filter(f => Number(f.regla) === 5)),
    ...bloqueConMotivo('A REACTIVAR: bajó el precio (regla 6)', L.reactivar.filter(f => Number(f.regla) === 6 && !esSoloPromo(f))),
    ...bloqueConMotivo('PARA DECIDIR: sólo entró en una promoción (regla 6); no reactivar sin un sí', L.reactivar.filter(f => Number(f.regla) === 6 && esSoloPromo(f))),
    ...bloqueConMotivo('A REACTIVAR: sin regla anotada', L.reactivar.filter(f => ![5, 6].includes(Number(f.regla)))),
    ...bloque('Clic caro (costo por clic mayor al 4 % del precio; sólo informa)', L.clicCaro),
    ...bloque('En observación (sin venta, con la mitad del tope o más)', L.observar),
    ...bloque('Falta precio (no se poda)', L.faltaPrecio),
    ...bloque('Revisar a mano', L.revisar),
    ...bloque('Excedentes del freno (NO propuestos)', L.excedentes),
    ...(L.conGasto?.length ? [`Con gasto de $150 o más que NO se pausan, y por qué (${L.conGasto.length}):`, ...L.conGasto.slice(0, 80).map(f => `${linea(f)} | ${f.motivo}`), ''] : []),
  ].join('\n');
  return {
    [F.clave]: `poda|${fecha}${accion === 'auditar' ? '|auditoria' : ''}`, [F.propuesta]: cab, [F.fecha]: fecha, [F.rama]: 'Publicidad', [F.tarea]: 'Poda automatica', [F.tipo]: 'Hecho',
    [F.prioridad]: 'Media', [F.estado]: 'Nueva', [F.dato]: dato.slice(0, 95000),
    [F.recomendada]: real ? 'Ejecutar la lista tal cual en la consola de Mercado Ads.' : 'Revisar la lista y, si está bien, dar el sí para pasar a modo real.',
  };
}

export function armarFilaAlerta({ fecha, motivo, detalle }) {
  return { [F.clave]: `poda|alerta|${motivo}|${fecha}`, [F.propuesta]: `Poda ${fecha}: ${detalle.slice(0, 120)}`, [F.fecha]: fecha, [F.rama]: 'Publicidad', [F.tarea]: 'Poda automatica', [F.tipo]: motivo === 'error' ? 'Error' : 'Alerta', [F.prioridad]: 'Alta', [F.estado]: 'Nueva', [F.dato]: detalle, [F.recomendada]: 'Revisar antes de la próxima corrida.' };
}

// Mail diario (Seba 26/11/2026): arriba APP, PROYECTO y COMETIDO en mayúscula y negrita; abajo cómo
// desactivarlo o modificarlo. Nada va a Airtable.
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const PIE = [
  'Cómo desactivarlo o modificarlo:',
  '- Apagar: en el repo amadolibros-web, poda/modo.json en "off", o desactivar el workflow "Poda de anuncios (Mercado Ads)" en Actions.',
  '- Solo prueba (no registra nada): poda/modo.json en "dry-run".',
  '- Cambiar reglas: poda/src/reglas.mjs (REGLAS: clicsSinVenta, diasSeguidos, roasMinimo).',
  '- Cambiar destinatario: PODA_EMAIL_TO en .github/workflows/poda-anuncios.yml.',
  '- Pausas por Chrome: tarea programada de Claude "Poda de anuncios por la consola".',
].join('\n');
export function armarMail({ fecha, real, cuerpo, avisos = [] }) {
  const cab = ['APP: MERCADO ADS DE AMADO LIBROS', 'PROYECTO: PODA DE ANUNCIOS', 'COMETIDO: PAUSAR LOS ANUNCIOS QUE GASTAN SIN VENDER Y REACTIVAR LOS QUE VUELVEN A VENDER'];
  const texto = [...cab, '', ...avisos, ...(avisos.length ? [''] : []), String(cuerpo ?? ''), '', PIE].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">${cab.map(l => `<p style="margin:0"><b>${esc(l)}</b></p>`).join('')}<br>`
    + (avisos.length ? `<p><b>${avisos.map(esc).join('<br>')}</b></p>` : '')
    + `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">${esc(cuerpo)}</pre><hr><pre style="font-family:Arial,sans-serif;white-space:pre-wrap;color:#555">${esc(PIE)}</pre></div>`;
  return { asunto: `Poda de anuncios ${fecha}${real ? '' : ' (prueba)'}${avisos.length ? ' - ATENCIÓN' : ''}`, texto, html };
}

// Lista que ejecuta la tarea de Chrome: qué pausar y qué reactivar en la consola de Mercado Ads.
export function listaParaChrome({ fecha, accion, real, resultado }) {
  const L = resultado.listas;
  const f = x => ({ ad_group_id: String(x.ad_group_id ?? x.id ?? ''), items: x.item_ids ?? [], titulo: x.titulo ?? null, motivo: x.motivo ?? null, provisoria: /PROVISORIA/.test(String(x.motivo ?? '')), gasto: x.gasto ?? null, clics: x.clics ?? null });
  return { fecha, accion, real, pausar: [...L.pausar, ...L.pendientesPausa].map(f), reactivar: L.reactivar.filter(x => !esSoloPromo(x)).map(f) };
}

// Mail de respaldo con el detalle (privado, a Seba). Sólo si no se pudo subir a la mesa.
export async function enviarMail({ asunto, texto, html = null, env = process.env, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = env.RESEND_API_KEY, to = String(env.PODA_EMAIL_TO ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey || !to.length) return { ok: false, motivo: 'sin_credenciales' };
  const res = await fetcher('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ scheduled_at: nextInternalEmailAt(), from: env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>', to, subject: asunto, text: texto, ...(html ? { html } : {}) }),
  }).catch(() => null);
  return res?.ok ? { ok: true } : { ok: false, motivo: `resend_http_${res?.status ?? 'transporte'}` };
}
