-- GW1: Radar de Demanda No Satisfecha.
-- Registra el TEXTO de búsqueda (público, ya visible en la URL de
-- /catalogo?q= y en Search Console) cuando no matchea ningún libro real —
-- ni activo ni por encargo. No guarda IP, user-agent, ni ningún dato del
-- formulario de /pedir-libro (ese formulario sigue sin persistir nada,
-- promesa de privacidad intacta). Sirve para decidir qué conseguir a
-- continuación, no para identificar personas.

CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_query TEXT NOT NULL UNIQUE,
  raw_query TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catalogo_search','autocomplete','reading_list')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demand_radar_unmatched_queries_last_seen
  ON demand_radar_unmatched_queries (last_seen_at);
