# Traspaso: Google Ads, feed y Merchant Center (13/11/2026)

Escrito por la sesión de Liquidación para la sesión que se quede con Ads, feed y Merchant.
Todo lo de acá sale de lo hecho y medido entre el 5 y el 13/11/2026. Lo que no se verificó
está marcado como **sin verificar**.

## 0. Reglas de Seba que valen siempre

- Español rioplatense. Escribe rápido y con errores: interpretar la intención.
- No devolverle trabajo ("subí esto", "hacelo vos"): buscar otra forma. Preguntar solo por
  decisiones de plata, pedidos o datos de clientes.
- Copy de cara al cliente: cálido, en positivo, **sin emojis, sin "únicamente" ni "sólo"**.
- No tocar precios, cálculo de envío, pasarela de pago ni eventos de analítica sin pedido expreso.
- Mergear a producción sin pedir permiso cuando el cambio está terminado y los checks en verde
  (regla del 25/10/2026). Cambios de **precio sobre publicaciones activas** sí necesitan que él vea la lista.
- **Mercado Libre Amado Libros (seller 440298103) no se toca.** Amado Vintage (2341378249)
  está suspendida y es otro tema: no usarla como alternativa para nada de Ads.
- **Tope de gasto en Ads: USD 300 por mes (unos USD 10 por día en total).** Hoy está justo en el límite.
- Todo cambio que gaste plata necesitó un "dale" de Seba. En esta sesión lo aprobó por lotes
  ("dale", "activalo"); no asumir que vale para otros cambios.
- Una tarea, una carpeta: trabajar en un worktree propio, nunca hacer checkout en
  `/home/user/amadolibros-web`. Branch protection: el PR tiene que estar al día con `main` y con
  "Syntax & Build" en verde.

## 1. Cuentas y herramientas

| Qué | Dato |
| --- | --- |
| Google Ads | `715-685-8182` ("Cuenta de Google Ads de Amado Libros"), customer `7156858182` |
| Merchant Center | `5330457716`, vinculado y "Activa" con la cuenta de Ads |
| Feed | `https://www.amadolibros.com/feed.xml` (código en `functions/feed.xml.js`) |
| Catálogo público | `https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json` |
| Conversiones | `whatsapp_click` Principal (1 conversión en 7 días el 12/11), `book_request_submitted` Secundaria; hay una `purchase` GA4 Principal sin conversiones y dos acciones de compra "Requiere atención" |

Cómo se opera Ads desde Claude:

- **Windsor.ai (MCP)**: lee y escribe en Google Ads. **No ve Merchant Center** (solo está conectado `google_ads`).
- El **Claude de Chrome** (extensión, agente aparte en el navegador de Seba) es quien mira y toca Merchant
  y las pantallas de Ads que Windsor no cubre (conversiones, recomendaciones, apelaciones). Esta sesión
  no puede manejar el Chrome.
