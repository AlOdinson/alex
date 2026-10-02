"""Transfer a hash-pinned, locally tested patch; never update branches or deploy."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

BASE = '21b8048ff85ed6652c7005783f56f1567b4d68bc'
here = Path(__file__).resolve().parent
target = here.parent / 'target'
manifest = json.loads((here / 'notebook-drop-manifest.json').read_text())

def git(*args):
    return subprocess.check_output(['git', '-C', str(target), *args], text=True).strip()

assert git('rev-parse', 'HEAD') == BASE, 'Unexpected baseline'
if '--publish-blobs' not in sys.argv:
    parts = ''.join((here / f'notebook-drop-part-{i}.txt').read_text().strip() for i in range(7))
    patch = gzip.decompress(base64.b64decode(parts, validate=True))
    subprocess.run(['git', '-C', str(target), 'apply', '--check', '-'], input=patch, check=True)
    subprocess.run(['git', '-C', str(target), 'apply', '-'], input=patch, check=True)

changed = set(git('diff', '--name-only').splitlines()) | set(git('ls-files', '--others', '--exclude-standard').splitlines())
assert changed == set(manifest), ('Unexpected changed paths', changed)
for path, expected in manifest.items():
    assert not Path(path).is_absolute() and '..' not in Path(path).parts
    data = (target / path).read_bytes()
    actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    assert actual == expected, f'Content mismatch: {path}'
print('Verified exact baseline and all', len(manifest), 'source blob hashes')

if '--publish-blobs' in sys.argv:
    token = os.environ['GH_TOKEN']
    result = {}
    for path, expected in manifest.items():
        payload = json.dumps({'encoding': 'base64', 'content': base64.b64encode((target / path).read_bytes()).decode()}).encode()
        req = urllib.request.Request('https://api.github.com/repos/AlOdinson/alex/git/blobs', data=payload,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'}, method='POST')
        with urllib.request.urlopen(req, timeout=60) as response:
            value = json.load(response)
        assert value['sha'] == expected, f'Remote content mismatch: {path}'
        result[path] = value['sha']
    Path('/tmp/notebook-drop-blobs.json').write_text(json.dumps(result, indent=2))
    print('Created 12 immutable source blobs; no refs, branches or deployments modified')
