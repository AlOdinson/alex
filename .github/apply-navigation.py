"""Temporary text-connector delivery. Apply only the exact locally tested diff."""
import base64
import gzip
import hashlib
from pathlib import Path
import subprocess
import tempfile

parts = [Path(f'.github/navigation-part-{i}.b64').read_text().strip() for i in (1, 2, 3)]
# Restore one observed missing span in the first text transmission. This never
# permits a different patch: both the complete encoding and decoded diff are pinned.
missing = 'x/NMDJL5PJk0x9FoLoZJOo1STz1L49Mz8xA74BdiCJ2kkS9wXMk4vLWTRWMYN4y2mUzHSzEaJzD26SkMZBqNRZyJNJokF1Hoi9eqpcjm8XgsssVsNo6jTMxxjvDVRXRrZ5QGkwi+yeJfReIMOh5HmS8eJwsYfXM4jofnDBxmOUcUMKhkFk0ZTnQJCMUmURjPk9RHHD4JhmcaiQAUW6YRjH8W/HIRiccvnsE4x9BX5ol38fxMZJ'
if 'cTTLIZJMAgA7HUTC' in parts[0]:
    assert parts[0].count('cTTLIZJMAgA7HUTC') == 1
    parts[0] = parts[0].replace('cTTLIZJMAgA7HUTC', 'cTTLIZJ' + missing + 'MAgA7HUTC')
encoded = ''.join(parts)
print('Encoded length:', len(encoded), 'SHA256:', hashlib.sha256(encoded.encode()).hexdigest(), flush=True)
assert hashlib.sha256(encoded.encode()).hexdigest() == '40f72be8457b9d3dcf6cd11709a97f245a5a927fa378a833254de2f6b46736e6', 'Delivered text differs'
patch = gzip.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == '9a81db90cea3ad8862494337c464d3ad8bdfeaf4277d6ba4d51e4cacd60da2ae', 'Patch differs from locally tested source'
with tempfile.NamedTemporaryFile(suffix='.patch') as output:
    output.write(patch)
    output.flush()
    subprocess.run(['git', 'apply', '--check', '--index', output.name], check=True)
    subprocess.run(['git', 'apply', '--index', output.name], check=True)
for followup in sorted(Path('.github').glob('navigation-followup-*.patch')):
    subprocess.run(['git', 'apply', '--check', '--index', str(followup)], check=True)
    subprocess.run(['git', 'apply', '--index', str(followup)], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
print('Applied exact navigation patch and any reviewed follow-ups', flush=True)
