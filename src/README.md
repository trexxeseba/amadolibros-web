# Scripts de Sincronización

## amadolibros-sync.js

Script de sincronización incremental que:
- Obtiene items de Mercado Libre
- Detecta cambios (SOLO sincroniza lo que cambió)
- Guarda en Cloudflare KV
- Se ejecuta cada hora automáticamente
