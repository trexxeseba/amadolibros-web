# TAROT-B2B-BLUEPRINT-1 — diseño de flujo futuro (documento, sin implementar)

Fecha: 2026-08-21
Alcance: **sólo diseño**. No se publica ninguna funcionalidad, no se crea ninguna URL, no se toca checkout ni producción. Este documento es un blueprint para evaluar y priorizar más adelante, como lote independiente.

## Problema que resolvería

El flujo web actual está orientado principalmente a compras individuales. Existe una posible necesidad B2B que conviene validar: docentes de tarot, coordinadores de talleres, terapeutas que usan cartas en consulta, o instituciones que podrían necesitar **el mismo mazo repetido N veces** (para que cada alumno tenga el suyo) más bibliografía de acompañamiento. Sería un patrón de compra distinto al individual (cantidad fija, decisión no impulsiva, cotización antes que compra) que el checkout actual no está pensado para resolver bien — pero esto es una hipótesis de diseño, no una demanda medida (ver sección de señales de evidencia más abajo).

## Entrada propuesta

Un CTA de bajo perfil, no intrusivo, en `/libros/esoterismo-tarot` (o eventualmente en un lugar más amplio del sitio si el patrón se confirma en otras categorías):

> **¿Enseñás Tarot o coordinás un taller?**
> Te ayudamos a conseguir varios mazos iguales y la bibliografía que necesites.
> [Contanos qué necesitás]

## Flujo (todo por WhatsApp, sin checkout mayorista nuevo)

1. **Detección de intención**: el CTA es explícito y opt-in — nadie cae acá por accidente, a diferencia de una pregunta agregada al Finder (que es para compradores individuales y no debe mezclarse con este flujo, ver TAROT-FINDER-1 punto 9 "no mezclar cursos/B2B").
2. **Formulario mínimo inline** (mismo patrón de interacción que el Finder: preguntas simples, sin backend nuevo), pidiendo sólo lo necesario para armar una cotización real:
   - ¿Qué mazo(s) te interesan? (texto libre o selección desde el dataset ya existente del Finder/hub — reutilizable sin duplicar datos)
   - Cantidad de mazos iguales necesarios
   - ¿Necesitás bibliografía de acompañamiento? (sí/no + cuál, si lo sabe)
   - ¿Cuándo lo necesitás? (para dimensionar si hay que pedir por encargo)
3. **Salida**: WhatsApp prellenado con esas respuestas, reutilizando el mismo helper (`buildWhatsAppMessage`/`whatsappHref` de `shared/whatsapp-messages.js`) que ya usan el hub y el Finder — **cero URL ni número nuevo**, mismo canal humano de siempre.
4. **Cotización y cierre**: 100% humano, por WhatsApp, como ya funciona hoy el resto del negocio. No hay checkout mayorista, no hay precio automático por volumen, no hay descuento programado — eso queda fuera de este blueprint hasta que haya evidencia de que vale la pena construirlo.

## Ejemplo de mensaje generado (mismo formato que ya usa el Finder)

```
Hola, coordino un taller y quisiera cotizar varios mazos iguales 😊

Motivo: Cotización para taller/grupo de estudio
Situación: Mazo: Tarot Rider-Waite-Smith en español
Cantidad: 12 mazos iguales
Bibliografía: Sí, alguna guía de interpretación básica
Cuándo: En 3 semanas

Página: https://www.amadolibros.com/libros/esoterismo-tarot

¿Podrían armarme una cotización? Gracias.
```

## Qué NO incluye este blueprint (deliberadamente)

- Checkout mayorista o facturación distinta a la actual.
- Precios diferenciados por volumen calculados automáticamente.
- Un catálogo B2B separado o una URL nueva indexable.
- Integración con el Finder de comprador individual — son intenciones distintas y mezclarlas confundiría a ambos públicos.
- Cualquier publicación: esto es sólo un documento de diseño para revisar cuando se decida priorizarlo.

## Señales que justificarían construirlo (gate de evidencia, mismo criterio que el resto del proyecto)

No se debería implementar sin antes confirmar al menos una de estas señales reales:
- Consultas de WhatsApp existentes que ya mencionen "taller", "docente", "grupo", "alumnos" en el contexto de tarot/oráculos (se podría auditar el historial de conversaciones si existe un registro, sin inventar el dato si no está disponible).
- Volumen del Finder: si varias sesiones del selector individual terminan en "sin resultados" con patrones que sugieren compra grupal (cantidad alta, mismo mazo repetido), sería una señal indirecta real.
- Pedido explícito de un cliente real pidiendo cotización grupal, documentado.

## Riesgo si se implementara sin evidencia

Construir un flujo B2B completo sin demanda confirmada es exactamente el tipo de "página/funcionalidad basura" que este proyecto evitó deliberadamente en cada lote anterior (hubs sin población suficiente, preguntas de estética sin taxonomía objetiva, etc.). Este blueprint queda documentado y listo, pero su implementación requiere el mismo tipo de gate de evidencia que ya se aplicó a "Lo más buscado" y a la decisión de no crear la landing de Veterinaria Equina.
