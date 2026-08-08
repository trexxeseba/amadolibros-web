-- SEO-CRAWL-LOGS-3
-- Agregación diaria de observabilidad de crawl.
-- No guarda IP, user-agent ni path/URL crudos.
-- El middleware también ejecuta CREATE TABLE IF NOT EXISTS en background
-- para que el rollout no dependa de aplicar esta migración antes del deploy.

CREATE TABLE IF NOT EXISTS crawl_stats (
    date TEXT NOT NULL,
    pattern TEXT NOT NULL,
    status INTEGER NOT NULL,
    verified INTEGER NOT NULL,
    ua_googlebot INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    bytes_sum INTEGER NOT NULL DEFAULT 0,
    bytes_known_count INTEGER NOT NULL DEFAULT 0,
    duration_ms_sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, pattern, status, verified, ua_googlebot)
);
