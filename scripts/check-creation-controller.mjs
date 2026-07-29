import { createCreationInputController } from '../src/lib/creationInputController.js';

let selectedToolId = 'pencil';
const events = [];
const tools = new Map([
  ['pencil', {
    begin() { events.push('pencil:begin'); },
    move() { events.push('pencil:move'); },
    end() { events.push('pencil:end'); },
    cancel() { events.push('pencil:cancel'); },
  }],
  ['line', {
    begin() { events.push('line:begin'); },
    move() { events.push('line:move'); },
    end() { events.push('line:end'); },
    cancel() { events.push('line:cancel'); },
  }],
]);

function pointer(type, pointerId) {
  return {
    type,
    pointerId,
    pointerType: 'pen',
    clientX: 10,
    clientY: 20,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    currentTarget: {
      setPointerCapture() {},
      releasePointerCapture() {},
    },
  };
}

const controller = createCreationInputController({
  getSelectedToolId: () => selectedToolId,
  getTool: (toolId) => tools.get(toolId),
  createContext: () => ({}),
  normalizeEvent: (event) => ({ nativeEvent: event }),
  canStart: () => true,
});

controller.start(pointer('pointerdown', 1));
selectedToolId = 'line';
controller.move(pointer('pointermove', 1));
controller.end(pointer('pointerup', 1));
controller.start(pointer('pointerdown', 2));
controller.end(pointer('pointerup', 2));

const expected = [
  'pencil:begin',
  'pencil:move',
  'pencil:end',
  'line:begin',
  'line:end',
];

if (events.join('|') !== expected.join('|')) {
  console.error('Unexpected creation lifecycle:', events);
  process.exit(1);
}

console.log('Unified creation input check passed.');
