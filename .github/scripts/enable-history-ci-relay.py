from pathlib import Path
import subprocess
import sys
p = Path('scripts/test-history-device-matrix-e2e.mjs')
s = p.read_text()
s = s.replace('await page.addInitScript(() => {', 'await page.addInitScript((relay) => {', 1)
old = '        super(...args);'
new = "        super(relay ? { ...args[0], iceServers: [relay], iceTransportPolicy: 'relay' } : args[0]);"
assert old in s
s = s.replace(old, new)
old = '  });\n}\nasync function enter'
new = "  }, ENGINE === 'webkit' && process.env.HISTORY_TURN_PASSWORD ? {\n    urls: 'turn:127.0.0.1:3478?transport=udp', username: 'history', credential: process.env.HISTORY_TURN_PASSWORD,\n  } : null);\n}\nasync function enter"
assert old in s
s = s.replace(old, new)
s = s.replace("results.push({ engine: ENGINE,", "results.push({ transport: process.env.HISTORY_TURN_PASSWORD ? 'ci-loopback-turn' : 'production-default-ice', engine: ENGINE,")
p.write_text(s)
subprocess.run([sys.executable,'.github/scripts/history-webkit-input-fixture.py'],check=True)
