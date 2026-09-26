# Compra con datos guardados — encargo para Claude

## Decisión de Seba (2026-09-07)

Objetivo: completar nombre, teléfono y dirección en el checkout sin esperar
un correo. Google es opcional; la compra de invitado debe seguir disponible.
El enlace mágico fue detenido por Seba. Conservar su trabajo en su rama;
reutilizar únicamente piezas revisadas, sin integrar ese flujo por accidente.

Seba autorizó este cambio puntual de datos del comprador. Merchant sigue
siendo la única Gran Apuesta activa. No hay autorización de merge, migración
productiva ni despliegue. No mezclar con B12/#325 ni QW2/imágenes.

## División para trabajar en paralelo

- Codex, esfuerzo S: metadatos del autocompletado del navegador en
  `astro-front/src/pages/carrito.astro`. Base `d380374775db7b5d2ef80b09ae97351ccdcd88f9`,
  rama `codex/checkout-autofill`. Sin API, autenticación ni nuevo almacenamiento.
- Claude, esfuerzo M: Google, sesión y perfil mínimo del comprador en una
  rama nueva desde main actualizado, sugerida `claude/checkout-google-profile`.
  Revisar el trabajo detenido antes de reutilizarlo. No fusionar ramas viejas.
- Codex revisa el PR; Seba aprueba cualquier merge/despliegue posterior.

## Lo que ya existe y no hay que reescribir

El checkout ya declara autocomplete para nombre, teléfono, email y dirección.
Ya conserva un borrador en sessionStorage (`amado-checkout-draft-v2`).
La API de pedidos recibe `buyer: { name, phone, email }` y, cuando es envío,
`shipping: { address, locality, department, notes? }`.
Los IDs que deben conservarse son:

| Dato | ID actual | Autocomplete |
| --- | --- | --- |
| Nombre | buyer-name | name |
| Teléfono | buyer-phone | tel |
| Email | buyer-email | email |
| Dirección | delivery-address | shipping street-address |
| Localidad | delivery-barrio | shipping address-level2 |
| Departamento | delivery-departamento | shipping address-level1 |

Codex agrega atributos `name` estables y cambia localidad de address-level3
a address-level2. El campo actual admite barrio/localidad: el autocompletado
puede sugerir una localidad, siempre editable. No hay form nativo con submit:
se conserva el envío mediante los handlers actuales. No prometer que todos
los navegadores ofrecerán datos; depende de sus perfiles y ajustes.

## Experiencia requerida

1. El formulario está disponible de inmediato. Google no es obligatorio.
2. Mostrar un botón oficial «Continuar con Google» cuando esté configurado.
3. Tras identificarse, volver al carrito conservando productos, modalidad
   de entrega, medio de pago elegido y datos ya escritos.
4. Si existe un perfil confirmado por el cliente, permitir «Usar mis datos
   guardados». No sobrescribir texto ya escrito, borrador restaurado ni datos
   autocompletados sin acción expresa del cliente.
5. Si es primera visita, Google puede aportar nombre y correo; el teléfono y
   la dirección vienen del navegador o se completan manualmente. Nunca
   afirmar que el login básico de Google entrega esos dos datos.
6. Permitir guardar/actualizar los datos mediante una acción explícita,
   independiente del pago. Guardar perfil no crea ni modifica un pedido.
7. Si Google o la API de perfil fallan, mantener los datos escritos y permitir
   continuar como invitado. No agregar nuevas pantallas obligatorias.

No incluir Facebook, magic links ni «Mis pedidos» en este alcance inicial.

## Contrato de implementación

- Preferir el flujo oficial de Google Identity Services y una validación
  mantenida compatible con Workers. No implementar criptografía JWT propia.
- Verificar firma, issuer, audience, expiración y las protecciones CSRF/replay
  correspondientes al flujo elegido (nonce/state cuando apliquen).
- Identidad estable por proveedor + `sub`; no unir cuentas ni recuperar
  perfiles privados porque alguien escribió un email en el formulario.
- Guardar sesión y perfil en D1 como fuente autoritativa. Cookie opaca
  `__Host-...`, Secure, HttpOnly, SameSite apropiado; vencimiento y revocación
  comprobados en servidor. Sin tokens de sesión en localStorage.
- Perfil mínimo: buyer.name, buyer.phone y shipping.address/locality/department.
  El email verificado pertenece a la identidad; el email editable del pedido
  no cambia automáticamente la cuenta ni su acceso a datos.
- Endpoints de perfil autenticados y `Cache-Control: no-store`; identidad
  tomada de sesión, lista explícita de campos, consultas parametrizadas y
  protección CSRF en escrituras. No registrar datos personales/tokens en logs.
- El perfil sólo proviene de datos que el cliente decidió guardar. No importar
  automáticamente direcciones de pedidos históricos (pueden ser regalos).
- No tocar cálculo de precios, descuentos, envío, stock, idempotencia,
  Mercado Pago, confirmaciones ni correos de compra. Reutilizar sus validadores.
- Implementar migraciones aditivas con el siguiente número real disponible;
  nunca aplicarlas sobre la base productiva sin aprobación.
- El frontend debe funcionar con la configuración de Google ausente:
  ocultar la opción, preservar invitado, sin simular login ni mostrar éxito.

## Configuración: pedir todo junto, después de revisar lo existente

Inventariar nombres de configuración y bindings sin exponer secretos.
Preparar los orígenes autorizados reales de producción y un Preview estable;
agregar URI de callback exacta sólo si el flujo elegido la utiliza. Un Client
ID web de Google es necesario; pedir Client Secret sólo si ese flujo lo exige.
No solicitar acceso a Gmail, contactos o direcciones mediante People API.
No reutilizar credenciales de Mercado Libre ni credenciales de Merchant.
Si falta configuración, avanzar hasta un Draft probado con dobles y entregar
una sola lista exacta para Seba. No declarar el login real verificado hasta
probar con Google en Preview.

## Aceptación y evidencia

- Invitado, Google nuevo y Google recurrente: nombre/teléfono/dirección
  editables; carrito y borrador conservados; Google cancelado o caído no bloquea.
- Una respuesta tardía de perfil no sobrescribe lo que el cliente escribió.
- Cambiar de cuenta no muestra datos de la cuenta anterior.
- Token inválido/expirado/audience incorrecta y acceso cruzado a perfil fallan.
- Cerrar sesión revoca el acceso; guardar datos no dispara pedidos ni pagos.
- Probar retiro/envío y transferencia/Mercado Pago mediante el instrumental
  existente; ningún test debe crear compras reales ni escribir D1 productivo.
- Ejecutar `scripts/validate-ci.sh` y `git diff --check origin/main...HEAD`.
- Entregar Draft PR, SHA final, CI y demostración Preview con datos ficticios.
  Separar autocompletado real del navegador, Google real y pruebas con dobles.

## Referencias verificadas

- https://developers.google.com/identity/openid-connect/openid-connect
- https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/autocomplete
- https://developers.cloudflare.com/kv/concepts/how-kv-works/
