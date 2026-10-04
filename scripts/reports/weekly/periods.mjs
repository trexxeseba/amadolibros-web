/**
 * Períodos del informe semanal, en hora de Montevideo (UTC-3, sin horario de
 * verano). La semana del informe es la última completa de lunes a domingo; la
 * comparación es contra la semana anterior a esa.
 *
 * Search Console publica con 2–3 días de atraso, así que su semana termina
 * tres días antes del día en que corre el informe. El informe dice las dos
 * ventanas, no las mezcla en silencio.
 */

const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function localMidnightUtcMs(date) {
  const local = new Date(date.getTime() - OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + OFFSET_MS;
}

function localDateString(utcMs) {
  return new Date(utcMs - OFFSET_MS).toISOString().slice(0, 10);
}

function window(startMs, days) {
  const endMs = startMs + days * DAY_MS;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(), // exclusivo
    startDate: localDateString(startMs),
    endDate: localDateString(endMs - 1), // inclusivo
  };
}

export function weeklyPeriods(now = new Date()) {
  const todayMs = localMidnightUtcMs(now);
  const localDow = new Date(todayMs - OFFSET_MS).getUTCDay(); // 0 = domingo
  const daysSinceMonday = (localDow + 6) % 7;
  const thisMondayMs = todayMs - daysSinceMonday * DAY_MS;
  const currentStart = thisMondayMs - 7 * DAY_MS;

  const gscEnd = todayMs - 3 * DAY_MS; // último día con datos, inclusivo
  const gscStart = gscEnd - 6 * DAY_MS;

  return {
    current: window(currentStart, 7),
    previous: window(currentStart - 7 * DAY_MS, 7),
    gsc: {
      current: window(gscStart, 7),
      previous: window(gscStart - 7 * DAY_MS, 7),
    },
  };
}
