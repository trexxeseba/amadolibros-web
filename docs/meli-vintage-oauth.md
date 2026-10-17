# Autorización separada de Amado Vintage

La app sigue siendo `4741021817925208`. Agregar una segunda Redirect URI exacta
`https://www.amadolibros.com/meli-vintage-callback` en DevCenter para Vintage.
Conservar `https://www.amadolibros.com/meli-callback` de Amado Libros sin editar
ni borrar. Esta corrección no implementa ni modifica esa ruta anterior.

El flujo se inicia en `/panel/meli-vintage`, con la sesión existente del panel.
Ingresar el correo de Vintage, comprobar la cuenta abierta en Mercado Libre y
continuar. El consentimiento se realiza en Mercado Libre. El callback intercambia
el código con PKCE, consulta `GET /users/me`, comprueba el correo y el site MLU,
rechaza seller `440298103` y AMADOLIBROS COMUY y muestra el seller_id confirmado.

Se requiere `APP_ENV=production`, el binding D1 `ORDERS_DB`, `PANEL_PASSWORD` y
`MELI_VINTAGE_CLIENT_SECRET` de esta misma app configurados en **Cloudflare Pages Production**.
La variable nueva contiene una copia de la clave YA EXISTENTE de la app
4741021817925208. No regenerar la clave en Developers. No editar ni borrar el
CLIENT_SECRET existente de Pages o del Worker de Libros. Vintage no lo lee ni
lo usa como fallback. Se elimina espacio externo accidental al leer la copia.
Que el Worker tenga CLIENT_SECRET no demuestra que Pages tenga la copia correcta.
No copiar secretos al repositorio, al chat ni a capturas. APP_ID es fijo; si se configura
también en Pages debe coincidir.

Las dos tablas adicionales se crean al iniciar el flujo. `ml_oauth_sellers` usa
PRIMARY KEY(app_id,seller_id). El callback sólo inserta cuentas nuevas; nunca hace
UPDATE ni DELETE de credenciales. `ml_oauth` y la clave KV `auth:refresh_token`
quedan intactas y el Worker sigue usando exclusivamente Amado Libros. No se
conecta Vintage al publicador, catálogo, webhooks ni cron. El nuevo registro
conserva access_token, su vencimiento real y refresh_token para su futura gestión
explícita por seller; este cambio no implementa renovación automática de Vintage.

State de un solo uso, caducidad de diez minutos, cookie HttpOnly/Secure/Lax,
PKCE S256, inicio protegido por sesión y Origin, identidad contrastada con el
user_id del intercambio. Respuestas sin tokens, sin scripts ni recursos externos,
no-store/noindex. El callback usa no-referrer; el formulario inicial usa same-origin
para que el POST nativo conserve Origin y pase la validación CSRF estricta.
Middleware excluye estas rutas de analytics y reglas
legacy. Los errores remotos no se imprimen ni se reflejan.

Antes de habilitar: revisar y desplegar este cambio de Pages; verificar bindings
y secretos; visitar el callback sin parámetros (200, o 503 si falta configuración).
No hay llamadas a ML al abrirlo sin parámetros. Abrir el panel en el perfil de
Chrome de Vintage y realizar la autorización desde el inicio protegido. Si el
callback falla después de intercambiar el código, revisar el estado antes de
reautorizar: los códigos son de un solo uso. No reutilizar manualmente códigos
en chats o URLs.

Para diagnosticar sin otra autorización, entrar con sesión del panel a
`/panel/meli-vintage?diagnostico=1`. Envía un código de prueba deliberadamente
inválido al endpoint de tokens y sólo muestra el estado HTTP y códigos de error
permitidos; no usa códigos reales, refresh tokens ni hace escrituras en D1.
`invalid_client` indica rechazo de la identidad de app/clave; `invalid_grant`
por sí solo no demuestra que la clave sea válida, porque el orden de validación
lo determina Mercado Libre. No regenerar la clave de la app ni borrar grants.
Los fallos del callback muestran una etapa fija (`token_exchange`,
`user_identity`, `credential_save`, etc.) y nunca reflejan mensajes remotos,
excepciones, SQL, códigos OAuth, state o tokens. Los logs contienen sólo esa
etapa y el código saneado.

La comprobación pública `/meli-vintage-callback?transporte=1` hace exclusivamente
GET `https://api.mercadolibre.com/sites/MLU`, sin credenciales ni acceso a D1, con
caché de un minuto por instancia. No acepta URLs, headers ni vendedores elegidos
por quien consulta. Permite verificar el transporte sin una sesión del panel.
El transporte usa AbortController, timer de 15 s que cubre también la lectura de
JSON y redirect manual como el Worker existente: los 3xx se rechazan sin seguir
el destino. Distingue timeout, DNS, TLS, configuración de solicitud, error de
fetch y respuesta no JSON mediante categorías fijas; no desactiva controles TLS
ni expone detalles remotos.

Validación local: `node --test functions/__tests__/meli-vintage-oauth.test.js`.
Las APIs de ML se simulan. Ninguna prueba usa secretos reales, llama a ML ni
accede a la base de producción.

Referencia oficial: https://developers.mercadolibre.com.uy/es_ar/autenticacion-y-autorizacion
