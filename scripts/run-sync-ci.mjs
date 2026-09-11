import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fullSyncCommand = packageJson?.scripts?.['test:sync'];
const nativeCanvasStep = 'node scripts/test-pencil-precise-selection.mjs';

if (typeof fullSyncCommand !== 'string' || !fullSyncCommand.trim()) {
  throw new Error('package.json is missing scripts.test:sync');
}

const steps = fullSyncCommand.split(' && ').map((step) => step.trim()).filter(Boolean);
const nativeCanvasIndex = steps.indexOf(nativeCanvasStep);
if (nativeCanvasIndex < 0) {
  throw new Error(`Expected native-canvas regression step was not found: ${nativeCanvasStep}`);
}

const ciSteps = steps.filter((_, index) => index !== nativeCanvasIndex);
if (ciSteps.length !== steps.length - 1) {
  throw new Error('CI-safe sync gate must skip exactly one native-canvas regression step');
}

console.log(`[CI] SKIP ${nativeCanvasStep}: requires a real pixel Canvas implementation; jsdom on the hosted Node runner does not provide HTMLCanvasElement.getContext().`);

const result = spawnSync(ciSteps.join(' && '), {
  cwd: new URL('..', import.meta.url),
  env: process.env,
  shell: true,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
