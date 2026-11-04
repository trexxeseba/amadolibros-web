// Persistencia simple en archivos JSON dentro de HOME/state (fuera del repo):
//   historial.json  — por publicación: máximo observado desde que empieza el seguimiento
//   avisos.json     — huella de cada aviso ya mandado, para no repetir sin novedades
//   corridas.json   — métricas de cada corrida (tiempo, llamadas, errores)
//   observaciones/  — una foto compacta por corrida
//   lock            — evita ejecuciones simultáneas
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';

const file = name => join(STATE_DIR, name);
const readJson = (name, fallback) => { try { return JSON.parse(readFileSync(file(name), 'utf8')); } catch { return fallback; } };
const writeJson = (name, data) => { mkdirSync(STATE_DIR, { recursive: true }); const tmp = file(name + '.tmp'); writeFileSync(tmp, JSON.stringify(data)); writeFileSync(file(name), readFileSync(tmp)); unlinkSync(tmp); };

export function acquireLock({ staleMs = 90 * 60 * 1000 } = {}) {
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = file('lock');
  if (existsSync(lock)) {
    const age = Date.now() - statSync(lock).mtimeMs;
    if (age < staleMs) return false;
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  return true;
}
export function releaseLock() { try { unlinkSync(file('lock')); } catch { /* ya no está */ } }

export const loadHistorial = () => readJson('historial.json', {});
export function updateHistorial(items, fecha) {
  const h = loadHistorial();
  for (const it of items) {
    if (!Number.isFinite(it.precio)) continue;
    const prev = h[it.id];
    if (!prev) h[it.id] = { desde: fecha, max_precio: it.precio, max_fecha: fecha, ultimo_precio: it.precio };
    else {
      if (it.precio > prev.max_precio) { prev.max_precio = it.precio; prev.max_fecha = fecha; }
      prev.ultimo_precio = it.precio;
    }
  }
  writeJson('historial.json', h);
  return h;
}

export const loadAvisos = () => readJson('avisos.json', {});
export const saveAvisos = a => writeJson('avisos.json', a);

export function appendCorrida(metrics) {
  const list = readJson('corridas.json', []);
  list.push(metrics);
  writeJson('corridas.json', list.slice(-200));
}
export const corridas = () => readJson('corridas.json', []);

export function saveObservacion(id, data) {
  mkdirSync(join(STATE_DIR, 'observaciones'), { recursive: true });
  writeFileSync(join(STATE_DIR, 'observaciones', `${id}.json`), JSON.stringify(data));
  // Conservar las últimas 100 fotos.
  const dir = join(STATE_DIR, 'observaciones');
  const names = readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  for (const n of names.slice(0, Math.max(0, names.length - 100))) unlinkSync(join(dir, n));
}
