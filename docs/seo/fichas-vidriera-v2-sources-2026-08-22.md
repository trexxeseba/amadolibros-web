# FICHAS-VIDRIERA-2 — FUENTES-1

Fecha: 2026-08-22

## Objetivo

Preparar investigación bibliográfica real, reproducible y cacheada para alimentar el motor de evidencia de FICHAS-VIDRIERA-2. Este lote no genera contenido con IA, no modifica fichas y no toca Producción.

## Fuentes de este lote

### Google Books

Uso previsto: cobertura amplia por ISBN exacto.

Endpoint oficial de búsqueda de volumes:

`https://www.googleapis.com/books/v1/volumes?q=isbn:...`

Documentación oficial usada para este contrato:

`https://developers.google.com/books/docs/v1/using`

La documentación oficial permite identificar requests públicas con API key u OAuth 2.0 access token. El cliente admite ambos caminos:

- `GOOGLE_BOOKS_API_KEY`; o
- `accessToken`, enviado únicamente como `Authorization: Bearer ...` y nunca dentro de la URL.

Amado Libros ya usa Workload Identity Federation para otros workflows Google. Antes de crear otro secreto, RESEARCH-RUN-1 debe intentar reutilizar ese mecanismo con un token OAuth adecuado para Books. Ninguna credencial se guarda en la caché.

Campos útiles cuando el volume contiene exactamente el ISBN pedido:

- título;
- autores;
- descripción;
- editorial;
- páginas;
- idioma;
- fecha/año de publicación;
- categorías/temas;
- identificadores.

Una respuesta de búsqueda que no contiene el ISBN exacto en `industryIdentifiers` se descarta, aunque el título parezca coincidir.

### Open Library

Uso previsto: segunda verificación de bajo volumen sobre la cohorte prioritaria, no backend masivo.

Política/API consultada:

`https://openlibrary.org/developers/api`

Open Library declara expresamente que su Web API es para usos de bajo volumen y que para bulk deben usarse dumps. También pide caché y un `User-Agent` identificable con contacto cuando se realizan requests frecuentes.

Por eso este lote:

- usa requests multi-ISBN del Partner/Read API para reducir llamadas;
- limita cada request a 20 ISBN;
- fija un presupuesto por defecto de sólo 25 ISBN por corrida;
- exige `User-Agent` + contacto;
- cachea Open Library durante 180 días;
- deja la ingestión de dumps para un lote posterior si necesitamos enriquecer miles con esta fuente.

## Caché

TTL inicial:

- Google Books: 90 días;
- Open Library: 180 días.

La caché se guarda fuera del repositorio en:

`scripts/seo/data/book-intelligence/`

`.gitignore` impide versionarla. El artefacto de evidencia final sí podrá versionarse más adelante, pero nunca API keys, access tokens ni otros secretos.

## Priorización

El planner ordena primero por:

1. `priority_score`;
2. impresiones GSC;
3. clics GSC;
4. ID estable como desempate.

Deduplica por ISBN antes de consumir presupuesto. Si dos publicaciones comparten ISBN, sólo se investiga una vez y el resultado de evidencia puede reutilizarse para la edición compatible.

## Seguridad de identidad

Google Books:

- la búsqueda se hace por `isbn:`;
- el parser vuelve a exigir que `industryIdentifiers` incluya exactamente el ISBN normalizado.

Open Library:

- sólo se conservan records cuyo listado de ISBN contiene exactamente uno de los ISBN solicitados;
- los datos devueltos siguen siendo evidencia, no verdad absoluta;
- el motor de #217 aplica después los gates de conflicto de identidad y edición.

## Política de errores

Una caída de una fuente no genera contenido vacío ni falso.

El caller debe registrar el error en caché junto con `fetched_at` y decidir cuándo reintentar. La ausencia de match es un dato de investigación, no motivo para inventar información.

## Qué permite este lote

Una vez conectado a una fuente de catálogo real, podremos producir paquetes como:

```json
{
  "isbn": "978...",
  "google_books": [{ "source": "google_books", "...": "..." }],
  "open_library": [{ "source": "open_library", "...": "..." }]
}
```

Esos records se pasan al clasificador de evidencia de #217 para obtener `green/yellow/red`.

## Siguiente lote

`FICHAS-VIDRIERA-2 / RESEARCH-RUN-1`:

1. seleccionar una cohorte real desde GSC + catálogo;
2. autenticar Google Books reutilizando WIF/OAuth si el proyecto lo admite; fallback a API key sólo si hace falta;
3. ejecutar Google Books con caché;
4. usar Open Library sólo dentro del presupuesto permitido;
5. medir cuántas fichas quedan green/yellow/red;
6. decidir qué tercera fuente aumenta más la cobertura (editorial, distribuidor, bibliotecas o dump de Open Library);
7. todavía sin publicar texto en la web.

## Fuera de alcance

- llamadas de red desde CI;
- API de IA;
- renderer visible;
- copy de fichas por encargo;
- galerías/promocionales;
- canonical, sitemap o robots;
- Production.
