# Reglas para sesiones de Claude en este repo

## Trabajo con Seba (dueño de Amado Libros)

- Hablar en español rioplatense. Seba escribe rápido y con errores de tipeo;
  interpretar la intención.
- Nunca devolverle trabajo a Seba ("subí los archivos", "pasame la URL",
  "hacelo vos"). Si algo bloquea (red, archivos, herramientas), buscar siempre
  otra forma de resolverlo solo: paquetes npm, Playwright local, generar el
  recurso, elegir formato y tamaño. Preguntar solo por decisiones de negocio
  que afecten dinero, pedidos o datos de clientes.
- Elegir uno mismo tipo de archivo, formato y tamaños de imágenes y assets.
- WhatsApp oficial del sitio: 099 841 325 (+598 99 841 325), definido en
  `shared/whatsapp-messages.js`.
- Copy de cara al cliente: cálido, en positivo, sin emojis, sin "únicamente"
  ni "sólo".
- No tocar precios, cálculo de envío, pasarela de pago ni eventos de analítica
  sin pedido expreso.
- No hacer merge a producción sin que Seba lo pida: dejar el PR abierto para
  revisión.

## Una tarea, una carpeta

Varias sesiones trabajan a la vez sobre este repo. La carpeta principal
(`amadolibros-web`) es compartida: si una sesión cambia de rama ahí, le cambia
la rama a todas las demás y los commits terminan en la rama equivocada. Pasó
el 24/10/2026: dos tareas se cruzaron y un PR quedó apuntando a otro.

- Toda tarea que vaya a cambiar archivos trabaja en su propio worktree: la
  sesión abierta con worktree, o
  `git worktree add ../amadolibros-<tarea> -b agent/<tarea> origin/main`.
- En la carpeta principal no se hace checkout, reset, commit ni merge. Leer,
  buscar y correr consultas sí.
- Si la carpeta está en una rama que no es la tuya, no la cambies: otra sesión
  la está usando. Abrí tu worktree.
- Antes de cada commit, `git branch --show-current` tiene que ser la rama de
  tu tarea.
- Antes de tocar una zona que otras tareas también tocan (por ejemplo el
  panel, `functions/panel/` y `functions/_shared/panel-*`), mirá los PRs
  abiertos con `gh pr list` para no duplicar trabajo.
