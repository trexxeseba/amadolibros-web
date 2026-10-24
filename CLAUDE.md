# Reglas para sesiones de Claude en este repo

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
