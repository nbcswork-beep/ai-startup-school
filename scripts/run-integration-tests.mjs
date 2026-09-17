import { spawnSync } from 'node:child_process';

if (!process.env.TEST_DATABASE_URL) {
  console.error('Integration tests require TEST_DATABASE_URL with the migration and seed applied.');
  process.exit(2);
}
const result=spawnSync(process.platform==='win32'?'npx.cmd':'npx',['vitest','run','--config','vitest.integration.config.ts'],{stdio:'inherit',env:process.env});
process.exit(result.status ?? 1);
