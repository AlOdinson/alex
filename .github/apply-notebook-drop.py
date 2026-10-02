"""One-time delivery of the reviewed patch; removed before the product commit.
The text connector has no local-file upload. Pin both the received text and
uncompressed patch, correcting five observed transcription differences only.
No change is applied unless the original local patch SHA256 matches exactly.
"""
import base64
import gzip
import hashlib
from pathlib import Path
import subprocess
import tempfile

encoded = Path('.github/notebook-drop.patch.gz.b64').read_text().strip()
assert hashlib.sha256(encoded.encode()).hexdigest() == 'bf76d2bdea0f416438becd197f0bcac054bf7c22e392b84e4af94905a78b9f2c', 'Unexpected delivered text'
for start, end, previous, replacement in [
    (4871, 4872, 'g', 'i'),
    (4785, 4785, '', 'J'),
    (1448, 1449, '2', ''),
    (869, 873, 'f176', ''),
    (256, 257, '1', ''),
]:
    assert encoded[start:end] == previous
    encoded = encoded[:start] + replacement + encoded[end:]
patch = gzip.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == '838507530895314cebd6fdc48e64af3d9c118be4d7cca820774c3eecf46a9011', 'Patch differs from locally tested source'
with tempfile.NamedTemporaryFile(suffix='.patch') as output:
    output.write(patch)
    output.flush()
    subprocess.run(['git', 'apply', '--check', '--index', output.name], check=True)
    subprocess.run(['git', 'apply', '--index', output.name], check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], check=True)
print('Applied exact reviewed patch: 838507530895314cebd6fdc48e64af3d9c118be4d7cca820774c3eecf46a9011')
