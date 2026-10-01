# Biblio: exportación completa desde Cloudflare/R2

Decisión operativa: Biblio se alimenta desde el snapshot público del catálogo en R2, no desde carga manual.

Fuente primaria:
- `https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json`

Ese archivo es el catálogo activo que usa la web. El exportador genera un TXT tab-delimited apto para carga masiva de Biblio.

## Archivos generados

Al ejecutar el workflow `Biblio full catalog export` se generan estos archivos como artifact:

- `biblio-amado-full.txt`: archivo principal para Biblio.
- `biblio-rejected.txt`: registros descartados con motivo.
- `biblio-isbn-duplicates.txt`: ISBN repetidos por varios SKU.
- `biblio-summary.json`: resumen de conteos y fórmula de precios.

## Campos enviados

El archivo principal contiene:

- Book ID
- Status (A=add)
- Price
- Currency
- Author
- Title
- Description
- Book Condition
- Publisher
- Publication Date
- ISBN
- Binding
- Quantity
- Language
- Image URL
- Catalog
- Keywords

El `Book ID` es el SKU estable de Mercado Libre (`MLU...`). No se cambia salvo que cambie el origen.

Reglas de datos de la primera carga:

- `Publisher`: si el catálogo trae `AMADO LIBROS` (el vendedor, no una editorial) o `Genérica` / `Genérico` (placeholder de marca de Mercado Libre), queda vacío. La comparación ignora mayúsculas y acentos. La línea `Editorial:` de `Description` sigue la misma regla. No se inventa editorial sustituta.
- `Binding`: `Hardcover` o `Softcover` solo cuando el título o la descripción de la ficha lo dicen de forma explícita (tapa dura, cartoné, tapa blanda, rústica). Los valores del catálogo (`Papel`, `Físico`, `Vinilo`, `CD`) no se usan. Sin dato explícito, queda vacío; sin inferencia por idioma, categoría ni precio.
- `Title`: se prefiere `showcase_display_title` (mayúsculas corregidas); se quitan el prefijo "Libro" / "Libro -" y el sufijo "- Usado" propios del buscador de Mercado Libre.
- `Author`: si viene todo en mayúsculas, se capitaliza. Sin autor, `Unknown`.
- Usados: la ficha técnica cierra con la frase de estado que trae la propia descripción (`Estado del ejemplar: ...`); si no la hay, "Ejemplar usado; ver fotografías". Nunca se afirma un estado que la ficha no diga.
- Mazos de tarot, cartas y oráculos se exportan junto con los libros. Toda ficha del dominio `MLU-TAROT_CARDS` entra aunque no traiga autor, ISBN ni datos bibliográficos; no se filtra por título ni por tags. Un mazo publicado en otro dominio de Mercado Libre se corrige recategorizando la ficha allá.
- Un libro, una fila: Mercado Libre trae cada libro dos veces (publicación propia y publicación de catálogo, con el mismo stock). Si un ISBN tiene publicación propia, la de catálogo va a `biblio-rejected.txt` con `duplicate_isbn_catalog_listing`. Los ISBN repetidos entre publicaciones propias no se tocan y quedan en `biblio-isbn-duplicates.txt` para revisión manual.
- `Publication Date`: sale del atributo bibliográfico "Año de publicación" de la ficha (`bibliographic.publication_year`), solo si es un año plausible (1450 a año actual + 1). Nunca de la fecha de alta del aviso en Mercado Libre (`start_time`), que era el dato falso de las primeras corridas. Sin año real, queda vacío.
- `Description`: texto de la ficha de Mercado Libre (sinopsis, reseña) más una ficha técnica al final (autor, editorial, colección, año, idioma, medidas, materia, ISBN, estado, referencia). Del texto de Mercado Libre se quitan las líneas para el comprador uruguayo: envíos, retiro, WhatsApp, teléfonos, "por encargo", cierre de marca, precios, plazos. Si no queda texto útil, va título más ficha técnica.
- Datos verificados por ISBN: el exportador lee el registro de hechos bibliográficos del sitio (`functions/_shared/book-enrichment-facts-*.js`, verificados en BNE y otras bibliotecas nacionales) y completa páginas, editorial y año cuando la ficha de Mercado Libre no los trae, y suma las materias a `Keywords`.
- `Keywords`: autor, editorial, materia, colección, materias verificadas, idioma, ISBN y marca.
- Sin fuente en el proyecto, quedan vacíos: peso, lugar de publicación, edición, ilustrador y la encuadernación de las fichas que no la mencionan.
- `scripts/biblio/skip-skus.txt`: SKUs ya cargados a mano en Biblio con datos curados. El exportador los rechaza con `already_in_biblio` para que una carga masiva no los pise. La otra publicación del mismo ISBN se rechaza con `already_in_biblio_isbn` para no duplicar el libro.
- Música, video y juegos de mesa quedan fuera siempre, por dominio de Mercado Libre (`MUSIC_ALBUMS`, `ANTIQUE_MUSIC_ALBUMS`, `MUSIC_MOVIES_AND_TV_SERIES`, `PHYSICAL_MOVIES`, `BOARD_AND_CARD_GAMES`): van a `biblio-rejected.txt` con `non_book_domain`, aunque tengan ISBN. `include_non_books` no los reincorpora. Las revistas (`MAGAZINES`) y los mazos (`TAROT_CARDS`) siguen entrando.
- El escritor TSV limpia tab, CR, LF, caracteres de control y separadores Unicode de línea en todas las celdas, y verifica que cada línea tenga exactamente las columnas del header. Si una línea no cumple, el script falla y el workflow no sube nada.

## Precio

Fórmula:

```text
precio_USD = max(precio_minimo_USD, precio_UYU / UYU_por_USD * markup)
```

Defaults del workflow:

```text
UYU_por_USD = 42
markup = 1.30
precio_minimo_USD = 12
```

Esto se puede ajustar al ejecutar el workflow sin tocar código.

## FTP

El workflow puede funcionar en tres modos:

- `artifact_only`: genera el archivo y no sube nada.
- `ftp_upload`: genera y sube el archivo normal por FTP.
- `ftp_purge_replace`: genera y sube el archivo con `purge` en el nombre para reemplazo completo.

Para subir por FTP se requieren estos secrets de GitHub:

```text
BIBLIO_FTP_USERNAME
BIBLIO_FTP_PASSWORD
```

Variable opcional:

```text
BIBLIO_FTP_HOST = ftp.biblio.com
```

Si la variable no está, el workflow usa `ftp.biblio.com`.

## Pausados / por encargo

El exportador detecta el manifest de producción de pausados, pero no los exporta al archivo de Biblio porque esos registros no traen precio publicable. Los reporta en `biblio-summary.json`.

## Primer uso

Para una primera carga real en Biblio, correr primero `artifact_only`, revisar `biblio-summary.json` y `biblio-rejected.txt`, y luego correr `ftp_upload`.

Cuando Biblio ya tenga el formato mapeado, el modo normal para mantener inventario sincronizado es `ftp_purge_replace`.
