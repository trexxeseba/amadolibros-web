// Piso rentable por publicación. Lee datos/costos.csv (local, nunca en el repo):
//   item_id,costo_uyu,envio_uyu
// costo_uyu = costo del libro puesto en Uruguay. envio_uyu = envío a cargo de Amado
// (vacío = usar el de datos/piso.json). Parámetros generales en datos/piso.json:
//   { "comisionPct": 0.xx, "cargoFijoUyu": n, "envioUyu": n, "margenMinPct": 0.xx }
// Si falta cualquier dato el piso es null: la publicación no se modifica.
import { readFileSync, existsSync } from 'node:fs';
import { PISO_DEFECTO } from '../config.mjs';

const num = v => (v === null || v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v))) ? null : Number(v);

export function calcularPiso({ costo, envio, cargoFijo, comisionPct, margenMinPct }) {
  if ([costo, envio, cargoFijo, comisionPct, margenMinPct].some(v => num(v) === null)) return null;
  const den = 1 - comisionPct - margenMinPct;
  if (costo <= 0 || den <= 0 || den >= 1) return null;
  return Math.ceil((costo + envio + cargoFijo) / den - 1e-9);
}

export function cargarPisos(dir) {
  const parametros = { ...PISO_DEFECTO, ...(existsSync(`${dir}/piso.json`) ? JSON.parse(readFileSync(`${dir}/piso.json`, 'utf8')) : {}) };
  const costos = new Map();
  if (existsSync(`${dir}/costos.csv`)) {
    const lineas = readFileSync(`${dir}/costos.csv`, 'utf8').split(/\r?\n/).filter(Boolean);
    const cab = lineas.shift().split(',').map(s => s.trim().toLowerCase());
    for (const l of lineas) {
      const c = l.split(','); const fila = Object.fromEntries(cab.map((k, i) => [k, c[i]?.trim()]));
      if (fila.item_id) costos.set(fila.item_id, { costo: num(fila.costo_uyu), envio: num(fila.envio_uyu) });
    }
  }
  return {
    parametros, cantidadCostos: costos.size,
    pisoDe(itemId) {
      const c = costos.get(itemId); if (!c) return null;
      return calcularPiso({ costo: c.costo, envio: c.envio ?? num(parametros.envioUyu), cargoFijo: num(parametros.cargoFijoUyu), comisionPct: num(parametros.comisionPct), margenMinPct: num(parametros.margenMinPct) });
    },
  };
}
