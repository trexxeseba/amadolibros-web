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
   `agentes-ml-sondeo.yml` (manual). Resultado y diferencias con la
   documentación en `ENDPOINTS.md`.
2. Guardas con tests: `src/guardas.mjs` y `config/exclusiones.json` (lista manual y
   palabras de libros médicos, editables). Cubren todas las reglas de Seba; ver el
   encabezado del módulo. Toda escritura de los jobs pasa por `evaluarEscritura`.
3. Job A, promociones por título: `src/promos.mjs` (lógica pura en
   `src/promos-logica.mjs`), workflow `agentes-ml-promos.yml` (manual). Acciones:
   `estado`, `sumar`, `sacar`, `seleccion` (títulos con ventas y visitas) y
   `ads-gasto` (gasto del mes contra el tope, sólo lectura). Modo real sólo desde
   main; después de cada escritura se relee `sale_price` y si el visible pasa del
   16 % se saca el ítem. Primera corrida real: Gold Foil Tarot en Amado 15
   (Seba, 11/11/2026).
4. Job B (medición completa de Ads) y la corrida automática diaria: pendientes.

## Decisiones de Seba del 11/11/2026 (fila `direccion|decisiones-seba-2026-11-11`)

- Tope de publicidad: $20.000 por mes calendario (`LIMITES.adsMensualMaxUyu`).
- Reparto: Code toma por API las promociones por título, la selección de 50
  títulos con ventas y visitas y la lectura del gasto de Ads. El agente único de
  Cowork sigue con cupones, Ads por navegador y el aviso a Seba.
- Se mantiene la regla de cero escritura en Ads por API.
- Lo hecho se registra en la mesa Propuestas (Rama "Promos y cupones", Tarea
  "Agente Code", Tipo Hecho o Error). Code no pone filas en Aprobada ni Rechazada.

## Modos de escritura

| Modo | Mercado Libre | Airtable |
| --- | --- | --- |
| `solo_lectura` (`AGENTES_ML_SOLO_LECTURA=true`, interruptor general) | no se escribe nunca | informes sí |
| `prueba` (default; `AGENTES_ML_DRY_RUN=true` lo fuerza) | no se toca | filas con prefijo "[PRUEBA]" |
| `real` (`AGENTES_ML_MODO=real`) | se escribe, pasando las guardas | filas normales |

Supuestos a confirmar por Seba (marcados en `guardas.mjs`): ítems sin catálogo
entran como candidatos; relámpago compartido solo si lo que pone el vendedor es
15 % o menos; el cupón del tope de $750 sale de la API, después de Airtable y por
último $500. La detección de libros médicos es por palabras del título: la primera
prueba de 5 días lista lo que excluye para ajustarla.
