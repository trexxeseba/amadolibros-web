# Amado Operaciones: acceso de lectura desde ChatGPT

`POST /operations/read` conecta el complemento privado de Amado con la API de
Mercado Libre a través del Worker existente. El Worker conserva el manejo de la
autorización DSAAS y su refresh token rotativo; no exporta credenciales al
complemento. No cambia Client Secret, redirecciones ni notificaciones.

El endpoint valida una firma ECDSA P-256/SHA-256 y un sobre con audiencia,
emisor, cuenta, ruta, acción, argumentos y vencimiento de hasta 60 segundos.
La clave pública está fijada en `operations-read.js`; la privada se guarda como
secreto en el Site privado `appgprj_6ad0d1c8b5d48191a2a60add6a0dea70`.
Una rotación requiere actualizar la pública y el secreto del Site coordinadamente.

Las únicas acciones admitidas son:

- `cuenta`: GET `/users/me`, comprobando seller 440298103.
- `listar_publicaciones`: GET de búsqueda del vendedor, con estado y scroll.
- `consultar_publicaciones`: GET de hasta 20 ítems, comprobando que pertenecen a Amado.

No admite URL, vendedor, método ni ruta arbitrarios. Cada consulta devuelve
fuente y fecha; errores de red o autorización no se traducen en stock cero.
Las listas son paginadas. No existe aún un cruce exhaustivo por ISBN ni una
herramienta para publicar, modificar, pausar o borrar publicaciones.

El access token se mantiene como máximo tres minutos en memoria del isolate;
la renovación sigue usando `meli-auth.js` y sus controles existentes. Los
secretos OAuth permanecen dentro del Worker. El resto de rutas conserva su
autenticación anterior con `SYNC_SECRET`.
