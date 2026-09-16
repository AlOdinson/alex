// Test-only classification. WebKit's native fetch diagnostic can be emitted as
// Playwright pageerror, even when fetch rejection is caught. Never excuse JS
// exceptions, unmatched failures, or recovery that required another navigation.
export function isRecoveredTokenNetworkDiagnostic(entry, { engine, tokenUrl, events = [] } = {}) {
  if (engine !== 'webkit' || entry?.origin !== 'pageerror' || entry.stack !== '') return false;
  if (!Number.isInteger(entry.navigation) || !Number.isFinite(entry.at)) return false;
  let url;
  try { url = new URL(tokenUrl); } catch { return false; }
  if (url.protocol !== 'https:' || url.pathname !== '/functions/v1/ably-browser-token') return false;
  const suffix = ' due to access control checks.';
  const full = `Fetch API cannot load ${url.href}${suffix}`;
  // Playwright 1.55 splits native console text at the first colon, stripping
  // the colon and next character. Preserve that exact observed native shape.
  const nativeText = entry.error === full
    || (entry.name === 'Fetch API cannot load https' && entry.error === `/${url.host}${url.pathname}${suffix}`);
  if (!nativeText) return false;
  const sameRequest = (event) => event.device === entry.device
    && event.navigation === entry.navigation && event.url === url.href && event.method === 'POST';
  return events.some((failed) => sameRequest(failed) && failed.kind === 'failed'
    && Math.abs(failed.at - entry.at) <= 2000
    && events.some((done) => sameRequest(done) && done.kind === 'finished'
      && done.at > Math.max(failed.at, entry.at) && done.status >= 200 && done.status < 300));
}
