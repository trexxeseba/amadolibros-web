-- Registro de la poda de anuncios de Mercado Ads (Amado Libros). El repo es público:
-- precios, gasto y clics viven sólo acá, nunca en archivos del repo ni en logs.
CREATE TABLE IF NOT EXISTS poda_registro(
  ad_group_id TEXT PRIMARY KEY, external_id TEXT, tipo TEXT, item_ids_json TEXT, titulo TEXT,
  campaign_id TEXT, campaign_nombre TEXT, estado TEXT NOT NULL, origen TEXT NOT NULL, motivo TEXT,
  precio REAL, precio_lista REAL, promo INTEGER, gasto REAL, clics INTEGER, cpc REAL, tope REAL, tope_clics INTEGER,
  fecha_propuesta TEXT, fecha_pausa TEXT, fecha_reactivar_propuesta TEXT, regla_reactivar INTEGER,
  contar_desde TEXT, fecha_reactivada TEXT, actualizado TEXT
);
CREATE TABLE IF NOT EXISTS poda_corridas(
  id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, accion TEXT NOT NULL, modo TEXT NOT NULL,
  contadores_json TEXT, detalle_json TEXT, creado_ms INTEGER NOT NULL
);
