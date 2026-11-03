// 验证真实用户分支：选项能传入创建流程，取消不继续，也不留下项目。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CANCEL_SYMBOL, cancel, select, text } from '@clack/prompts';
import { chooseApp } from '../src/create-prompt.js';

vi.mock('@clack/prompts', () => ({
  CANCEL_SYMBOL: Symbol.for('cage-test-cancel'),
  isCancel: (value: unknown) => value === Symbol.for('cage-test-cancel'),
  intro: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
});
afterEach(() => {
  for (const [stream, descriptor] of [
    [process.stdin, inputTTY],
    [process.stdout, outputTTY],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  }
  vi.resetAllMocks();
});

it('可交互输入目录并选择采购示例', async () => {
  vi.mocked(text).mockResolvedValue('my-business');
  vi.mocked(select).mockResolvedValue('purchase');
  expect(await chooseApp()).toEqual({ target: 'my-business', template: 'purchase' });
});

it.each(['directory', 'template'])('在 %s 提示处取消会终止创建', async (step) => {
  if (step === 'directory') vi.mocked(text).mockResolvedValue(CANCEL_SYMBOL);
  else vi.mocked(select).mockResolvedValue(CANCEL_SYMBOL);
  expect(await chooseApp(step === 'template' ? 'my-business' : undefined)).toBeNull();
  expect(cancel).toHaveBeenCalledWith('已取消创建');
  if (step === 'directory') expect(select).not.toHaveBeenCalled();
});
