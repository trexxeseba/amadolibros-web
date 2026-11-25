// Qué se avisa y cuándo. Cada caso tiene una huella hecha sólo de lo que lo
// define comercialmente (no del texto ni de códigos de error). Un caso con huella
// ya avisada no vuelve a avisarse: sólo aparece en el resumen diario. Un caso
// nuevo o cambiado es "novedad".
const r0 = v => Number.isFinite(Number(v)) ? Math.round(Number(v)) : 'x';
// Tramo del plazo: alcanza con saber si vende a pedido; el número exacto oscila.
const tramo = d => d == null ? 'x' : d > 0 ? 'a_pedido' : 'inmediato';

export function huella(caso) {
  const it = caso.item.id;
  switch (caso.tipo) {
    case 'pierde_con_plazo': case 'pierde_sin_plazo': case 'pierde_por_otro_motivo': case 'pierde_con_plazo_propio_no_inmediato':
      return `pierde|${it}|${caso.ganador.item_id}|${r0(caso.ganador.precio)}|${r0(caso.mi_precio)}|${tramo(caso.ganador.plazo_dias)}`;
    case 'oportunidad':
      return `oportunidad|${it}|${caso.estado}|${r0(caso.precio_actual)}|${caso.sugerido == null ? 'revisar' : r0(caso.sugerido)}`;
    case 'comparte_primer_lugar': return `comparte|${it}|${caso.compartiendo ?? 'x'}`;
    case 'no_compite': return `no_compite|${it}|${(caso.motivos_ml ?? []).join(',')}`;
    case 'competencia_sin_estado': return `sin_estado|${it}`;
    case 'plazo_configurado': return `plazo|${it}|${caso.item.plazo_dias}`;
    default: return `${caso.tipo}|${it}|${caso.texto ?? ''}`;
  }
}

// Casos que dependen de un dato que no se pudo leer: se muestran en el reporte
// pero nunca disparan un correo de novedad.
export const esDatoFaltante = c => c.tipo === 'competencia_sin_estado' || (c.ganador && c.ganador.plazo_dias == null);

// Devuelve { novedades, repetidos, avisos } sin mutar el estado recibido.
export function clasificarAvisos(casos, avisosPrevios, ahoraIso) {
  const avisos = { ...avisosPrevios };
  const novedades = [], repetidos = [];
  for (const c of casos) {
    const h = huella(c);
    if (avisos[h]) { avisos[h] = { ...avisos[h], ultima: ahoraIso, veces: (avisos[h].veces ?? 1) + 1 }; repetidos.push(c); continue; }
    if (esDatoFaltante(c)) { repetidos.push(c); continue; }
    avisos[h] = { primera: ahoraIso, ultima: ahoraIso, veces: 1 };
    novedades.push(c);
  }
  // Las huellas que ya no aparecen se olvidan a los 30 días: si el caso vuelve, se avisa de nuevo.
  const limite = Date.parse(ahoraIso) - 30 * 86400000;
  for (const [h, v] of Object.entries(avisos)) if (Date.parse(v.ultima) < limite) delete avisos[h];
  return { novedades, repetidos, avisos };
}

// Política de envío: resumen diario en la primera corrida completa del día; en
// las demás, correo sólo si hay novedades.
export function decidirEnvio({ fechaMontevideo, ultimoResumen, novedades }) {
  if (ultimoResumen !== fechaMontevideo) return { enviar: true, motivo: 'resumen_diario' };
  if (novedades.length) return { enviar: true, motivo: 'novedades' };
  return { enviar: false, motivo: 'sin_novedades' };
}
