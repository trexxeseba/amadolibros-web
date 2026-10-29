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
- Mergear a producción sin pedir permiso, en cuanto el cambio esté terminado y
  los checks en verde (regla fijada por Seba el 25/10/2026, reemplaza la
  anterior de dejar el PR abierto). No preguntar "¿lo mergeo?": hacerlo y
  contarlo después. Si el cambio queda a medias o los checks fallan, dejar el
  PR abierto y decirlo.
- Aplicar cambios de precio sobre publicaciones ya activas sigue necesitando que
  Seba vea la lista antes: eso no es mergear código, es tocar plata. Mergear el
  código que los calcula no necesita permiso.
- La cuenta de Mercado Libre **Amado Libros** (seller 440298103) no se toca ni se
  ofrece como opción salvo que Seba lo pida expresamente. El hook
  `.claude/hooks/guard-amado-libros.mjs` pide su aprobación antes de editar el
  código de esa cuenta, el que comparte con Vintage, o cualquier cosa que nombre
  el seller.

## Mercado Libre: en qué cuenta se publica

- Las altas automáticas van solo a Amado Vintage (Global Emporium es la misma
  cuenta, 2341378249), desde el motor local de la PC. En Amado Libros
  (440298103) no se publica salvo pedido explícito de Seba: la cola del Worker
  está en solo lectura. Antes de tocar cualquier camino que publique, leer
  `docs/cuentas-mercado-libre.md`.

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