- Los permisos de lectura de Windsor ya están en `.claude/settings.json` (PR #615). `execute_action`
  sigue pidiendo permiso.

Trampas de Windsor que ya costaron tiempo:

- Toda acción que empieza o **sube** gasto (activar algo, cambiar un presupuesto, incluso bajarlo) devuelve
  primero un `confirmation_token`: vale 10 minutos y se usa una sola vez. La conexión con Windsor se cortó
  muchas veces y cada corte invalida los tokens: pedir el token y aplicarlo en el mismo turno.
- Los avisos pausados **no aparecen** con los campos `ad_group_ad_*`. Para sus IDs usar el reporte
  `ad_group_id, ad_id` con `options: {"include_inactive": true}`.
- El id de una palabra clave sale del `ad_group_criterion_resource_name` (lo que va después de `~`).
- Las palabras de `tarot` en Búsqueda fueron **rechazadas por política de Google**: toda la estructura
  se armó con oráculo, cartas y mazos. No se pidió excepción.
- GitHub: el MCP de GitHub se desconecta a cada rato; usar `gh api` (REST). GraphQL está bloqueado.
  El check `acceptance` ("Cover resource incident acceptance") falló una vez con "Manifest HTTP 404"
  y pasó al repetirlo: es del entorno, no del código. No es obligatorio para mergear.

## 2. Campañas de Ads: estado al 13/11/2026

Presupuestos diarios en USD. **Activas: USD 10 por día en total.**

| Campaña | ID | Estado | Presupuesto | Nota |
| --- | --- | --- | --- | --- |
| Marca \| Amado Libros \| Búsqueda UY | 24231548533 | Activa | 0,50 | casi sin gasto |
| Psi \| Profesional \| Búsqueda UY | 24226232537 | Activa | 3,00 | 30 días: gastó USD 39,41, 144 clics a USD 0,27, 1 conversión. Pierde 58 % de impresiones por presupuesto |
| Tarot y Oráculos \| Búsqueda UY | 24231566383 | Activa | 2,00 | en aprendizaje. Presupuesto bajó 5 → 3,5 → 2 |
| Liquidación \| Búsqueda UY | 24440020960 | Activa | 1,50 | ver 2.1 |
| Biblias \| Búsqueda UY | 24220589685 | Activa (12/11) | 3,00 | ver 2.2. Antes tenía 4,50 |
| Encargo \| Libros del mundo \| Búsqueda UY | 24437724628 | Pausada | 4,50 | esperaba una auditoría en celular (landing) |
| Performance Max-2, Sales-Search-2, CONOCEINDO, Campaña 2024-09-23 | varios | Pausadas | 13 / 9 / 5 / 5 | viejas, no tocar |

### 2.1 Tarot y Oráculos (Búsqueda)

Grupos: `203322796033` Libros y guías de oráculo, `205684311331` Mazos de tarot y oráculos,
`210282845028` Cartas y mazos. Avisos: `830733362107`, `830680361985`, `830733340771`.
El 9/11 se encendieron los 3 grupos, los 3 avisos y las 22 palabras (frase). Sin datos todavía.

### 2.2 Biblias (Búsqueda)

- Solo está encendido el grupo `203584677041` "Biblias - general" (11 palabras en frase, aviso `823791679905`).
- Pausados: `197665864302` "Católica" (aviso `825677322444`, 3 palabras exactas) y
  `207214642224` "Infantil y Regalo" (aviso `825677191665`, 4 palabras exactas).
- Historial 90 días: gastó USD 237,81, 1.697 clics a USD 0,14, 1 conversión. Pero la medición de
  conversiones era mala (`whatsapp_click` se disparaba con otro nombre): no sirve para juzgar.
- **Sin verificar**: los avisos dicen "12 cuotas sin recargo" y "Entrega en el día en Montevideo".
  Confirmar con Seba que son ciertos hoy.
- Motivo de reactivarla: en las búsquedas de la web hay unas 37 búsquedas distintas por ediciones
  concretas de Biblias (Reina Valera, NTV, de estudio, de Navarra, Torres Amat, con índice, para niñas)
  y 2 avisos de stock de Biblias. Conviene mirarla a las 2 semanas.

### 2.3 Liquidación (Búsqueda)

- La web da **10 % de liquidación + 12 % por transferencia**; el tope total es 25 % y el piso $1.200.
- Se descubrió que los 4 avisos originales prometían "hasta 25 % off", "Girá la rueda" y
  "Resolvé el acertijo" **antes de que existieran**. Se crearon avisos nuevos con el texto correcto
  ("Libros con 10% off", "12% más por transferencia") y se pausaron los viejos:
  - Nuevos (activos): `831065556690` (Infantil `199041351262`), `831065654526` (Psicología `200538342614`),
    `831121777117` (Literatura `199041351782`), `831137998039` (Educación `200531602526`).
  - Viejos (pausados): `830539901415`, `830589723013`, `830589838534`, `830589864181`.
- **Problema abierto**: el 12/11 la campaña seguía leyéndose como "No apta" (motivos
  `AD_GROUPS_PAUSED` y `KEYWORDS_PAUSED`) aunque los 4 grupos figuran activos y 6 palabras están
  elegibles. Puede ser demora en actualizarse. Volver a mirar. Además 11 de las 17 palabras están
  "poco servidas" (poco volumen en Uruguay): esta campaña va a mover poco; por eso bajó de 5 a 1,50.
- Ahora que **la Rueda y el Acertijo existen** (sección 5) se puede sumar un titular como
  "Girá la rueda, ganá hasta $450 de descuento". El "hasta 25 %" ya no es el texto correcto: el premio
  es en pesos y el tope de 25 % es del total.

### 2.4 Pendiente de Ads

1. **Desactivar la aplicación automática de recomendaciones** (Google aplicó una entre el 2 y el 8/11 y
   propone subir presupuesto). Protege el tope de USD 300. Lo hace el Claude de Chrome.
2. **Shopping Tarot y mazos**, aún no creado (sección 4). Su presupuesto de USD 3 por día **no entra** en el
   tope actual: hay que rebalancear (por ejemplo bajar Biblias o Liquidación) o pedirle a Seba otro tope.
3. Encargo sigue pausada. No activarla sin la auditoría de la landing en celular.
4. Preguntas sin responder de Seba: **margen por libro** y **qué porcentaje de las consultas por WhatsApp
   termina en venta**. Con eso se fija un tope de puja con números.
5. Atribución: en Airtable (base PEDIDOS AMADO LIBROS) el campo "Cómo nos encontró" tiene un solo
   pedido con "Google" en toda la historia. Hay que pedirle a Gaby que lo complete siempre; sin eso no se
   puede medir cuánto vende cada campaña.

## 3. Feed y Merchant Center

### 3.1 Qué cambió en el feed (todo mergeado)

| PR | Qué hace |
| --- | --- |
| #590 | Los mazos y barajas con ISBN válido entran al feed (`isCardDeckProduct`, solo del feed; la ficha no los declara libro) |
| #606 | Mazos aceptan EAN/UPC real como GTIN (`feedGtin`); sin ningún código entran con `identifier_exists=no` y marca real (nunca "Genérica" ni "Amado Libros") |
| #626 | Categoría de Google propia: tarot `499711`, juegos de cartas `1247`, libros `784` (códigos verificados contra la taxonomía oficial) |
| #662 | Fuera del feed los libros con "+ Ebook", "Con Ebook" o "Digital Pack" (Merchant no admite libros digitales en Shopping) y **`custom_label_1 = tarot`** para mazos de tarot y libros de la subcategoría "Tarot y oráculos" |

Además `custom_label_0 = liquidacion` sale de la lista versionada `data/liquidacion.json` (1.221 productos el 12/11).

Auditoría del feed publicado el 12/11 (antes de #662): 3.658 productos = 3.553 libros (784), 82 mazos de
tarot (499711), 23 juegos de cartas (1247). 111 sin GTIN. Precio de $185 a $21.000, mediana $1.939.

Hay un workflow de solo lectura para repetir la auditoría de mazos: `.github/workflows/mazos-feed-audit.yml`
(el 10/11 daba 360 de 360 candidatos dentro del feed).

### 3.2 Informe del Claude de Chrome en Merchant (12/11 13:28, solo lectura)

| Medio | Aprobados | Limitados | No aprobados |
| --- | --- | --- | --- |
| Todos | 3.444 | 193 | 4 |
| Shopping | 3.621 | 0 | 20 |
| Fichas gratuitas | 3.624 | 13 | 4 |
| Remarketing | 3.444 | 0 | 197 |

- **Los 20 rechazados en Shopping**: 16 "libros digitales" (ya sacados del feed por #662), 2 "conducta
  fraudulenta" y 2 "drogas ilegales". Estos 4 parecen **falsos positivos** (libros de Cáncer de Mama,
  Crisálida a Mariposa): hay que **apelarlos** desde Merchant con "No estoy de acuerdo". Lo hace el Claude de Chrome.
- **Remarketing**: 197 no aprobados por política de publicidad personalizada (dificultades personales 132,
  identidad y creencias 19, intereses sexuales 14, adultos 13, restricciones legales 13). Son libros de
  psicología, salud y creencias. **No tiene arreglo y no afecta a Shopping. No hacer nada.**
- **Tarot en Shopping**: no hay restricción de política. Un solo título de tarot cayó, por "libros digitales".
  Cinco títulos de tarot están rechazados solo en remarketing por "restricciones legales".
- Feed: última lectura 12/11 0:00, procesó 3.652 de 3.658 declarados, sin errores. Fuente única "PRODUCTS SOURCE 3".
  Merchant ofrece "agregar 3.050 productos encontrados por Google": **no se aceptó**.
- **Sin verificar**: uno por uno los 82 mazos (499711) y los 23 juegos (1247) después del cambio de categoría;
  el vínculo desde el lado de Ads; que Merchant ya lea `custom_label_1` y la exclusión de ebooks (el feed
  se publicó el 12/11 por la tarde: Merchant relee en menos de un día).

### 3.3 Shopping: plan acordado (no creado)

No hay ninguna campaña de Shopping. El plan, siempre **en pausa hasta que Seba diga**:

- **Shopping | Tarot y mazos**: Standard Shopping, puja manual por clic, CPC inicial USD 0,20, USD 3 por día
  (**ver el tope en 2.4**), Uruguay, español, sin socios de búsqueda ni Display, producto filtrado por
  `custom_label_1 = tarot`. Es la única forma de aparecer en búsquedas de tarot, porque en Búsqueda
  Google rechazó esas palabras.
- **Shopping | Liquidación**: se decidió **no** crearla todavía (Liquidación ya corre en Búsqueda).
  Si se crea: CPC USD 0,15, solo `custom_label_0 = liquidacion`, prioridad baja frente a Tarot.
- Un producto de tarot con etiqueta `liquidacion` se solapa entre campañas: prioridad media a Tarot.

Pedido pendiente para el Claude de Chrome (tres tareas, en orden y avisando entre una y otra):
(1) desactivar la aplicación automática de recomendaciones; (2) apelar los 4 falsos positivos;
(3) cuando Merchant relea el feed, crear Shopping Tarot en pausa.

## 4. Web que respalda las campañas

- **Liquidación** (`/liquidacion`): lista versionada (3.138 listados, 1.615 elegibles al armarla), menú y banda
  en la home, cobro y carrito con el mismo precio. Activada el 10/11/2026 a las 00:00 (Montevideo).
- **Rueda del Librero** y **Acertijo del Librero** (en `/liquidacion`): premio decidido en el servidor,
  un giro por día y por número de WhatsApp, código `LIB-XXXXX` de 48 horas y un solo uso.
  **Premios en pesos de $150 a $450** (150: 30 %, 200: 25 %, 250: 20 %, 300: 12 %, 350: 8 %, 450: 5 %);
  acierto del Acertijo = $450 más regalo (marcapáginas por defecto, configurable).
  El premio se suma al 10 % de la liquidación y a la transferencia (12 %), **sin pasar 25 % del precio
  habitual ni bajar de $1.200** (el descuento se recorta hasta el piso).
- Canje para Gaby y Lola: `/panel/canje` (con la clave del panel), con calculadora del precio final.
  Los códigos viejos con porcentaje siguen valiendo.
- Eventos GA4 nuevos: `juego_visto`, `rueda_girada`, `acertijo_respondido`, `codigo_enviado_whatsapp`.
- Los 14 acertijos están **en borrador** (`data/acertijos.json`): Seba los tiene que revisar.
- Medición: `docs/medicion-google-ads.md`.

## 5. Lo que piden los clientes (insumo para Ads y feed)

- La web guarda las búsquedas sin resultado en D1 (`search_misses`); `.github/workflows/busquedas-export.yml`
  (manual) manda por correo a Seba el listado completo (el repo es público: nunca imprimir ese contenido en el log).
- Corregido: el enlace "Explorar libros de <género>" de las fichas mandaba al buscador y siempre daba
  "sin resultados" (era más de la mitad de lo registrado). PR #668. Las búsquedas de prueba de los controles
  (`zzzinexistente999`) ya no se cuentan (PR #666).
- **Demanda real** (4/10 al 12/11, 718 búsquedas de clientes): *Sombras de Raccoon City* (22), *Las cosas que
  nunca se hablan* (15), *La isla de Launion* (13), *Reinventa tu vida* (10), *Tratado de Ba-Kua* (10);
  **Biblias** (≈37 ediciones distintas, con errores de tipeo como "andrews" y "apolocica"); psicología
  (gestalt, psicoanálisis vincular, narcisismo, TDAH); varios títulos en inglés y portugués; 33 ISBN.
- Pedidos reales del formulario "Pedir un libro" (7, uno de prueba): *Inteligencia transgeneracional*
  (Hellinger), *The Perfume Companion*, *Hija de la fortuna* (Isabel Allende), *Sonetos* (Shakespeare,
  Acantilado), *La banda de Pica Pau 3*, *Manual práctico de telar*. **Confirmar que Gaby les respondió.**
- Avisos de stock (13): Biblias (2), Sopicidios (3), Murdoku (2), Dibujos para colorear Qué misterio (2),
  obras de Freud y Pichon-Rivière.
- **Con cuidado**: los "apellido nombre" que se repiten 5 o 6 veces durante semanas (kahl marcel, alava raisa,
  barfety elisabeth) parecen venir de enlaces "Ver otros libros del autor" de fichas agotadas, no de clientes;
  tampoco las 9 búsquedas de ISBN del 17/10 en un solo día.
- Ideas aprobadas por Seba y **no construidas todavía**: alternativas en la pantalla de "sin resultados"
  (más del autor o la categoría, "¿quisiste decir…?"), "avisame si lo conseguimos" y una tarjeta del panel con
  las 10 búsquedas reales de la semana.

## 6. Cosas que conviene vigilar

1. El tope de USD 10 por día: cualquier campaña nueva exige bajar otra.
2. Liquidación "No apta" (2.3).
3. Que Merchant acepte los mazos con la categoría nueva y que no aparezcan rechazos nuevos.
4. Biblias a las 2 semanas: si no hay conversiones medidas, no subirle presupuesto.
5. Psi Profesional pierde 58 % de impresiones por presupuesto, pero **no se subió**: no hay datos de ventas
   que lo justifiquen (en Airtable solo un pedido figura como encontrado por Google).
6. Poner links de Mercado Libre en los avisos: **se descartó**. No se podría medir nada, Shopping exige que
   el producto lleve al propio sitio y se pierde todo lo construido en la web.
7. Errores propios que se corrigieron: se anunció "unos USD 12 por día" sin compararlo con el tope de USD 300;
   se creyó que faltaban los mazos en Merchant (ya estaban 72 de 103); el primer plan de "Psicología" duplicaba
   la campaña Psi Profesional.

## 7. Sesión única de Ads, feed y Merchant (desde el 12/11/2026 por la noche)

Seba decidió que **una sola sesión ejecuta** en Google Ads, Merchant Center y el feed (el chat
"Google Ads + Merchant + Feed"). Las demás sesiones solo leen y analizan. Esta sección actualiza
lo de arriba; si algo se contradice, vale esto.

### 7.1 Hecho el 12/11 por esa sesión

- **Aplicación automática de recomendaciones: desactivada** y verificada (0 de 7 y 0 de 14 tipos).
  No se aplicó ninguna recomendación pendiente. Cierra el punto 2.4.1.
- **Los 4 falsos positivos de Shopping: revisión pedida** ("No estoy de acuerdo", motivo "Mi producto
  cumple los requisitos de la política"). Son Cannabis Consciente (MLU625822973) y Guía Completa de
  Rastreo (MLU707859674) por "drogas ilegales"; De Crisálida a Mariposa (MLU479215404) y Libro Cáncer
  de Mama (MLU700558594) por "conducta fraudulenta". Los 4 quedaron en "Revisión solicitada el 12 nov 2026".
- **Remarketing: se pidió revisión de 151 limitados** por pedido expreso de Seba, pese a lo que dice 3.2:
  132 de "dificultades personales" (en bloque) y 19 de "identidad y creencias" (uno por uno). No gasta
  ni afecta Shopping. Si Google las rechaza hay que esperar unos días para volver a pedir. **No pedir
  más revisiones de este tipo ni repetir estas.**
- **PR #672**: el sync levanta la descripción de la ficha de Catálogo de ML (`short_description`) cuando
  la publicación no tiene texto propio. Solo lectura contra ML. Rinde poco en el feed: de 163 fichas
  consultadas de los productos sin descripción, 162 vinieron vacías.
- **PR #673**: descripción editorial para 7 mazos de tarot (`functions/_shared/book-tarot-enrichments.js`),
  con la página oficial de la editorial por ISBN exacto. Verificado en el feed de producción.

### 7.2 Medido el 12/11

- Feed en producción: 3.655 productos, 204 con `custom_label_1 = tarot`, 1.219 con `custom_label_0 = liquidacion`.
  Unos 3.010 con descripción real y 644 con la plantilla título/autor/ISBN (630 son de Catálogo de ML).
  De esos 644, 15 eran de tarot (7 ya resueltos por #673) y 56 de liquidación.
- Merchant a las 16:40: última lectura 12/11 0:00 con 3.652 productos; "No se muestra en Google": 4.
  Todavía figuraban los 16 "libros digitales" (Merchant no había releído el feed posterior a #662).
- Ads por Windsor (7 días al 12/11): presupuestos como en la sección 2 (USD 10 por día). Tarot y Oráculos
  en CPC manual; **Biblias en "Maximizar clics" y en aprendizaje**; Liquidación ya figura apta
  (cierra el problema de 2.3); Psi limitada por presupuesto. No existe ninguna campaña de Shopping.

### 7.3 Pendiente

1. Crear **en pausa** "Shopping | Tarot y mazos" cuando Merchant muestre `custom_label_1 = tarot`. Activarla
   exige el OK de Seba y decidir de dónde salen sus USD 3 por día (sección 2.4.2).
2. Los 8 mazos de tarot que siguen con plantilla: Tarot Gestáltico (Mandala), El Tarot de los Filósofos
   (Oberon), Visiones Etéreas (Trédaniel), Tarots of Druids (Lo Scarabeo) y cuatro con código EAN de
   Fournier (Alchemy 1977, Tarot de los Ángeles, Gothic Tarot, Spanish Tarot). Falta la fuente oficial.
3. Revisar el PR #664 (landing de anuncios, GA4 y feed con tema/sensible) antes de que se mergee.
4. Decisión de Seba: estrategia de oferta de Biblias (dejar "Maximizar clics" o pasar a CPC manual).
5. Lunes 16/11: términos de búsqueda, gasto y decisión sobre activar Shopping.
6. Merchant ofrece "Vincular PayPal" y "agregar 3.050 productos encontrados": no se aceptó ninguno.
   PayPal solo tiene sentido si la web cobra con PayPal.
