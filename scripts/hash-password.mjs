import { stdin, stdout } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import { hashPassword } from '../server/auth/password-credentials.ts';

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Run this command in an interactive terminal. Password input is never accepted as an argument.');
  process.exitCode = 1;
} else {
  emitKeypressEvents(stdin);
  const readHidden = async label => {
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    try {
      for await (const chunk of stdin) {
        const text = String(chunk);
        if (text === '\r' || text === '\n') break;
        if (text === '\u0003') throw new Error('Cancelled');
        if (text === '\u007f' || text === '\b') { value = value.slice(0, -1); continue; }
        if (!text.startsWith('\u001b')) value += text;
      }
    } finally {
      stdin.setRawMode(false);
      stdout.write('\n');
    }
    return value;
  };
  const first = await readHidden('Password (14-128 characters): ');
  const second = await readHidden('Repeat password: ');
  if (first !== second) throw new Error('Passwords do not match');
  console.log(await hashPassword(first));
}
