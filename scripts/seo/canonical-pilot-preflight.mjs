const ISBN_RE = /^(?:\d{10}|\d{13})$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushIf(condition, list, code) {
  if (condition) list.push(code);
}

export function evaluateCanonicalPilotPair(pair = {}) {
  const blockers = [];
  const warnings = [];
  const target = pair.target || {};
  const source = pair.source || {};

  pushIf(!isNonEmptyString(pair.name), blockers, 'missing_name');
  pushIf(!ISBN_RE.test(String(pair.isbn || '').replace(/\D/g, '')), blockers, 'invalid_isbn');
  pushIf(pair.mlOrigin !== 'ml_common_plus_catalog', blockers, 'ml_origin_not_common_plus_catalog');
  pushIf(pair.sameCatalogProductId !== true, blockers, 'catalog_product_id_not_shared');
  pushIf(pair.sameCondition !== true, blockers, 'condition_mismatch');
  pushIf(pair.sameTitleAuthor !== true, blockers, 'title_author_mismatch');
  pushIf(pair.languageConflict === true, blockers, 'language_conflict');

  pushIf(!isNonEmptyString(target.id) || !isNonEmptyString(source.id), blockers, 'missing_listing_id');
  pushIf(target.id && source.id && target.id === source.id, blockers, 'source_equals_target');
  pushIf(!isNonEmptyString(target.url) || !isNonEmptyString(source.url), blockers, 'missing_url');

  pushIf(target.statusCode !== 200, blockers, 'target_not_200');
  pushIf(target.indexable !== true, blockers, 'target_not_indexable');
  pushIf(target.selfCanonical !== true, blockers, 'target_not_self_canonical');
  pushIf(target.indexVerdict !== 'PASS', blockers, 'target_not_indexed');
  pushIf(target.coverageState !== 'Submitted and indexed', blockers, 'target_not_submitted_and_indexed');
  pushIf(target.orphan === true, blockers, 'target_orphan');

  pushIf(source.statusCode !== 200, blockers, 'source_not_200');
  pushIf(source.indexable !== true, blockers, 'source_not_indexable');
  pushIf(source.selfCanonical !== true, blockers, 'source_not_self_canonical_before_pilot');

  if (source.indexVerdict === 'PASS' && target.indexVerdict === 'PASS') {
    warnings.push('both_urls_currently_indexed');
  }
  if (source.coverageState === 'Duplicate, Google chose different canonical than user') {
    warnings.push('google_already_treats_source_as_duplicate');
  }
  const targetLinks = Number(target.internalLinks || 0);
  const sourceLinks = Number(source.internalLinks || 0);
  if (targetLinks + 3 < sourceLinks) {
    warnings.push('target_has_materially_fewer_internal_links');
  }
  const targetWords = Number(target.wordCount || 0);
  const sourceWords = Number(source.wordCount || 0);
  if (sourceWords > 0 && targetWords < sourceWords * 0.8 && sourceWords - targetWords >= 50) {
    warnings.push('target_has_materially_less_content');
  }
  if (Number(target.impressions28d || 0) < Number(source.impressions28d || 0)) {
    warnings.push('target_has_fewer_recent_impressions');
  }

  return {
    pair: pair.name || null,
    isbn: String(pair.isbn || '').replace(/\D/g, '') || null,
    sourceId: source.id || null,
    targetId: target.id || null,
    status: blockers.length === 0 ? 'ready_for_preview_canonical_proposal' : 'blocked',
    blockers,
    warnings,
  };
}

export function evaluateCanonicalPilot(evidence = {}) {
  const pairs = Array.isArray(evidence.pairs) ? evidence.pairs : [];
  const results = pairs.map(evaluateCanonicalPilotPair);
  return {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    pairCount: results.length,
    readyCount: results.filter(r => r.status === 'ready_for_preview_canonical_proposal').length,
    blockedCount: results.filter(r => r.status === 'blocked').length,
    results,
  };
}
