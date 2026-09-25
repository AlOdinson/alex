#!/usr/bin/env bash
set -euo pipefail
test "$GITHUB_REF" = refs/heads/feature/bounded-board-verification-20260925
git merge-base --is-ancestor f1e39d00068b90bf4ce7048439b50db63ae30931 HEAD
python3 - <<'PY'
import base64, gzip, hashlib
from pathlib import Path
encoded = ''.join(Path('.github/bounded-final.patch.gz.base64').read_text().split())
compressed = base64.b64decode(encoded, validate=True)
assert hashlib.sha256(compressed).hexdigest() == '93e91addb851c402fa051780f855845850add16f233d9bc58ba9f5f007238c40', 'Base patch checksum mismatch'
Path('/tmp/bounded-final.patch').write_bytes(gzip.decompress(compressed))
PY
git apply --check /tmp/bounded-final.patch
git apply --index /tmp/bounded-final.patch
git apply --check .github/bounded-finish.patch
git apply --index .github/bounded-finish.patch
python3 - <<'PY'
import base64, gzip, hashlib
from pathlib import Path
encoded = Path('.github/bounded-continuation.patch.gz.base64').read_text().strip()
# Correct transport transcription only. Both checksums must match tested bytes.
for old, new in [('Q8qspZZms', 'Q8qspZms'), ('J7pi6a6sd', 'J7pi6sd'), ('Cb3aeHY', 'Cb3HY'), ('PofLaXrv', 'PofvaXrv')]:
    encoded = encoded.replace(old, new)
compressed = base64.b64decode(encoded, validate=True)
assert hashlib.sha256(compressed).hexdigest() == 'b3d62e3023c455ead56d677eb2d154c41d5576f4ee6d0a4d210a22d72c533e6b', 'Continuation transport checksum mismatch'
patch = gzip.decompress(compressed)
assert hashlib.sha256(patch).hexdigest() == '670761d551f5ebadc701ef108815a98cbc59cc8eda76463c47ac449b0238571f'
Path('/tmp/bounded-continuation.patch').write_bytes(patch)
review = Path('.github/bounded-review.patch').read_bytes()
assert hashlib.sha256(review).hexdigest() == 'c44665da6b4cda5c3471b50dec66d7a37637ff66a5df7196047a68093054d15a', 'Review patch checksum mismatch'
PY
git apply --check /tmp/bounded-continuation.patch
git apply --index /tmp/bounded-continuation.patch
git apply --check .github/bounded-review.patch
git apply --index .github/bounded-review.patch
python3 - <<'PY'
import json
from pathlib import Path
for filename in ('package.json', 'package-lock.json'):
    path = Path(filename)
    data = json.loads(path.read_text())
    data['version'] = '1.36.0'
    if filename == 'package-lock.json': data['packages']['']['version'] = '1.36.0'
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
p = Path('public/version.json')
data = json.loads(p.read_text())
data.update(version='1.36.0', packageVersion='1.36.0', base='1.35.0', date='2026-09-25', name='bounded-new-board-verification', release='Event-driven bounded verification for new boards only', label='Alex Board 1.36.0')
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PY
git add package.json package-lock.json public/version.json
git diff --cached --check
