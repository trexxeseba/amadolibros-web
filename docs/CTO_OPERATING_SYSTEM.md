# Amado Libros — sistema operativo del CTO

Este documento define cómo continúa el proyecto sin depender de la memoria de un chat.

## Fuente de verdad

- GitHub conserva el estado técnico verificable.
- El Centro de mando de ChatGPT Library conserva decisiones, prioridades y evidencia comercial.
- Si difieren, se corrige inmediatamente el Centro de mando con el estado real de GitHub.

## Límite de trabajo

- Un frente principal de ChatGPT/CTO.
- Un frente externo independiente, normalmente Claude Code.
- Un hotfix adicional únicamente si Producción está rota.

Las ideas nuevas van al backlog sin rama ni PR.

## Continuidad obligatoria

Después de verificar un despliegue, el CTO debe:

1. registrar SHA, deploy y evidencia;
2. cerrar el frente terminado;
3. activar el siguiente trabajo seguro de la cola;
4. dejar responsable y próxima acción;
5. continuar sin pedir otra orden cuando no exista riesgo externo.

Se requiere autorización explícita de Seba para merge, Producción, credenciales,
permisos, borrados, gastos y compromisos comerciales públicos.

## Estados

`Backlog → Aprobado → En desarrollo → Draft PR → CI verde → Preview verificado → Listo para Producción → Merge autorizado → Producción verificada → Cerrado`

`Hecho` significa fusionado, desplegado y verificado en Producción.

## Caducidad

- Rama sin PR: 24 horas.
- CI rojo sin responsable: 24 horas.
- Draft sin próxima acción: 72 horas.
- Siete días sin movimiento: decidir continuar, reemplazar, archivar o cerrar.

## Archivos críticos

- `functions/libro/[[path]].js`
- `functions/catalogo.js`
- `functions/book-cover/[[path]].js`
- `functions/feed.xml.js`
- portada, checkout, pagos, canonicals y sitemaps

Dos PR que toquen el mismo archivo crítico deben declarar orden de integración.

## Automatización

`scripts/ops/project-governance-audit.mjs` genera un inventario reproducible de:

- PR abiertos y Draft vencidos;
- ramas sin PR;
- CI pendiente o rojo;
- colisiones en archivos críticos;
- próxima decisión requerida.

La primera fase informa y conserva evidencia. No borra ramas ni fusiona PR.
