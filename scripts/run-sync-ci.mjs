import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fullSyncCommand = packageJson?.scripts?.['test:sync'];
const nativeCanvasSteps = new Set([
  'node scripts/test-pencil-precise-selection.mjs',
  'node scripts/test-pencil-tool-routing.mjs',
  'node scripts/benchmark-transform-hotpath.mjs',
]);

if (typeof fullSyncCommand !== 'string' || !fullSyncCommand.trim()) {
  throw new Error('package.json is missing scripts.test:sync');
}

const steps = fullSyncCommand.split(' && ').map((step) => step.trim()).filter(Boolean);
for (const nativeCanvasStep of nativeCanvasSteps) {
  if (!steps.includes(nativeCanvasStep)) {
    throw new Error(`Expected native-canvas regression step was not found: ${nativeCanvasStep}`);
  }
}

const skippedSteps = steps.filter((step) => nativeCanvasSteps.has(step));
if (skippedSteps.length !== nativeCanvasSteps.size) {
  throw new Error(`CI-safe sync gate must skip exactly ${nativeCanvasSteps.size} native-canvas regression steps`);
}

const ciSteps = steps.filter((step) => !nativeCanvasSteps.has(step));
for (const nativeCanvasStep of skippedSteps) {
  console.log(`[CI] SKIP ${nativeCanvasStep}: requires a real pixel Canvas implementation; jsdom on the hosted Node runner does not provide HTMLCanvasElement.getContext().`);
}

const result = spawnSync(ciSteps.join(' && '), {
  cwd: new URL('..', import.meta.url),
  env: process.env,
  shell: true,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
