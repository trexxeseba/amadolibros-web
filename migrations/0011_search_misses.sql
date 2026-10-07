-- INFORME-ANALITICO: búsquedas del catálogo que no devolvieron nada, para el
-- bloque "demanda sin atender" del informe semanal. Se guarda sólo el texto
-- normalizado y un contador por día: nada de IP, usuario ni sesión. Las
-- consultas que parecen un correo o un teléfono no se guardan (ver
-- functions/_shared/search-misses.js).
CREATE TABLE IF NOT EXISTS search_misses (
  date        TEXT    NOT NULL,
  query       TEXT    NOT NULL CHECK (length(query) BETWEEN 1 AND 80),
  count       INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  first_seen  TEXT    NOT NULL,
  last_seen   TEXT    NOT NULL,
  PRIMARY KEY (date, query)
);
