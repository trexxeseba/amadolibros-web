# CLAUDE.md — instrucciones persistentes para agentes de código en este repo

Este archivo se carga automáticamente en cada sesión de trabajo sobre
`trexxeseba/amadolibros-web`. No es documentación general del proyecto: es
protocolo operativo obligatorio para cualquier agente de código (Claude
Code u equivalente) que maneje git en este repo.

## Por qué existe este protocolo

En una sesión de trabajo con ramas y worktrees en paralelo, al crear una
rama de integración temporal que combinaba dos lotes ya validados, los
comandos de git subsiguientes quedaron apuntando al checkout/worktree
principal — que estaba ocupado en otra tarea — en vez del worktree recién
creado. Consecuencia: un commit que correspondía a un lote cayó en la rama
local equivocada. No llegó a publicarse a GitHub ni a Cloudflare, pero
exigió backup manual del commit mal ubicado y restauración de la rama
afectada. Fue un error no forzado y evitable: git no falló, faltó
verificar en qué directorio se estaba parado antes de commitear.

Este protocolo existe para que ese chequeo no dependa de que el agente "se
dé cuenta" cada vez por su cuenta.

## Regla general

Ante la mínima duda de contexto (qué rama, qué worktree, qué directorio),
el agente se detiene y verifica antes de ejecutar. No se asume que un `cd`
anterior sigue vigente: algunas herramientas de shell resetean el
directorio de trabajo entre comandos. Verificar de nuevo es más barato que
recuperarse de un commit mal ubicado.

## Protocolo obligatorio de verificación de contexto git

Aplica siempre, sin excepción, antes de cualquier comando que modifique
estado: `git add`, `git commit`, `git checkout`, creación de rama o de
worktree.

1. **Antes de crear o usar un worktree nuevo**, correr `git worktree list`
   y registrar qué rama tiene cada uno y cuál está ocupado por otra tarea
   en curso. Si hay una tarea en curso en otro worktree, no reutilizar ese
   checkout para un lote distinto — crear uno nuevo y aislado.
2. **Antes de cualquier `git add` o `git commit`**, mostrar explícitamente
   `pwd`, `git rev-parse --show-toplevel` y `git branch --show-current`, y
   compararlo contra el worktree/rama que corresponde a la tarea actual.
3. **Si el resultado del paso 2 no coincide** con el destino esperado,
   parar ahí. No correr el comando. Corregir el directorio de trabajo
   primero.
4. **Antes de publicar (push) cualquier rama**, repetir la verificación
   del paso 2 y correr también `git log --oneline -5` para confirmar que
   los commits a publicar son los que corresponden a esa rama, y que no
   se coló ningún commit de otro lote.
5. **No hacer push, merge, PR ni deploy** sin que la validación completa
   (sintaxis, tests, build con el checkout apagado y encendido cuando
   aplique feature flags) haya dado verde para esa rama puntual.

## Procedimiento de recuperación

Si un commit ya cayó en la rama equivocada y todavía no se publicó:

1. No publicarlo ni tocarlo a ciegas.
2. Hacer backup del commit accidental (rama temporal o patch) antes de
   tocar nada.
3. Restaurar la rama afectada a su último estado correcto conocido,
   preservando cualquier cambio legítimo sin asumir que ya existiera ahí
   antes del incidente — verificarlo explícitamente.
4. Recién ahí aplicar el commit correcto en el worktree/rama que
   corresponde.
5. Repetir toda la validación desde cero sobre esa rama antes de seguir.
6. Contar en el reporte final qué pasó y cómo se corrigió. No ocultarlo ni
   mezclarlo con otro paso del reporte.

## Restricciones duras

- Nunca usar `git add .`. Agregar siempre archivos puntuales.
- Nunca hacer commit ni push sin aprobación explícita del dueño del
  proyecto, aunque la validación haya dado verde.
- Nunca tocar `main` ni producción de forma directa.
- Nunca mezclar el contenido de dos lotes en el mismo PR o rama, salvo que
  sea una rama de integración temporal creada explícitamente para ese
  único fin, y aclarado como tal en su descripción y en el PR.
- Si una validación falla por un problema de entorno (permisos, caché de
  npm, directorio de sesión inicial incorrecto, etc.), aclararlo como tal
  en el reporte. No confundirlo ni mezclarlo con un error de código.

## Metodología de ramas de este repo

- `main` es la rama de producción. No se pushea ni se mergea sin
  aprobación explícita del dueño del proyecto.
- Cada lote de trabajo se desarrolla en su propia rama/worktree aislado,
  se valida completo (sintaxis, tests, suite completa, build) y recién
  ahí se publica como PR separado — sin merge hasta aprobación explícita.
- Una rama de integración temporal que combine dos o más lotes ya
  validados por separado (para mostrar el resultado acumulado en una sola
  Preview) es válida, pero tiene que crearse explícitamente para ese fin,
  aclararlo en su nombre/descripción, y nunca contaminar los PRs
  individuales de cada lote.

## Mejora de proceso propuesta (no implementada — evaluar antes de aplicar)

Un chequeo automático (hook de pre-commit o step de CI) que rechace un
commit si toca archivos fuera del alcance declarado para ese lote. Por
ejemplo: cada rama de lote declara en su primer commit o en un archivo de
metadata qué paths están autorizados, y un hook compara `git diff --stat`
contra esa lista antes de permitir el commit. Esto es una propuesta a
evaluar con el dueño del proyecto — no está implementada, y no debe
implementarse sin aprobación explícita.
