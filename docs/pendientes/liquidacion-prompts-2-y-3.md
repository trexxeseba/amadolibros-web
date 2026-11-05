# Liquidación: prompts 2 y 3 (pendientes)

Guardados el 5/11/2026 para retomar después del PR del Prompt 1
(universo de liquidación, tope 25%, menú, medición).

Orden: Prompt 1 mergeado → Prompt 2 → Prompt 3.

---

## Prompt 2: la Rueda del Librero y el Acertijo (PR aparte, después del 1)

```
Trabajá sobre el repo trexxeseba/amadolibros-web, parado en main, con el PR del Prompt 1 ya mergeado. Un PR, tests en verde, descripción en español. No mergees sin aprobación de Seba.

OBJETIVO
En /liquidacion sumar dos juegos que entregan un código de descuento: La Rueda del Librero y El Acertijo del Librero. Todo sobre el universo de liquidación del Prompt 1.

PASO 0: DIAGNÓSTICO
Decime qué backend tenemos disponible (Worker de Cloudflare, D1, KV, Resend) y cuál es la forma más liviana de guardar códigos. Proponé el diseño antes de implementar.

A. LA RUEDA
- Un giro por día y por número de WhatsApp (guardar solo un hash del número).
- El resultado se decide en el servidor, nunca en el navegador.
- Premios y probabilidades: 10% (35%), 12% (25%), 15% (20%), 18% (10%), 20% (6%), 25% (4%). Tope duro de 25% en todo el sistema.
- Cada giro devuelve un código con 48 horas de validez, de un solo uso, en formato corto fácil de leer por WhatsApp.
- Animación sobria y elegante, acorde a una librería de libros difíciles; sin estética de casino.

B. EL ACERTIJO
- Un acertijo literario por día, rotando desde un archivo de datos (acertijos.json con pregunta, respuestas aceptadas y el libro del catálogo que lo resuelve).
- Acierto: código de 25% más un regalo (marcapáginas de Amado o envío express en Montevideo el mismo día, según un campo configurable).
- Error: un giro de la Rueda como consuelo, con las mismas reglas.
- Cargá 14 acertijos de ejemplo claramente marcados como borrador para que Seba los revise.

C. CANJE
- El código viaja en el mensaje prellenado de WhatsApp ("Hola, tengo el código XXXX para este libro").
- Endpoint de verificación para el equipo (Gaby y Lola, desde el celular): devuelve si el código es válido, su descuento y el vencimiento, y lo marca como usado. Si ya existe la integración con el Airtable del CRM, registrar ahí el canje; si no, proponé la opción más simple.
- El precio con premio se muestra en la ficha del libro solo si el precio final queda sobre $1.200 y el total no pasa 25% (la transferencia de 12% se suma solo mientras entre en el tope).

D. SEGURIDAD
- Limitar giros por IP y por número; códigos no adivinables; ningún dato personal en la URL.
- Nada de secretos en el repo ni en el chat.

E. MEDICIÓN
- Eventos: juego_visto, rueda_girada (con premio), acertijo_respondido (acierto/error), codigo_enviado_whatsapp, codigo_canjeado.

ENTREGA
PR con tests, capturas del juego en celular y un resumen: qué quedó, qué falta y qué debe hacer Seba (por ejemplo, revisar los acertijos).
```

---

## Prompt 3: Estante del Día, Escalera de Lectura y Libro Misterio (después del 2)

```
Trabajá sobre el repo trexxeseba/amadolibros-web, parado en main, con los PR 1 y 2 mergeados. Un PR por tema (3 PR), tests en verde, descripción en español. No mergees sin aprobación de Seba.

PASO 0: DIAGNÓSTICO
Confirmá cómo se guarda hoy el universo de liquidación y las constantes de descuento, y proponé el diseño antes de implementar.

PR A: ESTANTE DEL DÍA
- Cada día un tema del universo de liquidación entra a 25% por 24 horas. La rotación sale de un archivo configurable (estante-del-dia.json) y por defecto recorre: infantil y juvenil, psicología, literatura y ficción, esoterismo y tarot, educación, desarrollo personal.
- Banner en /liquidacion y en la home con cuenta regresiva, y URL estable por tema para usar en avisos (por ejemplo /liquidacion?tema=psicologia).
- El 25% del estante no se acumula con el premio de la Rueda: se aplica el mayor.

PR B: ESCALERA DE LECTURA
- 2 libros del universo de liquidación: 15%. 3 libros: 20%. 4 o más: 25%.
- Resumen visible antes de pedir por WhatsApp, y mensaje prellenado con la lista de libros y el descuento final.
- Tope de 25% total con test; la transferencia de 12% se suma solo mientras el total no lo pase.

PR C: LIBRO MISTERIO
- Pack de 3 libros de un tema a elección del cliente, con títulos ocultos hasta la compra. Precio = suma de los 3 precios habituales con 25% de descuento.
- Armar los packs solo con libros del universo de liquidación y con stock físico real; si el pack no se puede completar, no se muestra.
- Mensaje prellenado de WhatsApp con el tema elegido.
- Contenido listo para reels: página simple que lista los packs disponibles hoy.

Para todos: textos en positivo, sin restricciones, sin mencionar inteligencia artificial, y medición con los eventos nombrados igual que en el Prompt 2.

ENTREGA
Tres PR, tests en verde, y un resumen con qué quedó, qué falta y qué necesita de Seba.
```

---

## Notas para cuando se retome

- Paso 0 del Prompt 1 ya hecho (5/11/2026). Hallazgo clave: el sitio dispara
  `whatsapp_click`, no `web_whatsapp_click`; probable causa de las 0
  conversiones en Google Ads.
- Para el Prompt 2: el tope de 25% del Prompt 1 tiene que ser la única
  constante que usen la Rueda, el Acertijo y el canje.
- Para el Prompt 3: el Estante y la Escalera dependen del mismo tope y del
  piso de $1.200.
