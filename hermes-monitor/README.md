# Hermes: chequeo diario de fichas

Mira todos los días las 149 fichas de catálogo de HERMES_PROMOSML (Excel `data/hermes-top149-17-11.xlsx`),
registra el precio de Hermes y si sigue ofreciendo la ficha, y avisa por mail a adm@amadolibros.com:
fichas sin oferta de Hermes, publicaciones mías pausadas y cambios de precio de más del 5 %.

**Importante:** Mercado Libre no deja leer el stock ("N disponibles") de publicaciones ajenas. "Sin stock o pausada"
se detecta porque Hermes deja de ofrecer la ficha. El precio sí se lee.

## Cómo funciona
- Una ficha por vez, 500 ms de pausa entre consultas, con la API oficial (token de Amado Libros leído de D1; no hay credenciales en el código).
- Historial: rama `hermes-datos`, archivo `historial.json` (fecha, ficha, precio, ofrece).
- Pausa solo si la ficha tiene un código en la columna **"Mi publicación (MLU)"** del Excel, la publicación es de Amado Libros y está activa. Antes de pausar vuelve a leer la ficha. Si casi todas las fichas desaparecen de golpe (falla de lectura), no pausa nada.
- Nunca publica ni reactiva.

## Cómo correrlo
- Prueba (solo lee, registra y avisa): Actions > "Hermes chequeo diario" > Run workflow, con `real` sin tildar.
- Con pausas reales a mano: mismo botón con `real` tildado.
- Diario automático: solo registra y avisa hasta que se cree la variable del repo `HERMES_REAL` = `true` (Settings > Secrets and variables > Actions > Variables).
- Completar "Mi publicación (MLU)": en el Excel, columna I, un código por fila (por ejemplo MLU123456789).

## Cómo desactivarlo
- Frenar todo: variable del repo `HERMES_APAGADO` = `true`.
- Solo frenar las pausas: borrar o poner en `false` la variable `HERMES_REAL`.
- Borrarlo del todo: eliminar `.github/workflows/hermes-chequeo.yml`.

Tests: `node --test functions/__tests__/hermes-monitor.test.js`.
