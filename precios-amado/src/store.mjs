// Persistencia simple en archivos JSON dentro de HOME/state (fuera del repo):
//   historial.json  — por publicación: máximo observado desde que empieza el seguimiento
//   avisos.json     — huella de cada aviso ya mandado, para no repetir sin novedades
//   corridas.json   — métricas de cada corrida (tiempo, llamadas, errores)
//   observaciones/  — una foto compacta por corrida
//   lock            — evita ejecuciones simultáneas en la misma máquina
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.mjs';

const file = name => join(STATE_DIR, name);
const readJson = (name, fallback) => { try { return JSON.parse(readFileSync(file(name), 'utf8')); } catch { return fallback; } };
// Escritura atómica: archivo temporal y rename.
const writeJson = (name, data) => { mkdirSync(STATE_DIR, { recursive: true }); const tmp = file(`${name}.${process.pid}.tmp`); writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, file(name)); };

const lockFile = () => file('lock');
export function acquireLock({ staleMs = 90 * 60 * 1000 } = {}) {
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = lockFile();
  if (existsSync(lock)) {
    let age = 0, vivo = true;
    try { age = Date.now() - statSync(lock).mtimeMs; } catch { /* lo borró otro */ }
    // El dueño del lock ya no existe (corrida cortada): se puede tomar.
    try { const pid = Number(readFileSync(lock, 'utf8')); if (pid > 0) process.kill(pid, 0); } catch (e) { if (e?.code === 'ESRCH') vivo = false; }
    if (vivo && age < staleMs) return false;
    try { unlinkSync(lock); } catch { /* ya no está */ }
  }
  // 'wx' falla si otro proceso lo creó entre la verificación y la escritura.
  try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch { return false; }
}
let tengoLock = false;
export function lock(opts) { tengoLock = acquireLock(opts); return tengoLock; }
// Sólo se borra el lock propio.
export function releaseLock() {
  if (!tengoLock) return;
  try { if (readFileSync(lockFile(), 'utf8') === String(process.pid)) unlinkSync(lockFile()); } catch { /* ya no está */ }
  tengoLock = false;
}

export const loadHistorial = () => readJson('historial.json', {});
// Calcula el historial actualizado; sólo se guarda si `guardar`.
export function updateHistorial(items, fecha, { guardar = true } = {}) {
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
  if (guardar) writeJson('historial.json', h);
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
  const dir = join(STATE_DIR, 'observaciones');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(data));
  // Conservar las últimas 100 fotos.
  const names = readdirSync(dir).filter(n => n.endsWith('.json')).sort();
  for (const n of names.slice(0, Math.max(0, names.length - 100))) unlinkSync(join(dir, n));
}
