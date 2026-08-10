-- EMAIL-COMPRA-2: el checkout guarda el correo normalizado para enviar la
-- confirmación correcta según el medio de pago. Las órdenes históricas quedan
-- con NULL; las nuevas lo exigen en la validación de la API.
ALTER TABLE orders ADD COLUMN buyer_email TEXT;
