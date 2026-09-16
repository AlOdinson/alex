import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the real menu synchronizer without starting its document-wide observer.
const source = readFileSync(new URL('../src/board-settings-gear.js', import.meta.url), 'utf8');
const context = {};
vm.runInNewContext(source.slice(0, source.indexOf('const observer ='))
  + '\nglobalThis.syncMenu = syncSettingsMenu;', context);
function element(text = '', classes = []) {
  const list = new Set(classes);
  let content = text, disabled = false, node = { text };
  const el = { writes: 0, hidden: false, dataset: {},
    get textContent() { return content; },
    set textContent(value) { content = value; node = { text: value }; el.writes++; },
    get firstChild() { return node; },
    get disabled() { return disabled; },
    set disabled(value) { disabled = value; el.writes++; },
    setAttribute() {},
    classList: {
      contains(value) { return list.has(value); },
      toggle(value, enabled) { if (enabled) list.add(value); else list.delete(value); },
    },
  };
  return el;
}
function fixture() {
  const nodes = new Map(), labels = [];
  for (const action of ['share', 'export', 'background', 'screenShare']) {
    const item = element(), label = element(); labels.push(label);
    item.querySelector = () => label; nodes.set(`[data-action="${action}"]`, item);
  }
  for (const selector of ['.alex-settings-gear', '[data-current-background]', '[data-current-language]']) nodes.set(selector, element());
  const backgrounds = ['grid','dots','blank'].map((key) => { const el = element(); el.dataset.background = key; return el; });
  const root = { querySelector: (selector) => nodes.get(selector), querySelectorAll: () => backgrounds };
  const controls = { share: element(), export: element(), background: { value: 'grid' },
    language: [element('RU', ['active']), element('EN')], screenShare: element('ShareScreen') };
  return { root, controls, labels, nodes, backgrounds };
}
test('unchanged menu sync preserves the label node under the pressed pointer', () => {
  const f = fixture(); context.syncMenu(f.root, f.controls);
  const before = f.labels.map((label) => label.firstChild);
  for (let i=0; i<5; i++) context.syncMenu(f.root, f.controls);
  f.labels.forEach((label, i) => assert.equal(label.firstChild, before[i], 'unchanged labels must not replace text nodes during a click'));
});
test('unchanged menu sync does not feed childList or disabled mutations back to its own observer', () => {
  const f = fixture(); context.syncMenu(f.root, f.controls);
  const tracked = [...f.labels, ...f.nodes.values(), ...f.backgrounds];
  const before = tracked.map((el) => el.writes);
  context.syncMenu(f.root, f.controls);
  assert.deepEqual(tracked.map((el) => el.writes), before);
});
test('changed share state, permissions, language and background still update the menu', () => {
  const f = fixture(); context.syncMenu(f.root, f.controls);
  f.controls.screenShare.textContent = 'Stop Share'; f.controls.screenShare.disabled = true;
  f.controls.language[0].classList.toggle('active',false); f.controls.language[1].classList.toggle('active',true);
  f.controls.background.value = 'dots'; context.syncMenu(f.root, f.controls);
  assert.equal(f.labels.at(-1).textContent, 'Stop Share');
  assert.equal(f.nodes.get('[data-action="screenShare"]').disabled, true);
  assert.equal(f.nodes.get('[data-current-language]').textContent, 'EN');
  assert.equal(f.nodes.get('[data-current-background]').textContent, 'Dots');
});
