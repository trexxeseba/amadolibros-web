-- SEO-CRAWL-COHORT-1
-- Separa la observabilidad de fichas activas, por encargo y otras pausadas.
-- Conserva la tabla v1 para continuidad y no guarda IP, user-agent ni URL.

CREATE TABLE IF NOT EXISTS crawl_stats_segmented (
    date TEXT NOT NULL,
    pattern TEXT NOT NULL,
    segment TEXT NOT NULL,
    status INTEGER NOT NULL,
    verified INTEGER NOT NULL,
    ua_googlebot INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    bytes_sum INTEGER NOT NULL DEFAULT 0,
    bytes_known_count INTEGER NOT NULL DEFAULT 0,
    duration_ms_sum REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, pattern, segment, status, verified, ua_googlebot)
);

CREATE INDEX IF NOT EXISTS idx_crawl_stats_segmented_date_segment
    ON crawl_stats_segmented (date, segment);

-- Los datos anteriores no permiten reconstruir disponibilidad sin guardar URL.
-- Se preservan explícitamente como históricos no segmentados, sin inventar una
-- clasificación retroactiva.
INSERT OR IGNORE INTO crawl_stats_segmented (
    date,
    pattern,
    segment,
    status,
    verified,
    ua_googlebot,
    request_count,
    bytes_sum,
    bytes_known_count,
    duration_ms_sum
)
SELECT
    date,
    pattern,
    'historical_unsegmented',
    status,
    verified,
    ua_googlebot,
    request_count,
    bytes_sum,
    bytes_known_count,
    duration_ms_sum
FROM crawl_stats;
