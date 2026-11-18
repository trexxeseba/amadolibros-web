# Hermes: chequeo diario de fichas

Mira todos los días las 149 fichas de catálogo de HERMES_PROMOSML (Excel `data/hermes-top149-17-11.xlsx`),
registra el precio de Hermes y si sigue ofreciendo la ficha, y avisa por mail a adm@amadolibros.com:
fichas sin oferta de Hermes, publicaciones mías pausadas y cambios de precio de más del 5 %.

**Importante:** Mercado Libre no deja leer el stock ("N disponibles") de publicaciones ajenas. "Sin stock o pausada"
se detecta porque Hermes deja de ofrecer la ficha. El precio sí se lee.

## Cómo funciona
- Una ficha por vez, 500 ms de pausa entre consultas, con la API oficial (token de Amado Vintage leído de D1; no hay credenciales en el código).
- Historial: rama `hermes-datos`, archivo `historial.json` (fecha, ficha, precio, ofrece).
- Pausa solo si la ficha tiene un código en la columna **"Mi publicación (MLU)"** del Excel, la publicación es de Amado Vintage y está activa. Antes de pausar vuelve a leer la ficha. Si casi todas las fichas desaparecen de golpe (falla de lectura), no pausa nada.
- Nunca publica ni reactiva.

## Cómo correrlo
- Prueba (solo lee, registra y avisa): Actions > "Hermes chequeo diario" > Run workflow, con `real` sin tildar.
- Con pausas reales a mano: mismo botón con `real` tildado.
- Diario automático: pausa de verdad las publicaciones asignadas. Para que solo registre y avise, crear la variable del repo `HERMES_REAL` = `false` (Settings > Secrets and variables > Actions > Variables).
- Completar "Mi publicación (MLU)": en el Excel, columna I, un código por fila (por ejemplo MLU123456789).

## Cómo desactivarlo
- Frenar todo: variable del repo `HERMES_APAGADO` = `true`.
- Solo frenar las pausas: variable `HERMES_REAL` = `false`.
- Borrarlo del todo: eliminar `.github/workflows/hermes-chequeo.yml`.

Tests: `node --test functions/__tests__/hermes-monitor.test.js`.

## Publicar las fichas (Amado Vintage)
Actions > "Hermes publicar (Amado Vintage)": `validar` solo pregunta a Mercado Libre si sería válida, `publicar` crea las publicaciones
(1 unidad, a 1 % menos que el precio de Hermes, de a una con pausa). Lo publicado queda en la rama `hermes-datos` (`publicadas-vintage.json`)
y el chequeo diario lo toma solo para las pausas. No toca las que ya existen.

**Cuenta: siempre Amado Vintage.** El 18/11/2026 se publicaron por error 149 en Amado Libros; se pausaron las 149 (no se cerraron ni borraron) y el registro quedó en `publicadas-libros-error.json`. Un test exige que Hermes apunte a Vintage.

**Coordinación con la subida de SBS:** corre en tandas de 25 por hora (minuto :07, la de SBS es :37), se detiene si el vigía puso el freno, salta los ISBN bloqueados por denuncia y las editoriales del filtro de propiedad intelectual, y no pasa del techo diario de 300 contando lo que ya publicó SBS ese día.

## Libros de Arnoia (semana 45/2026)
`data/arnoia-semana-45.json`: 395 libros con el precio ya calculado (costo con IVA y descuento de Arnoia, cotización de venta del BROU, flete USD 16 por kilo, envío $230, comisión 17 % y escalones de ganancia de $500 a $2.000). Se publican por EAN en Vintage con 1 unidad y plazo "a demanda" de 20 días, de a 25 por hora (minuto :17), con los mismos candados y el mismo techo diario compartido con SBS y con Hermes. Los que no tienen ficha de catálogo se saltan y quedan anotados como `sin_catalogo` para verlos después.
