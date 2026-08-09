// Política única de frescura para /api/status.
//
// Los monitores externos y el smoke no deben duplicar estos números:
// ambos consumen el contrato HTTP de /api/status (200 sano, 503 degradado).
export const STATUS_SYNC_STALE_MS = 26 * 60 * 60 * 1000;
export const STATUS_SYNC_STUCK_MS = 45 * 60 * 1000;
