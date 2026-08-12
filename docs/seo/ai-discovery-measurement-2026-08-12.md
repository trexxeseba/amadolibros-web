# Descubrimiento por IA y Google — dictamen y medición

Fecha del dictamen: 2026-08-12  
Alcance de este lote: medición, auditoría de las cinco especialidades y criterios de decisión. No autoriza ni ejecuta un despliegue productivo.

## Dictamen ejecutivo

La prioridad correcta no es publicar más contenido: es cerrar la brecha de medición del sitio que ya existe. Las páginas Astro cargaban GA4, pero las fichas, el catálogo, las categorías y las especialidades se renderizan con Cloudflare Pages Functions y no cargaban GA4. Por eso, antes de este lote una visita podía terminar en WhatsApp sin conservar una sesión atribuible.

La recomendación experta es:

1. desplegar una medición única en ambos caminos de renderizado;
2. marcar `whatsapp_click` como evento clave en GA4;
3. medir durante dos ventanas consecutivas de 14 días;
4. recién entonces elegir qué especialidad, guía o conjunto de fichas merece inversión.

No se recomienda crear páginas especiales “para la IA”. Google indica que sus funciones de IA no requieren archivos, marcado ni optimizaciones especiales: siguen dependiendo de los fundamentos de Search. OpenAI pide que el sitio sea público y que `OAI-SearchBot` no esté bloqueado. Amado Libros ya cumple esto último y mantiene `GPTBot` bloqueado, separando descubrimiento en Search de uso para entrenamiento.

Fuentes primarias:

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google: helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Google: general structured-data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [OpenAI: Publishers and Developers FAQ](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)

## Contrato de medición

| Nivel | Definición | Uso |
|---|---|---|
| Resultado de negocio | Compra confirmada o recompra | Verdad comercial; no se sustituye por tráfico |
| Conversión principal digital | Sesión con `whatsapp_click` | Intención de contacto atribuible |
| Conversión de mayor intención | `book_request_submitted` | Formulario de búsqueda completado antes de abrir WhatsApp |
| Captación IA | Sesiones con fuente ChatGPT, Claude, Gemini, Perplexity o Copilot | Tráfico clicado desde asistentes; no equivale a todas las citas |
| Captación Google | Impresiones, clics y posición por landing en GSC | Descubrimiento orgánico, incluido el tráfico agregado de funciones de IA |

KPI primario:

`tasa de intención WhatsApp = sesiones con whatsapp_click / sesiones`

Se calcula por landing, fuente/medio y período. El exportador deja el numerador en `whatsapp-intent` y el denominador compatible en `all-landing-pages`.

Parámetros permitidos en `whatsapp_click`:

- `page_type`
- `cta_location`
- `topic`, sólo para taxonomías controladas
- `product_id`, sólo el identificador MLU de la ficha

No se envían a GA4 el mensaje de WhatsApp, la URL de destino, términos de búsqueda, nombre, correo, teléfono ni datos del checkout. La URL de página conserva sólo parámetros de campaña (`utm_*`, `gclid`, `gbraid`, etc.) para mantener la atribución sin exportar las consultas internas.

## Auditoría de las cinco especialidades

| Landing | Estado técnico | Decisión |
|---|---|---|
| Medicina | indexable en producción, canonical, catálogo real, `CollectionPage` + `ItemList` + `Service` + breadcrumbs | mantener y medir |
| Oftalmología | igual; contenido y taxonomía propios | mantener y medir |
| Cirugía | igual; filtro por palabras completas | mantener y medir |
| Agricultura | igual; evita coincidencias por fragmentos | mantener y medir |
| Electrotecnia | igual; deduplica publicaciones con el mismo ISBN | mantener y medir |

Fortalezas verificadas:

- títulos, H1, descripciones e introducciones diferenciados;
- catálogo vigente, sólo con disponibilidad y sin inventar libros;
- canonical único y `noindex` para preview, parámetros y slugs no autorizados;
- enlace desde sitemap y desde la landing pilar de encargos;
- datos estructurados que reflejan contenido visible;
- WhatsApp contextual disponible y formulario de búsqueda manual.

Límites actuales:

- las cinco páginas comparten una plantilla fuerte, pero no deben multiplicarse sin evidencia;
- son landings de descubrimiento y conversión, no guías profundas citables por sí solas;
- falta una página institucional sólida que explique quién revisa las búsquedas, experiencia real, método y relación verificable con el negocio. Google recomienda concentrar el marcado de organización en la home o en una página institucional, y valora que el sitio haga visible quién creó o revisó el contenido;
- el schema ayuda a comprender entidades, pero Google no garantiza visibilidad ni ranking por usarlo.

## Baselines que deben ejecutarse

Los workflows ya existen, pero todavía no tienen runs para estos cortes:

| Evidencia | Período exacto | Workflow |
|---|---|---|
| LOGS-3 limpio | 2026-08-09 a 2026-08-10 UTC | `SEO crawl report` |
| GA4 previo a esta instrumentación | 2026-07-01 a 2026-08-11 | `GA4 manual export` |
| GSC histórico fijo | 2026-05-11 a 2026-08-08 | `GSC manual export` |

El informe generativo nuevo de Search Console se está desplegando sólo a un subconjunto de sitios; no existe una activación manual que el repositorio pueda forzar. Si aparece en la propiedad, se guarda una captura de día 0. Mientras tanto, sus datos siguen agregados en el informe Web. Fuente: [Google Search Generative AI performance reports](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports).

## Reglas de decisión

### Control de implementación

- En las primeras 24 horas: `whatsapp_click` debe aparecer en DebugView/Realtime y en el inventario de eventos.
- En GA4 Admin: marcar `whatsapp_click` como evento clave. El clic expresa intención; no se renombra `generate_lead` porque no prueba que el mensaje haya sido enviado.
- Verificar un clic de cada familia: home, catálogo, ficha, especialidad, buscador, formulario de encargo y carrito.

### Ventana de 14 días

- Confirmar que las cinco URLs aparecen en GSC y separar problema de indexación de falta de demanda.
- Comparar sesiones, sesiones con intención de WhatsApp y fuente/medio.
- No interpretar cero referidos de IA como cero citas: GA4 sólo observa citas que generan clic.

### Ventana de 28 días

- Priorizar la especialidad que produzca al menos una consulta de WhatsApp o que muestre crecimiento de impresiones en dos cortes consecutivos.
- Si ninguna especialidad produce señal, no publicar otras cinco: revisar intención de búsqueda, enlazado interno y claridad de la oferta.
- Publicar la primera guía sólo cuando una especialidad o una consulta real revele una pregunta repetida que Amado Libros pueda responder con experiencia propia y casos anonimizados.
- No ampliar fichas en masa: seleccionar el siguiente lote con facturación, impresiones y consultas, no sólo por cantidad de SKU.

## Próximo lote recomendado

Después de desplegar y validar esta medición:

1. página “Quiénes somos y cómo trabajamos”, con autoría/revisión visible y schema `BookStore`/`Organization` coherente;
2. verificación manual de la identidad externa que pueda enlazarse con `sameAs`, sin declarar perfiles que no hayan sido confirmados;
3. circuito de reseña post-entrega y seguimiento de recompra;
4. primera guía basada en demanda observada, no en una lista genérica de temas.
