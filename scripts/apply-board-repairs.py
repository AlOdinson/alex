#!/usr/bin/env python3
"""Reproduce regressions first, then apply the reviewed source diff."""
import base64, lzma, pathlib, subprocess, sys
mode = sys.argv[1] if len(sys.argv) == 2 else ''
if mode not in ('--tests', '--apply'):
    raise SystemExit('Use --tests or --apply')
root = pathlib.Path(__file__).parent / '.board-repair-payload'
prefix = 'TESTS' if mode == '--tests' else 'SOURCE'
encoded = ''.join(p.read_text().strip() for p in sorted(root.glob(prefix + '*.txt')))
patch = lzma.decompress(base64.b64decode(encoded))
subprocess.run(['git', 'apply', '--unidiff-zero', '--check', '-'], input=patch, check=True)
subprocess.run(['git', 'apply', '--unidiff-zero', '-'], input=patch, check=True)
