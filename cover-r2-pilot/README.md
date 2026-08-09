# Piloto de portadas en R2 (20 imágenes)

Worker aislado para comprobar la descarga, validación y conservación de
portadas de Mercado Libre antes de diseñar una migración de catálogo completa.

## Límites de seguridad

- Bucket único: `amadolibros-images-preview` mediante `COVER_R2`.
- No importa ni comparte rutas con `worker-sync`.
- Sin cron y sin rutas de dominio; sólo `workers.dev` de Preview.
- `POST /import` y `GET /status` requieren `Authorization: Bearer ...` con el
  secret exclusivo `COVER_PILOT_SECRET`.
- Máximo duro de 20 entradas por request.
- Sólo URLs HTTPS de `http2.mlstatic.com`; no sigue redirecciones.
- Máximo 8 MiB por imagen; acepta JPEG, PNG o WebP con MIME, firma, estructura
  y dimensiones coherentes (100–12.000 px).
- No modifica `catalog.json`, `home.json`, Pages, fichas, catálogo ni checkout.
- No elimina objetos durante el piloto.

## Escritura segura y refresco

La imagen se guarda como objeto inmutable por hash:

`covers/v1/objects/{sha256}.{ext}`

El puntero mutable es `covers/v1/manifest.json` y se escribe último. Si una
descarga, validación o escritura falla, el manifiesto conserva `current` y la
última copia válida. Si el manifest falla después de escribir la imagen, queda
un objeto huérfano recuperable, no una portada rota.

Una URL nueva se valida en la siguiente ejecución. La misma URL se considera
vigente durante 30 días y luego se revalida con `If-None-Match` y/o
`If-Modified-Since` cuando Mercado Libre entrega validadores. Si el contenido
cambia con la misma URL, cambia el SHA-256 y el manifiesto apunta al objeto
nuevo sólo después del readback de R2.

Para una migración completa, el barrido debe escalonarse: imágenes nuevas o
con URL distinta primero; después `1/30` del catálogo por día. Los objetos sin
referencias se conservarán 90 días y se eliminarán sólo mediante un lote
separado, después de confirmar que ningún producto activo o pausado los usa.

## Costo orientativo del catálogo completo

Con 17.478 imágenes:

- 250 KiB promedio: ~4,37 GB.
- 500 KiB promedio: ~8,74 GB.
- 1 MiB promedio: ~17,48 GB.
- Importación inicial: 17.478 escrituras de objetos más escrituras pequeñas de
  manifiesto (menos del 1,8% del millón de operaciones Class A incluidas).

El costo incremental esperado es USD 0 mientras la cuenta completa permanezca
dentro de la franquicia mensual vigente de R2. Si las imágenes promediaran
1 MiB y el resto de la cuenta no consumiera espacio incluido, el excedente
orientativo sería ~8 GB, unos USD 0,12/mes a USD 0,015 por GB-mes. Debe
recalcularse con el consumo real de toda la cuenta antes de ampliar el piloto.

## Request de importación

```json
{
  "items": [
    {
      "product_id": "MLU123456789",
      "position": 0,
      "url": "https://http2.mlstatic.com/D_NQ_NP_...-O.webp"
    }
  ]
}
```

El HTTP 200 indica que todas las entradas terminaron sin error; HTTP 207
indica resultado mixto. Cada resultado informa `imported`, `revalidated`,
`not-modified`, `fresh-skip` o `failed`.
