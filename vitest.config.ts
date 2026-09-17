import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.unit.test.ts'],
    coverage: { enabled: false }
  }
});
