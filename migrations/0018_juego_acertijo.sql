-- JUEGO-2: El Acertijo del Librero. Un intento por día y por número: el código del
-- acertijo (25 % y regalo si acierta; un premio de la Rueda como consuelo si falla)
-- se guarda en juego_codigos con origen 'acertijo'. Acierto = regalo no nulo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_juego_codigos_un_acertijo_diario
  ON juego_codigos (wa_hash, dia) WHERE origen = 'acertijo';
