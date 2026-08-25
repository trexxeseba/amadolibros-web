# Piloto Google Ads — Reina Valera y mazos de tarot

Estado: listo para configurar, **no activado**.

Objetivo: comprar tráfico de búsqueda con intención comercial mientras las nuevas landings ganan visibilidad orgánica. La campaña no reemplaza SEO ni Merchant; sirve para aparecer desde el primer día y medir demanda, consultas y compras.

## Presupuesto recomendado

- Duración inicial: 14 días.
- Presupuesto total máximo: $2.800 UYU.
- Dos campañas de búsqueda: $100 UYU diarios para Reina Valera y $100 UYU diarios para Tarot.
- Red de Búsqueda únicamente. Red de Display y socios de búsqueda desactivados durante el piloto.
- Ubicación: Uruguay.
- Opción de ubicación: presencia — personas que están o suelen estar en Uruguay.
- Idioma: español.
- Puja inicial: maximizar clics. No usar maximizar conversiones hasta comprobar que `purchase` y `whatsapp_click` están llegando correctamente y acumular datos reales.

El presupuesto es una recomendación operativa, no una estimación de clics. El CPC real debe observarse en la cuenta; no se inventa antes de acceder al Planificador de Palabras Clave y a la subasta.

## Campaña 1 — Biblias Reina Valera

Landing:

`https://www.amadolibros.com/libros/biblias/reina-valera`

### Palabras clave iniciales

Exactas:

- `[biblia reina valera uruguay]`
- `[biblia reina valera 1960 uruguay]`
- `[biblia rvr60 uruguay]`
- `[comprar biblia reina valera]`
- `[biblia reina valera montevideo]`

De frase:

- `"biblia reina valera uruguay"`
- `"biblia reina valera entrega hoy"`
- `"biblia reina valera montevideo"`
- `"biblia letra grande rvr60"`
- `"biblia reina valera con cierre"`

Negativas iniciales:

- `pdf`
- `descargar`
- `gratis`
- `versículos`
- `texto online`
- `audio`
- `aplicación`
- `wikipedia`
- `historia de la reina valera`

### Anuncio adaptable

Titulares, todos de hasta 30 caracteres:

- Biblias Reina Valera
- Reina Valera en Uruguay
- Entrega Hoy Coordinada
- Envío a $250
- Gratis Desde $1.500
- Stock Real en Uruguay
- Atención Personalizada
- Compará Ediciones RVR60
- Letra Grande y de Estudio
- Compra Online Segura
- 12% Menos por Transferencia
- Amado Libros Uruguay

Descripciones, todas de hasta 90 caracteres:

- Comprá Biblias Reina Valera con stock real. Entrega hoy según zona y horario.
- Envío $250 y gratis desde $1.500. Te ayudamos a confirmar la edición correcta.
- Compará RVR60, letra grande, estudio, cierre y formato antes de comprar.
- Atención personalizada y envíos a todo Uruguay desde Amado Libros.

## Campaña 2 — Mazos de tarot

Landing:

`https://www.amadolibros.com/libros/esoterismo-tarot/mazos`

### Palabras clave iniciales

Exactas:

- `[mazo tarot uruguay]`
- `[tarot uruguay]`
- `[comprar tarot uruguay]`
- `[tarot rider waite uruguay]`
- `[tarot de marsella uruguay]`

De frase:

- `"mazos de tarot uruguay"`
- `"tarot entrega hoy montevideo"`
- `"comprar mazo tarot"`
- `"tarot rider waite montevideo"`
- `"tarot con guía español"`

Negativas iniciales:

- `tarot gratis`
- `tarot online`
- `tirada de tarot`
- `lectura de tarot`
- `consulta tarot`
- `significado cartas`
- `horóscopo`
- `pdf`
- `descargar`
- `empleo`

### Anuncio adaptable

Titulares, todos de hasta 30 caracteres:

- Mazos de Tarot Uruguay
- Tarot: Entrega Coordinada
- Mazos con Stock Real
- Rider Waite y Marsella
- Con Guía o Solo Mazo
- Te Ayudamos a Elegir
- Envío a $250
- Gratis Desde $1.500
- Atención Personalizada
- Compra Online Segura
- 12% Menos por Transferencia
- Amado Libros Uruguay

Descripciones, todas de hasta 90 caracteres:

- Comprá mazos de tarot con stock real. Entrega hoy según zona y horario.
- Compará sistema, idioma, cartas, guía y edición antes de elegir tu mazo.
- Envío $250 y gratis desde $1.500. Atención personalizada por Amado Libros.
- Rider-Waite, Marsella y otras ediciones con envíos a todo Uruguay.

## Recursos comunes

Enlaces de sitio:

- Biblias Reina Valera — `/libros/biblias/reina-valera`
- Todas las Biblias — `/libros/biblias`
- Mazos de tarot — `/libros/esoterismo-tarot/mazos`
- Tarot y oráculos — `/libros/esoterismo-tarot`
- Envíos — `/envios`

Textos destacados:

- Entrega hoy coordinada
- Envío $250
- Gratis desde $1.500
- Stock real
- Atención personalizada
- 12% menos por transferencia

## Medición y reglas de corte

Antes de activar:

1. Vincular la propiedad GA4 correcta con Google Ads.
2. Confirmar en DebugView o tiempo real que llegan `view_item`, `begin_checkout`, `whatsapp_click` y `purchase`.
3. Importar `purchase` como conversión primaria.
4. Usar `whatsapp_click` como conversión secundaria durante el piloto, para no optimizar sólo hacia clics fáciles en WhatsApp.
5. Agregar UTMs distintas por campaña y grupo de anuncios.

Revisión diaria durante los primeros tres días:

- términos de búsqueda reales;
- consultas irrelevantes para agregar como negativas;
- gasto por campaña;
- páginas de destino;
- errores de Merchant o URLs;
- compras, inicios de checkout y clics a WhatsApp.

Revisión de decisión al día 7 y al día 14:

- mantener palabras con intención comercial demostrada;
- pausar términos informativos o ambiguos;
- no aumentar presupuesto hasta tener medición confiable;
- no declarar ganadora una campaña sólo por clics: la decisión se toma por compras y consultas útiles.

## Fuentes oficiales

- Google Ads, tipos de concordancia: https://support.google.com/google-ads/answer/7476658
- Google Ads, opciones avanzadas de ubicación: https://support.google.com/google-ads/answer/1722038
- Google Ads, anuncios adaptables de búsqueda: https://support.google.com/google-ads/answer/7684791
