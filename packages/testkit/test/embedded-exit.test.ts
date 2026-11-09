/**
 * 内嵌依赖退出钩子的子进程回归：真实导入 embedded-postgres，但不创建实例、不启动 PostgreSQL。
 * 每个场景使用独立 Node 进程，避免进程级事件监听及退出状态污染 Vitest 宿主；不创建临时文件。
 * 同时核对自然成功/失败、显式失败及后来的非零退出，确保兼容层不把错误测试报告成成功。
 * 这是退出协议验证，不验证数据库启动、异步停机或文件清理；这些仍由现有 PostgreSQL 集成用例覆盖。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/** 测试包根目录用于解析真实 installed 依赖；URL 定位不依赖启动 Vitest 时的 cwd。 */
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
/** 子进程直接加载可擦除类型的源码，避免检查工作区中可能尚未重新构建的 dist。 */
const helperUrl = new URL('../src/embedded-exit.ts', import.meta.url).href;

/**
 * 执行一个受控退出片段，返回父进程观察到的退出状态和输出；子进程不操作数据库。
 * @param ending 设置退出码或注册退出事件的固定测试片段，不接受业务或用户输入。
 * @returns spawnSync 结果；非零状态是待断言的数据，超时或启动失败由调用方断言识别。
 */
function exitWith(ending: string) {
  const source = `
    await import('embedded-postgres');
    const { preserveEmbeddedPostgresExitCode } = await import(${JSON.stringify(helperUrl)});
    const before = process.listenerCount('beforeExit');
    preserveEmbeddedPostgresExitCode();
    const once = process.listenerCount('beforeExit');
    preserveEmbeddedPostgresExitCode();
    const twice = process.listenerCount('beforeExit');
    console.log(JSON.stringify({ first: once - before, repeated: twice - once }));
    ${ending}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
}

// 真实依赖的 beforeExit 在自然结束时固定传零；没有兼容层时，首个场景会返回 0 而不是 7。
test.each([
  { name: '自然退出保留已有失败码', ending: 'process.exitCode = 7;', expected: 7 },
  { name: '自然成功仍返回零', ending: '', expected: 0 },
  { name: '显式非零退出保持原值', ending: 'process.exit(9);', expected: 9 },
  {
    name: '后来的显式非零码不被旧失败码覆盖',
    ending: "process.exitCode = 7; process.once('beforeExit', () => process.nextTick(() => process.exit(9)));",
    expected: 9,
  },
])('$name', ({ ending, expected }) => {
  const child = exitWith(ending);
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe('');
  expect(child.status).toBe(expected);
  // 调用两次仅增加一个 beforeExit 监听，不因每个数据库实例重复安装兼容层。
  expect(JSON.parse(child.stdout.trim())).toEqual({ first: 1, repeated: 0 });
});
