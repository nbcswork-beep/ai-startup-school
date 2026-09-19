import { stdin, stderr } from 'node:process';
import { emitKeypressEvents } from 'node:readline';

const preparedInputs = new WeakSet();

function prepareInput(input) {
  if (preparedInputs.has(input)) return;
  emitKeypressEvents(input);
  preparedInputs.add(input);
}

export function readTerminalValue(label, { hidden = false, input = stdin, output = stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal. Secrets are never accepted as arguments.'));
  }

  prepareInput(input);
  output.write(label);

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = Boolean(input.isRaw);

    const finish = (error) => {
      input.removeListener('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') {
        if (!value) return;
        value = value.slice(0, -1);
        if (!hidden) output.write('\b \b');
        return;
      }
      if (key.ctrl || key.meta || key.name === 'escape' || key.name === 'tab' || key.name?.startsWith('arrow')) return;
      if (!text) return;
      value += text;
      if (!hidden) output.write(text);
    };

    input.on('keypress', onKeypress);
    input.setRawMode(true);
    input.resume();
  });
}
