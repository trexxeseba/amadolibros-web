// Bloqueo de corridas simultáneas: archivo creado en forma exclusiva (wx). Un lock
// más viejo que lockVenceMin (PC suspendida o proceso muerto) se reemplaza, y se avisa.
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, statSync } from 'node:fs';

export function tomarLock(ruta, { venceMin = 120, now = Date.now } = {}) {
  for (let intento = 0; intento < 2; intento++) {
    try {
      const fd = openSync(ruta, 'wx'); writeSync(fd, JSON.stringify({ pid: process.pid, desde: new Date(now()).toISOString() })); closeSync(fd);
      return { ok: true, reemplazado: intento > 0, soltar: () => { try { unlinkSync(ruta); } catch {} } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let edadMin = Infinity;
      try { edadMin = (now() - statSync(ruta).mtimeMs) / 60000; } catch {}
      if (edadMin < venceMin) { let quien = null; try { quien = JSON.parse(readFileSync(ruta, 'utf8')); } catch {} return { ok: false, motivo: 'otra corrida en curso', quien }; }
      try { unlinkSync(ruta); } catch {}
    }
  }
  return { ok: false, motivo: 'no se pudo tomar el lock' };
}
