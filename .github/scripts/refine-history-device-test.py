from pathlib import Path
p = Path('scripts/test-history-device-matrix-e2e.mjs')
s = p.read_text()
old = ".filter((key) => !['updatedAt', 'updatedBy', 'version', 'createdBy'].includes(key))"
new = ".filter((key) => !['updatedAt', 'updatedBy', 'version', 'createdBy'].includes(key))\n        .filter((key) => !(['transientPreview', 'transientLiveDraw', 'transientAwaitingCommit'].includes(key) && value[key] === false))"
assert old in s
s = s.replace(old, new)
s = s.replace("    // Reproducible acknowledgement latency", "    window.__historyPeerStates = [];\n    const NativePeer = window.RTCPeerConnection;\n    if (NativePeer) window.RTCPeerConnection = class extends NativePeer {\n      constructor(...args) {\n        super(...args);\n        this.__historyCandidates = [];\n        this.addEventListener('icecandidate', (event) => { if (event.candidate) this.__historyCandidates.push(event.candidate.type); });\n        window.__historyPeerStates.push(this);\n      }\n    };\n    // Reproducible acknowledgement latency")
s = s.replace("    page.on('pageerror', (error) => errors.push(`${profiles[index].name}: ${error.message}`));", "    page.on('pageerror', (error) => errors.push(`${profiles[index].name}: ${error.message}`));\n    page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) console.log('BROWSER', profiles[index].name, message.text()); });")
s = s.replace("text: document.body.innerText }", "text: document.body.innerText, peers: (window.__historyPeerStates ?? []).map((p) => ({ state: p.connectionState, ice: p.iceConnectionState, gathering: p.iceGatheringState, signaling: p.signalingState, local: p.localDescription?.type, remote: p.remoteDescription?.type, candidates: p.__historyCandidates })) }")
s = s.replace("page.getByLabel('Цвет выбранного', { exact: true })", "page.locator('.selection-floating-proxy input[data-selection-proxy-input=\"color\"]')")
s = s.replace("  } catch (error) {\n    for (const [index, page]", "  } catch (error) {\n    fs.writeFileSync(`history-e2e-results/${ENGINE}-failure.json`, JSON.stringify({ ownerIndex, message: error.message, stack: error.stack, errors }, null, 2));\n    for (const [index, page]")
p.write_text(s)
