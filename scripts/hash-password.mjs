import { stdout, stderr } from 'node:process';
import { hashPassword } from '../server/auth/password-credentials.ts';
import { readTerminalValue } from './secure-prompt.mjs';

try {
  const first = await readTerminalValue('Password (14-128 characters): ', { hidden:true });
  const second = await readTerminalValue('Repeat password: ', { hidden:true });
  if (first !== second) throw new Error('Passwords do not match');
  stdout.write(`${await hashPassword(first)}\n`);
} catch (error) {
  stderr.write(`Unable to hash password: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
}
