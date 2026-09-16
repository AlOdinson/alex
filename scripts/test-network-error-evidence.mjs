import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecoveredTokenNetworkDiagnostic } from './network-error-evidence.mjs';
const tokenUrl = 'https://project.example/functions/v1/ably-browser-token';
const diagnostic = {
  origin: 'pageerror', device: 'tablet', navigation: 2, at: 5000,
  name: 'Fetch API cannot load https',
  error: '/project.example/functions/v1/ably-browser-token due to access control checks.', stack: '',
};
const failed = { kind: 'failed', device: 'tablet', navigation: 2, at: 5001, url: tokenUrl, method: 'POST' };
const recovered = { kind: 'finished', device: 'tablet', navigation: 2, at: 16000, url: tokenUrl, method: 'POST', status: 200 };
const classify = (entry = diagnostic, events = [failed, recovered], engine = 'webkit') =>
  isRecoveredTokenNetworkDiagnostic(entry, { events, tokenUrl, engine });

test('native WebKit token diagnostic requires a failed request followed by a successful same-document retry', () => {
  assert.equal(classify(), true);
});
for (const [name, entry, events, engine] of [
  ['uncaught JavaScript exception', { ...diagnostic, stack: 'at insertImage (Board.jsx:40)' }],
  ['actual window error event', { ...diagnostic, origin: 'window-error' }],
  ['unhandled promise rejection', { ...diagnostic, origin: 'unhandledrejection' }],
  ['unrelated endpoint', { ...diagnostic, error: '/project.example/storage/image.png due to access control checks.' }],
  ['no failed token request', diagnostic, [recovered]],
  ['no successful retry', diagnostic, [failed]],
  ['retry before the failure', diagnostic, [failed, { ...recovered, at: 4000 }]],
  ['recovery only on another device', diagnostic, [failed, { ...recovered, device: 'phone' }]],
  ['recovery only after reload', diagnostic, [failed, { ...recovered, navigation: 3 }]],
  ['HTTP permission failure', diagnostic, [failed, { ...recovered, status: 403 }]],
  ['unrelated old request failure', diagnostic, [{ ...failed, at: 100 }, recovered]],
  ['Chromium error', diagnostic, [failed, recovered], 'chromium'],
]) {
  test(`${name} is never excused as recovered WebKit diagnostics`, () => {
    assert.equal(classify(entry, events, engine), false);
  });
}
