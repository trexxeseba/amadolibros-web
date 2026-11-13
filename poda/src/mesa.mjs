// Fila diaria de la poda en la mesa de decisiones (Airtable) y mail de respaldo.
// El detalle con montos va SOLO acá y a D1: nunca a los logs de Actions (repo público).
// Code nunca pone una fila en Aprobada ni en Rechazada.
export const MESA = { base: 'appElRtjx65dmtTgO', tabla: 'tblAoTEnKA2eC85g6' };
const F = { propuesta: 'fld7CSwhRc0P8GOm5', clave: 'fld0pPEWivLADcKOu', fecha: 'fld1qZXcIafkzAsF5', rama: 'fldyzCiuNdjm94MXj', tarea: 'fldaudDXzXw2BXnnV', tipo: 'fldrprG9mJLB3oBS8', prioridad: 'fldNBigULbTz2wuwI', publicacion: 'fld8TswPvRw2V2tkz', dato: 'fldwtSvMycZShRfJD', recomendada: 'fldDSqwG1qPTtteXZ', alternativa: 'fldUXvgYlcRlZAN0X', estado: 'fldsWM8HhUOOKlSSW' };
export const ROTULO = 'revisar ficha: precio, foto, título, competencia';

const peso = v => v === null || v === undefined ? '?' : `$${Math.round(Number(v))}`;
const mlu = f => (f.item_ids?.length ? f.item_ids.slice(0, 3).join(', ') : f.external_id) ?? f.ad_group_id;
const linea = f => `- ${String(f.titulo ?? '').slice(0, 70)} | ${mlu(f)} | precio ${peso(f.precio_lista ?? f.precio)} | gasto ${peso(f.gasto)} | ${f.clics} clics | clic ${peso(f.cpc)}${f.tope ? ` | tope ${peso(f.tope)}` : ''}`;
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
    ...bloque('A REACTIVAR', L.reactivar.map(f => ({ ...f })), ''),
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

// Upsert por Clave con la API de Airtable. Sin AIRTABLE_TOKEN devuelve { ok:false, motivo:'sin_token' }.
export async function subirFila(fields, { env = process.env, fetcher = (...a) => globalThis.fetch(...a) } = {}) {
  const token = env.AIRTABLE_TOKEN;
  if (!token) return { ok: false, motivo: 'sin_token' };
  const res = await fetcher(`https://api.airtable.com/v0/${MESA.base}/${MESA.tabla}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ performUpsert: { fieldsToMergeOn: [F.clave] }, typecast: true, records: [{ fields }] }),
  }).catch(() => null);
  return res?.ok ? { ok: true } : { ok: false, motivo: `airtable_http_${res?.status ?? 'transporte'}` };
}

// Mail de respaldo con el detalle (privado, a Seba). Sólo si no se pudo subir a la mesa.
export async function enviarMail({ asunto, texto, env = process.env, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = env.RESEND_API_KEY, to = String(env.PODA_EMAIL_TO ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!apiKey || !to.length) return { ok: false, motivo: 'sin_credenciales' };
  const res = await fetcher('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ from: env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>', to, subject: asunto, text: texto }),
  }).catch(() => null);
  return res?.ok ? { ok: true } : { ok: false, motivo: `resend_http_${res?.status ?? 'transporte'}` };
}
