// Vitest globalSetup：整个测试运行只启动一个 PostgreSQL，每个测试文件各建一个临时库。
//   // vitest.config.ts
//   export default { test: { globalSetup: ['@yss123/cage-testkit/global-setup'] } }
import { startEmbeddedPostgres, type PgInstance } from './pg.js';

let instance: PgInstance | null = null;

export default async function setup() {
  if (process.env.CAGE_TEST_DATABASE_URL) {
    process.env.CAGE_TEST_SUPER_URL = process.env.CAGE_TEST_DATABASE_URL;
    return async () => {};
  }
  instance = await startEmbeddedPostgres();
  process.env.CAGE_TEST_SUPER_URL = instance.superUrl;
  return async () => {
    await instance?.stop();
    instance = null;
  };
}
