// Franjas programadas (hora de Montevideo, UTC-3 fijo: Uruguay no usa horario de verano
// desde 2015). Detecta las que no corrieron entre la última corrida y ahora.
const OFFSET_MS = -3 * 3600_000;
const TOLERANCIA_MS = 45 * 60_000;

export function franjaKey(ms) { return new Date(ms + OFFSET_MS).toISOString().slice(0, 16).replace('T', ' '); }

// Momentos (ms UTC) de cada franja entre desde y hasta.
export function franjasEntre(desdeMs, hastaMs, horarios) {
  const out = [];
  const dia0 = Date.UTC(...ymd(desdeMs)) - OFFSET_MS;
  for (let d = dia0; d <= hastaMs; d += 86400_000) {
    for (const h of horarios) {
      const [hh, mm] = h.split(':').map(Number);
      const t = d + (hh * 60 + mm) * 60_000;
      if (t > desdeMs && t <= hastaMs) out.push(t);
    }
  }
  return out;
}
function ymd(ms) { const x = new Date(ms + OFFSET_MS); return [x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()]; }

// Franjas que debieron correr y no corrieron. La corrida actual cubre la franja más
// cercana anterior a ahora si está dentro de la tolerancia (arranque tardío normal).
export function franjasOmitidas(ultimaInicioMs, ahoraMs, horarios) {
  if (!ultimaInicioMs) return [];
  return franjasEntre(ultimaInicioMs + TOLERANCIA_MS, ahoraMs - TOLERANCIA_MS, horarios).map(franjaKey);
}
