import { stdin, stderr } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { spawnSync } from 'node:child_process';

const preparedInputs = new WeakSet();

function prepareInput(input) {
  if (preparedInputs.has(input)) return;
  emitKeypressEvents(input);
  preparedInputs.add(input);
}

export function readWindowsClipboard() {
  if (process.platform !== 'win32') throw new Error('Direct clipboard reading is only available on Windows');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write((Get-Clipboard -Raw))'], {
    encoding:'utf8',
    windowsHide:true,
    maxBuffer:65_536,
    stdio:['ignore', 'pipe', 'ignore']
  });
  if (result.error || result.status !== 0) throw new Error('Unable to read the Windows clipboard');
  const value = String(result.stdout ?? '').replace(/(?:\r\n|\r|\n)+$/u, '');
  if (!value) throw new Error('The Windows clipboard is empty');
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('The clipboard must contain one printable line');
  return value;
}

export function readTerminalValue(label, { hidden = false, input = stdin, output = stderr, clipboardReader = readWindowsClipboard } = {}) {
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
      if (key.ctrl && key.name === 'v') {
        try {
          const pasted = clipboardReader();
          value += pasted;
          if (!hidden) output.write(pasted);
        } catch (error) {
          return finish(error instanceof Error ? error : new Error('Unable to paste from the clipboard'));
        }
        return;
      }
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
