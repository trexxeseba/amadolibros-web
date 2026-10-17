"""Read-only inventory. No image requests, deployments, R2 writes or tokens in output."""
import gzip
import hashlib
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

BUCKET = 'amadolibros-images-production'
PREFIX = 'covers/variants/v1/'
RECIPES = ['v1-240-q85', 'v1-360-q85', 'v1-480-q85']
BASE_SHA = '29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def read(url, headers=None, allow_signed_redirect=False):
    # This module issues GET only. Never forward auth to a redirected host.
    request = urllib.request.Request(url, headers=headers or {}, method='GET')
    try:
        with OPENER.open(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if allow_signed_redirect and error.code in (301, 302, 303, 307, 308):
            target = error.headers.get('Location', '')
            if urllib.parse.urlparse(target).scheme != 'https':
                raise RuntimeError('invalid-artifact-redirect')
            return read(target)
        # Avoid printing credential-bearing request headers or account URLs.
        raise RuntimeError(f'read-http-{error.code}') from None


def main():
    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID')
    if not token or not account:
        raise RuntimeError('existing-actions-cloudflare-secrets-unavailable')
    headers = {'Authorization': f'Bearer {token}'}
    objects = {}
    cursor = None
    list_requests = 0
    while True:
        query = {'prefix': PREFIX, 'per_page': '1000'}
        if cursor:
            query['cursor'] = cursor
        url = (f'https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/'
               f'{BUCKET}/objects?' + urllib.parse.urlencode(query))
        data = json.loads(read(url, headers))
        list_requests += 1
        if data.get('success') is not True or not isinstance(data.get('result'), list):
            codes = [row.get('code') for row in data.get('errors', [])]
            raise RuntimeError('r2-list-rejected-codes-' + ','.join(map(str, codes)))
        for row in data['result']:
            if isinstance(row.get('key'), str) and row['key'].startswith(PREFIX):
                objects[row['key']] = row
        info = data.get('result_info') or {}
        if not info.get('is_truncated'):
            break
        next_cursor = info.get('cursor')
        if not next_cursor or next_cursor == cursor:
            raise RuntimeError('invalid-inventory-pagination')
        cursor = next_cursor

    gh_headers = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                  'Accept': 'application/vnd.github+json', 'User-Agent': 'r2-readonly-inventory'}
    archive = read('https://api.github.com/repos/trexxeseba/amadolibros-web/actions/'
                   'artifacts/12087843537/zip', gh_headers, allow_signed_redirect=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as saved:
        raw = gzip.decompress(saved.read('manifest-snapshot.json.gz'))
        baseline = json.loads(saved.read('report.json'))
    digest = hashlib.sha256(raw).hexdigest()
    if digest != baseline['snapshot']['manifest_sha256'] or baseline['head'] != BASE_SHA:
        raise RuntimeError('baseline-snapshot-integrity-failed')
    manifest = json.loads(raw)
    ids = set(json.loads(Path('scripts/images/inventory-external-ids.json').read_text()))
    catalog = json.loads(read('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json'))
    targets = {}
    unmatched = []
    active_count = 0
    def source_url(value):
        parsed = urllib.parse.urlsplit(value or '')
        return urllib.parse.urlunsplit(('https', parsed.netloc, re.sub(r'-I\.(jpg|jpeg|png|webp)$', r'-O.\1', parsed.path), parsed.query, ''))
    for item in catalog['items']:
        if item['id'] not in ids or item.get('status') != 'active' or item.get('available_quantity', 0) <= 0:
            continue
        active_count += 1
        current = (manifest['entries'].get(item['id'] + ':0') or {}).get('current') or {}
        sha = current.get('sha256', '')
        pictures = item.get('pictures') or [item.get('thumbnail')]
        if (not re.fullmatch('[a-f0-9]{64}', sha)
                or not re.fullmatch(r'covers/v1/objects/' + sha + r'\.(jpg|png|webp)', current.get('object_key', ''))
                or source_url(pictures[0]) != source_url(current.get('source_url'))):
            unmatched.append(item['id'])
            continue
        targets.setdefault(sha, {'master': current['object_key'], 'product_ids': []})['product_ids'].append(item['id'])

    counts = {'valid': 0, 'absent': 0, 'invalid': 0, 'metadata_unverified': 0}
    expected_variants = 0
    for sha, target in sorted(targets.items()):
        for recipe in RECIPES:
            key = f'{PREFIX}{sha}/{recipe}.webp'
            obj = objects.get(key)
            state = 'absent'
            if obj is not None:
                meta = obj.get('custom_metadata')
                http = obj.get('http_metadata')
                if not isinstance(meta, dict) or not isinstance(http, dict) or not meta:
                    state = 'metadata_unverified'
                else:
                    valid = (meta.get('master_sha256') == sha and meta.get('recipe') == recipe
                             and re.fullmatch('[a-f0-9]{64}', meta.get('sha256', ''))
                             and http.get('contentType') == 'image/webp' and obj.get('size', 0) > 0)
                    state = 'valid' if valid else 'invalid'
            counts[state] += 1
            expected_variants += 1
    summary = {'status': 'completed', 'baseline_commit': BASE_SHA, 'bucket': BUCKET,
               'checked_at': datetime.now(timezone.utc).isoformat(),
               'snapshot_updated_at': manifest.get('updated_at'), 'catalog_updated_at': catalog.get('updated_at'),
               'external_card_ids': len(ids), 'active_cards': active_count, 'unique_masters': len(targets),
               'unmatched_active_count': len(unmatched), 'recipes': RECIPES, 'expected_variants': expected_variants,
               'variant_states': counts, 'listed_variant_objects': len(objects), 'list_requests': list_requests,
               'production_writes': 0, 'image_requests': 0, 'deployments': 0}
    # Only aggregate counts leave memory. No object keys, hashes, product IDs,
    # source manifests or per-object metadata are published as artifacts/logs.
    print(json.dumps(summary))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
        stream.write('```json\n' + json.dumps(summary, indent=2) + '\n```\n')


try:
    main()
except Exception as error:
    message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    summary = {'status': 'blocked', 'reason': message, 'bucket': BUCKET,
               'required_permission': 'Workers R2 Storage Read on the existing Actions token',
               'production_writes': 0, 'image_requests': 0, 'deployments': 0}
    print(json.dumps(summary))
    sys.exit(1)
