-- GW1: Radar de Demanda No Satisfecha.
-- Registra el TEXTO de búsqueda (público, ya visible en la URL de
-- /catalogo?q= y en Search Console) cuando no matchea ningún libro real —
-- ni activo ni por encargo. No guarda IP, user-agent, ni ningún dato del
-- formulario de /pedir-libro (ese formulario sigue sin persistir nada,
-- promesa de privacidad intacta). Sirve para decidir qué conseguir a
-- continuación, no para identificar personas.
--
-- Clave (normalized_query, source), no normalized_query sola: la misma
-- palabra buscada en /catalogo?q= y pegada en una lista de GW2 son señales
-- de calidad distinta — mezclarlas en una sola fila destruiría la
-- atribución de origen. 'autocomplete' no es una fuente válida: capturaría
-- fragmentos mientras la persona todavía está tipeando, no demanda real.

CREATE TABLE IF NOT EXISTS demand_radar_unmatched_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_query TEXT NOT NULL,
  raw_query TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catalogo_search','reading_list')),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (normalized_query, source)
);

CREATE INDEX IF NOT EXISTS idx_demand_radar_unmatched_queries_last_seen
  ON demand_radar_unmatched_queries (last_seen_at);
