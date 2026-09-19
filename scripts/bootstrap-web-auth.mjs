import { stdout, stderr } from 'node:process';
import { buildWebAuthAccountsJson, WEB_AUTH_BOOTSTRAP_IDENTITIES } from '../server/auth/bootstrap-accounts.ts';
import { readTerminalValue } from './secure-prompt.mjs';

async function readPassword(name) {
  const password = await readTerminalValue(`Password for ${name} (14-128 characters): `, { hidden:true });
  const confirmation = await readTerminalValue(`Repeat password for ${name}: `, { hidden:true });
  if (password !== confirmation) throw new Error(`Passwords do not match for ${name}`);
  return password;
}

async function main() {
  stderr.write('Creates WEB_AUTH_ACCOUNTS_JSON locally. Password input is hidden and never logged.\n');
  const input = {};
  for (const identity of WEB_AUTH_BOOTSTRAP_IDENTITIES) {
    stderr.write(`\n${identity.name} · ${identity.roles.join(' + ')} · ${identity.userId}\n`);
    const email = await readTerminalValue(`Email for ${identity.name}: `);
    const password = await readPassword(identity.name);
    input[identity.key] = { email, password };
  }
  const json = await buildWebAuthAccountsJson(input);
  stderr.write('\nCopy the following single line into the server-only WEB_AUTH_ACCOUNTS_JSON variable:\n');
  stdout.write(`${json}\n`);
}

main().catch(error => {
  stderr.write(`Unable to create web-auth accounts: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
