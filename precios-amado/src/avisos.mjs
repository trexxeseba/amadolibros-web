// Qué se avisa y cuándo. Cada caso tiene una huella (tipo + publicación + lo que
// lo define). Un caso con huella ya avisada y sin cambios no vuelve a avisarse:
// sólo aparece en el resumen diario. Un caso nuevo o cambiado es "novedad".
export function huella(caso) {
  const it = caso.item.id;
  switch (caso.tipo) {
    case 'pierde_con_plazo': case 'pierde_sin_plazo': case 'pierde_por_otro_motivo':
      return `${caso.tipo}|${it}|${caso.ganador.item_id}|${Math.round(caso.ganador.precio)}|${Math.round(caso.mi_precio)}|${caso.ganador.plazo_dias ?? 'x'}`;
    case 'oportunidad':
      return `oportunidad|${it}|${caso.estado}|${Math.round(caso.precio_actual)}|${caso.sugerido == null ? 'revisar' : Math.round(caso.sugerido)}`;
    default:
      return `${caso.tipo}|${it}|${caso.texto ?? ''}`;
  }
}

// Devuelve { novedades, repetidos, avisos } sin mutar el estado recibido.
export function clasificarAvisos(casos, avisosPrevios, ahoraIso) {
  const avisos = { ...avisosPrevios };
  const novedades = [], repetidos = [];
  for (const c of casos) {
    const h = huella(c);
    if (avisos[h]) { avisos[h] = { ...avisos[h], ultima: ahoraIso, veces: (avisos[h].veces ?? 1) + 1 }; repetidos.push(c); }
    else { avisos[h] = { primera: ahoraIso, ultima: ahoraIso, veces: 1 }; novedades.push(c); }
  }
  // Las huellas que ya no aparecen se olvidan a los 30 días: si el caso vuelve, se avisa de nuevo.
  const limite = Date.parse(ahoraIso) - 30 * 86400000;
  for (const [h, v] of Object.entries(avisos)) if (Date.parse(v.ultima) < limite) delete avisos[h];
  return { novedades, repetidos, avisos };
}

// Política de envío: resumen diario en la primera corrida del día; en las demás,
// correo sólo si hay novedades.
export function decidirEnvio({ fechaMontevideo, ultimoResumen, novedades }) {
  if (ultimoResumen !== fechaMontevideo) return { enviar: true, motivo: 'resumen_diario' };
  if (novedades.length) return { enviar: true, motivo: 'novedades' };
  return { enviar: false, motivo: 'sin_novedades' };
}
