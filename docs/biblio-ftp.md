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
- `Binding`: vacío en todas las filas. Los valores del catálogo (`Papel`, `Físico`, `Vinilo`, `CD`) no son encuadernaciones reales. `Description` no incluye la línea `Encuadernación/formato:` mientras `Binding` esté vacío. El mapeo a Hardcover/Softcover queda para una carga posterior, sin inferencia.
- Mazos de tarot, cartas y oráculos se exportan junto con los libros. Si alguno queda en `biblio-rejected.txt` con `not_book_signal`, se vuelve a correr con `include_non_books: true`; no se filtra por título ni por tags.
- `Publication Date`: queda vacío. El catálogo no trae el año del libro; el valor que se usaba antes salía de la fecha de publicación del aviso en Mercado Libre (2020 a 2026) y era falso. La línea `Fecha/año:` de `Description` sigue la misma regla.
- `scripts/biblio/skip-skus.txt`: SKUs ya cargados a mano en Biblio con datos curados. El exportador los rechaza con `already_in_biblio` para que una carga masiva no los pise.
- Música y video quedan fuera siempre, por dominio de Mercado Libre (`MUSIC_ALBUMS`, `ANTIQUE_MUSIC_ALBUMS`, `MUSIC_MOVIES_AND_TV_SERIES`, `PHYSICAL_MOVIES`): van a `biblio-rejected.txt` con `non_book_domain`, aunque tengan ISBN. `include_non_books` no los reincorpora. Las revistas (`MAGAZINES`) y los mazos (`TAROT_CARDS`, `BOARD_AND_CARD_GAMES`) siguen entrando.
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
