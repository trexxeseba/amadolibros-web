// Estado del motor en SQLite (node:sqlite, sin dependencias). CSV sólo como exportación.
import { DatabaseSync } from 'node:sqlite';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS items (
  item_id TEXT PRIMARY KEY,
  precio_base REAL NOT NULL,            -- precio base aprobado: no se reemplaza en cada baja
  base_fuente TEXT NOT NULL,            -- 'primera_baja' | 'aprobado_manual'
  base_registrada_en TEXT NOT NULL,
  precio_anterior REAL,
  ultimo_aplicado REAL NOT NULL,
  ultimo_aplicado_en TEXT NOT NULL,
  sin_competencia_consecutivas INTEGER NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'gestionado',  -- gestionado | detenido | liberado
  motivo_estado TEXT
);
CREATE TABLE IF NOT EXISTS corridas (
  id TEXT PRIMARY KEY, inicio TEXT NOT NULL, fin TEXT, modo TEXT NOT NULL,
  franja TEXT, resultado TEXT, revisadas INTEGER, cambios INTEGER, fallos INTEGER, detalle TEXT
);
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, corrida_id TEXT NOT NULL, item_id TEXT NOT NULL, fecha TEXT NOT NULL,
  modo TEXT NOT NULL, accion TEXT NOT NULL, motivo TEXT, precio_actual REAL, precio_base REAL,
  competidor_item TEXT, competidor_precio REAL, fuente TEXT, diferencia REAL, objetivo REAL,
  piso REAL, limite_pct REAL, limite_uyu REAL, desc_acum_uyu REAL, desc_acum_pct REAL, resultado TEXT
);
CREATE TABLE IF NOT EXISTS franjas_omitidas (franja TEXT PRIMARY KEY, detectada_en TEXT NOT NULL, avisada INTEGER NOT NULL DEFAULT 0);
`;

export function abrirEstado(ruta) {
  const db = new DatabaseSync(ruta);
  db.exec('PRAGMA journal_mode=WAL;'); db.exec(ESQUEMA);
  const q = sql => db.prepare(sql);
  return {
    db,
    gestion: id => q("SELECT * FROM items WHERE item_id=? AND estado='gestionado'").get(id) ?? null,
    gestionadas: () => q("SELECT * FROM items WHERE estado='gestionado'").all(),
    // Primera baja: el precio que tenía antes queda como base aprobada.
    registrarAplicado(id, { precioAnterior, aplicado, fecha }) {
      const f = q('SELECT * FROM items WHERE item_id=?').get(id);
      if (!f) q("INSERT INTO items(item_id,precio_base,base_fuente,base_registrada_en,precio_anterior,ultimo_aplicado,ultimo_aplicado_en) VALUES(?,?,?,?,?,?,?)").run(id, precioAnterior, 'primera_baja', fecha, precioAnterior, aplicado, fecha);
      else q("UPDATE items SET precio_anterior=?, ultimo_aplicado=?, ultimo_aplicado_en=?, sin_competencia_consecutivas=0, estado='gestionado', motivo_estado=NULL WHERE item_id=?").run(precioAnterior, aplicado, fecha, id);
    },
    contarSinCompetencia(id, n) { q('UPDATE items SET sin_competencia_consecutivas=? WHERE item_id=?').run(n, id); },
    detener(id, motivo) { q("UPDATE items SET estado='detenido', motivo_estado=? WHERE item_id=?").run(motivo, id); },
    liberar(id, motivo) { q("UPDATE items SET estado='liberado', motivo_estado=? WHERE item_id=?").run(motivo, id); },
    iniciarCorrida(c) { q('INSERT INTO corridas(id,inicio,modo,franja) VALUES(?,?,?,?)').run(c.id, c.inicio, c.modo, c.franja ?? null); },
    cerrarCorrida(c) { q('UPDATE corridas SET fin=?, resultado=?, revisadas=?, cambios=?, fallos=?, detalle=? WHERE id=?').run(c.fin, c.resultado, c.revisadas, c.cambios, c.fallos, c.detalle ?? null, c.id); },
    ultimaCorrida: () => q("SELECT * FROM corridas WHERE resultado IS NOT NULL ORDER BY inicio DESC LIMIT 1").get() ?? null,
    evento(e) {
      q(`INSERT INTO eventos(corrida_id,item_id,fecha,modo,accion,motivo,precio_actual,precio_base,competidor_item,competidor_precio,fuente,diferencia,objetivo,piso,limite_pct,limite_uyu,desc_acum_uyu,desc_acum_pct,resultado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(e.corrida_id, e.item_id, e.fecha, e.modo, e.accion, e.motivo ?? null, e.precio_actual ?? null, e.precio_base ?? null, e.competidor_item ?? null, e.competidor_precio ?? null, e.fuente ?? null, e.diferencia ?? null, e.objetivo ?? null, e.piso ?? null, e.limite_pct ?? null, e.limite_uyu ?? null, e.desc_acum_uyu ?? null, e.desc_acum_pct ?? null, e.resultado ?? null);
    },
    franjaOmitida(franja, fecha) { q('INSERT OR IGNORE INTO franjas_omitidas(franja,detectada_en) VALUES(?,?)').run(franja, fecha); },
    franjasSinAvisar: () => q('SELECT franja FROM franjas_omitidas WHERE avisada=0').all().map(r => r.franja),
    marcarAvisadas(fs) { for (const f of fs) q('UPDATE franjas_omitidas SET avisada=1 WHERE franja=?').run(f); },
    cerrar() { db.close(); },
  };
}
