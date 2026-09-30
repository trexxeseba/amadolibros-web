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
