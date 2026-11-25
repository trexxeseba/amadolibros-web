# Estado de Mercado Libre — Amado Libros (seller 440298103)

Única fuente de verdad de la operación de Mercado Libre de Amado Libros. Todo cambio y todo informe sale de acá.

Reglas de este archivo:
- El repo es público: acá van solo estados, conteos y fechas. Precios por publicación, competidores y el antes/después de cada cambio van al registro privado (`C:/Users/cgnso/amadolibros-operador/`, fuera del repo).
- "Programado", "pendiente" o "en plan" no es hecho. Hecho = verificado por API después del cambio.
- Prioridad fija: 1) avisos de riesgo de cuenta, 2) precios, 3) cupones y promos, 4) atributos, 5) reposición, 6) el resto. Un frente por vez.
- Si un número cambia respecto del informe anterior, se explica en una línea.

Última actualización: 25/11/2026 19:30 (Montevideo).

## Números del día

| Número | 25/11 | Fuente | Variación |
|---|---|---|---|
| Para competir | 6 | Pantalla Publicaciones de ML | Primera medición en este archivo (a la mañana eran 4: entraron 2) |
| Sin stock | 276 | Pantalla Publicaciones de ML | Primera medición |
| Fichas con faltantes | 4.134 | Lectura por API del 24/11 | Primera medición; ML muestra 5.936 "objetivos de calidad" (ver frente 4) |
| Gasto de Ads del mes | 40–45 % de 60.000 = entre 24.000 y 27.000 | API, acción ads-gasto, 25/11 | Primera medición |

## Frentes abiertos

| # | Frente | Estado real verificado | Próximo paso | Quién destraba | Fecha |
|---|---|---|---|---|---|
| 1 | Avisos de riesgo de cuenta | No hay rutina que los lea. Seba no eligió la rutina B (25/11) | Ninguno hasta que Seba la pida | Seba | 25/11 |
| 2a | Precios: para competir | 6 en pantalla. Precio Ganador corre solo cada 2 horas en modo real y el paso que cambia precios termina bien. Desde el 24/11 cada corrida figuraba fallida porque la auditoría se caía con el 403 de ML; se arregla para que no la tumbe | Verificar la primera corrida en verde | Claude | 26/11 |
| 2b | Precios: sin catálogo | Lista de las 400 más vistas armada. Revisadas 20 + 12 (25/11). Hay 380 pendientes; 43 de ellas tienen 10 visitas o más | Aplicar cambios: BLOQUEADO (ver Bloqueos) | Seba (permiso) | 25/11 |
| 3 | Cupón $400 OFF "Seguidores 400" | ACTIVO por API (estado started, vence 28/11 23:59). Comunicación del canal de difusión "Enviando" desde las 17:00 | Medir vistas, clics y ventas | Claude | 26/11 |
| 4 | Atributos de fichas | 4.134 con faltantes (edición 3.427, año 2.012, tapa 1.315, páginas 1.245, género 1.031). Plan por ISBN mergeado (#806): 584 con propuesta firme, 18 de aviso único que se cargan por API. Todavía no se cargó ninguna | Construir la carga diaria; desglosar los 5.936 de ML en la pantalla de calidad | Claude | 26/11 |
| 5 | Reposición | 276 sin stock, 189 pausadas que vendieron. Cuenta de Arkano y de los títulos con ventas repetidas sin hacer | Correr el motor de reposición | Claude | 27/11 |
| 6 | Ads | El código tiene tope 60.000 (`agentes-ml/src/guardas.mjs`), Seba fijó 30.000. Las campañas activas suman 1.561 por día. Decisión de Seba (25/11): mantener hasta el 1/12; noviembre cierra estimado entre 32.000 y 35.000 | Recortar campañas el 1/12 y bajar el tope del código | Claude | 1/12 |
| 7 | Bloqueo 403 de ML (`/products/{id}/items`) | Sigue: las corridas de Precio Ganador del 25/11 hasta las 19:08 recibieron 403 | Reprobar el 26/11 con una consulta | Claude | 26/11 |
| 8 | US Games | Mail en borrador, no enviado | Enviar solo cuando Seba diga "mandalo" | Seba | — |
| 9 | Recompra y avisos de libro nuevo (Gaby) | Sin diagnosticar | Diagnóstico | Claude | 27/11 |

## Bloqueos

- Cambios de precio desde la sesión de Claude: el control de permisos de Claude Code frenó `cambiar-precio` en modo real el 25/11. Soluciones: (a) Seba autoriza una regla de permiso fija para el workflow de promos de Amado Libros; (b) los cambios de precio pasan a correr solos en GitHub Actions con la regla vigente, sin pedir permiso cada vez.

## Rutinas automáticas

Elegidas por Seba el 25/11:
- A. Precios: ya existe (Precio Ganador, cada 2 horas, modo real). Falta que corra en verde.
- E. Atributos, tanda diaria a las 03:00 en GitHub Actions: a construir.
- F. Sin catálogo por Chrome, tarea de Claude con Sonnet, 10 por hora de 10:00 a 18:00: a crear.

No elegidas: B (avisos de riesgo), C (stock y pausadas), D (informe 19:00 por mail), G (reprobar 403 por Actions; se hace a mano el 26/11).

## Registro de cambios

El antes y el después de cada cambio están en el registro privado. Acá, solo el conteo por día.

- 24/11: 7 campañas de Ads modificadas, 12 precios.
- 25/11: 20 precios, 3 envíos gratis, 1 regla en Administrado, 1 comunicación del canal de difusión.
