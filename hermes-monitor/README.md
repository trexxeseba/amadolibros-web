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

**Coordinación con la subida de SBS:** corre en tandas de 25 por hora (minuto :07, la de SBS es :37), se detiene si el vigía puso el freno, salta los ISBN bloqueados por denuncia y las editoriales del filtro de propiedad intelectual, y no pasa del techo diario total de 1.000 contando lo que ya publicó SBS ese día (SBS 650 + Hermes y Arnoia hasta 350).

## Libros de Arnoia (semana 45/2026)
`data/arnoia-semana-45.json`: 395 libros con el precio ya calculado (costo con IVA y descuento de Arnoia, cotización de venta del BROU, flete USD 16 por kilo, envío $230, comisión 17 % y escalones de ganancia de $500 a $2.000). Se publican por EAN en Vintage con 1 unidad y plazo "a demanda" de 20 días, de a 25 por hora (minuto :17), con los mismos candados y el mismo techo diario compartido con SBS y con Hermes (total 1.000 por día). Los que no tienen ficha de catálogo se saltan y quedan anotados como `sin_catalogo` para verlos después.

## Techo diario: 3.000 (20/11/2026; antes 2.500; meta 4.000 si en 48 horas no hay denuncias)
Reparto: SBS hasta 1.000 por día (45 por hora), Arnoia hasta 1.700 (70 por hora, las 24 horas, al minuto :17) y Hermes hasta 300 (25 por hora de 09:07 a 15:07); la suma nunca pasa de 3.000 y cada publicador mira lo ya publicado ese día antes de crear. Arnoia usa el catálogo nuevo (`data/arnoia-catalogo-19-11.json`, costo neto real): ficha de catálogo si existe y, si no, publicación normal con portada (`--ambos`). Primero los de más ventas del mercado, después las ediciones más nuevas.

## Guardián (`scripts/guardian/guardian.mjs`)
Cada 15 minutos (lo lanza el Worker; el cron de GitHub queda de respaldo) mira si algo puede salir mal y avisa por mail en lenguaje simple.
- **Detecta:** tanda de Arnoia que no corre a su hora (con cupo y libros pendientes), SBS sin corridas buenas o con 3 fallas seguidas, corridas caídas de la tanda o del despliegue del Worker, publicaciones recientes que Mercado Libre pausó o cerró (posible denuncia), fotos que no terminan de cargar en 3 horas y el freno del vigía puesto.
- **Arregla solo, y nada más que esto:** pedir de nuevo una tanda de Hermes/Arnoia o de SBS que no corrió, reintentar UNA vez una corrida caída y cancelar una tanda colgada (más de 40 minutos en curso).
- **Elimina solo, y únicamente esto (autorizado por Seba el 21/11/2026):** publicaciones de Vintage que Mercado Libre dejó en revisión por "etiquetas de Mercado Libre" en una foto (falsa alarma habitual con tapas limpias). Máximo 10 por corrida; si hay más, no borra y avisa. Solo cierra o elimina, nunca una activa (`scripts/guardian/eliminar.mjs`). Lo cuenta en el mail.
- **Nunca:** suelta el freno, reactiva publicaciones, cambia precios, borra por otro motivo (denuncias, propiedad intelectual, fotos con texto) ni toca Amado Libros (un test lo exige).
- **Avisos:** no repite el mismo aviso (3 h; 1 h si es grave). Si hace falta que decidas, el mail trae 3 opciones.
- **Probarlo sin riesgo:** Actions > "Guardián de las publicaciones de Vintage" > Run workflow con `seco` tildado.
- **Apagarlo:** variable del repo `HERMES_APAGADO` = `true` (apaga también las tandas).

## Control de tapas (publicación normal de Arnoia)
Desde el 19/11/2026 cada tapa pasa por un lector de texto (tesseract) antes de usarse: si trae una dirección web, una @, una red social, un teléfono o una etiqueta de Mercado Libre, el libro se salta y queda anotado (`portada_rechazada`) para no reintentarlo cada hora. Si el lector no está disponible, la tapa no se usa (ante la duda, no se publica). Si la tapa trae un texto no permitido (dirección web, @, red social, teléfono, domicilio o CUIT del importador, etiqueta de Mercado Libre), `limpiar_tapa.py` lo borra solo si está sobre un FONDO LISO (lector con posiciones + relleno con el color del entorno; si menos del 85 % del entorno es del mismo color, hay dibujo y no se toca), vuelve a comprobar que quedó limpia, sube la tapa limpia a Mercado Libre y publica con esa foto. Si el fondo tiene dibujo, hay un código QR o no queda limpia (por ejemplo, un desplegable de caja), el libro se salta. Una @ suelta o un número corto no cuentan (suelen ser ruido de la ilustración). Series vetadas por el control de fotos de Mercado Libre: `data/portadas-vetadas.json` (hoy, Arcolores). Las publicaciones de ficha de catálogo usan las fotos oficiales de Mercado Libre y no pasan por esto.

**Topes de la tanda:** el publicador mira como mucho 4 veces el máximo pedido de libros y corta a los 25 minutos; el workflow tiene un tope de 40 minutos. (El 19/11/2026 una tanda en modo solo catálogo recorrió la lista entera durante casi una hora.)
