import pathlib
import base64
import gzip
import hashlib
import subprocess
import sys

text = pathlib.Path('.github/scripts/history-implementation.patch.gz.b64').read_text().strip()
corrections = [[485,486,'g','w'],[607,608,'','2'],[7759,7760,'T','t'],[7996,7998,'','3f'],[17252,17253,'','9']]
for start, end, new, old in reversed(corrections):
    assert text[start:end] == old
    text = text[:start] + new + text[end:]
data = gzip.decompress(base64.b64decode(text))
assert hashlib.sha256(data).hexdigest() == '0aa0f89325338cea688bfff4f5fa1061e91d3915feb4e0994ee49fe40e99a2b0'
patch = pathlib.Path('/tmp/history-implementation.patch')
patch.write_bytes(data)
subprocess.run(['git', 'apply', '--check', str(patch)], check=True)
subprocess.run(['git', 'apply', str(patch)], check=True)
subprocess.run(['git', 'apply', '--check', '.github/scripts/history-dock.patch'], check=True)
subprocess.run(['git', 'apply', '.github/scripts/history-dock.patch'], check=True)
subprocess.run([sys.executable, '.github/scripts/refine-history-device-test.py'], check=True)
p = pathlib.Path('package.json')
s = p.read_text()
old = 'node --test scripts/test-filled-board-join.mjs'
assert old in s
s = s.replace(old, 'node --test scripts/test-history-dock-layout.mjs scripts/test-history-regressions.mjs scripts/test-history-deadlines.mjs scripts/test-history-inverses.mjs scripts/test-filled-board-join.mjs')
p.write_text(s)
subprocess.run(['git', 'diff', '--check'], check=True)
