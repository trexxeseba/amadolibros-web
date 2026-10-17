"""Recover the existing frozen manifest; do not fetch images or publish metadata."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import urllib.request
import urllib.error
import zipfile

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

url = 'https://api.github.com/repos/trexxeseba/amadolibros-web/actions/artifacts/12087843537/zip'
request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
    'User-Agent': 'amado-frozen-card-plan/1.0', 'Accept': 'application/vnd.github+json'})
try:
    response = urllib.request.build_opener(NoRedirect).open(request, timeout=60)
except urllib.error.HTTPError as error:
    if error.code != 302:
        raise RuntimeError('frozen-artifact-http-' + str(error.code)) from None
    target = error.headers['Location']
    if not target.startswith('https://'):
        raise RuntimeError('invalid-artifact-redirect')
    response = urllib.request.urlopen(target, timeout=60)  # No authorization forwarded.
with response:
    archive = response.read()
with zipfile.ZipFile(io.BytesIO(archive)) as saved:
    raw = gzip.decompress(saved.read('manifest-snapshot.json.gz'))
    report = json.loads(saved.read('report.json'))
if (hashlib.sha256(raw).hexdigest() != report['snapshot']['manifest_sha256'] or
        report['head'] != '29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea'):
    raise RuntimeError('frozen-snapshot-integrity-failed')
Path(os.environ['RUNNER_TEMP'], 'card-manifest.json').write_bytes(raw)
print('Frozen manifest integrity verified; no image requests or production writes.')
