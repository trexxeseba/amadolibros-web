function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function representationEtag(body) {
  const bytes = new TextEncoder().encode(String(body ?? ''));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `"sha256-${bytesToHex(digest)}"`;
}

function normalizeWeakTag(value) {
  const trimmed = String(value || '').trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

export function ifNoneMatchMatches(headerValue, etag) {
  if (!headerValue) return false;
  const expected = normalizeWeakTag(etag);
  return String(headerValue)
    .split(',')
    .map(value => value.trim())
    .some(value => value === '*' || normalizeWeakTag(value) === expected);
}

export async function conditionalResponse(request, body, {
  status = 200,
  headers = {},
  enable = true,
} = {}) {
  if (!enable || status !== 200) {
    return new Response(body, { status, headers });
  }

  const etag = await representationEtag(body);
  const responseHeaders = new Headers(headers);
  responseHeaders.set('etag', etag);

  const method = String(request?.method || 'GET').toUpperCase();
  const canValidate = method === 'GET' || method === 'HEAD';
  if (canValidate && ifNoneMatchMatches(request?.headers?.get?.('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: responseHeaders,
    });
  }

  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: responseHeaders,
  });
}
