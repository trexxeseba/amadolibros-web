# Agentes diarios de Mercado Libre (Amado Libros) en la nube

Pasa a código determinista, sin LLM, la parte automatizable de las tareas diarias
de Mercado Libre de Amado Libros (seller de `precio-ganador/src/config.mjs`,
cuenta `libros`):

- **Job A, Promociones** (05:30 de Montevideo): lee y escribe promociones por la
  API `seller-promotions` (v2). Todo pasa por las guardas.
- **Job B, Medición de Product Ads** (10:30, después de la actualización de las
  10:00): solo lectura. Deja en Airtable el informe y las listas "a pausar" y
  "a agregar a Ganadoras"; la tarea de navegador del día siguiente ejecuta.

No se migran cupones (API solo para Brasil), el canal de difusión (sin API) ni
pausar o agregar anuncios (sin endpoints de escritura documentados).

## Dónde corre y por qué

GitHub Actions, con el Worker de Cloudflare como disparador puntual (el cron de
GitHub se atrasa horas; el Worker ya hace esto con Precio Ganador en
`worker-sync/precio-ganador-trigger.js`). Motivos frente a un cron del Worker:

- Volumen: recorrer las ~6.700 publicaciones activas (scan + `/items/bulk`) y
  consultar `price_to_win` por candidato son miles de llamadas por corrida; un
  Worker tiene tope de subrequests por invocación y de CPU.
- El patrón ya existe y está probado a diario: token de Mercado Libre leído de D1
  `ml_oauth` (lo renueva el Worker con lock y compare-and-swap, ver
  `worker-sync/meli-auth.js`), tests antes de cada corrida, alarma por mail,
  `workflow_dispatch` para correr a mano y en prueba.
- Secretos: Cloudflare y Resend ya están en Actions; falta solo el token de
  Airtable.

El repo y los logs son públicos: los logs llevan formas y códigos, nunca montos
de ventas, visitas, métricas de publicidad ni datos de otros vendedores. El
detalle va a Airtable.

## Estado

1. Sondeo de solo lectura de cada endpoint: `src/sondeo.mjs`, workflow
   `agentes-ml-sondeo.yml` (manual).
2. Guardas con tests, Job B, Job A en prueba: pendientes (un PR por paso).
