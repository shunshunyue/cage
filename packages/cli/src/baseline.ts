/**
 * 为影响分析加载显式 JSON 基线或 Git 提交中的领域声明。
 * 文件基线直接读取；Git 基线在独立临时 worktree 中共享当前已安装依赖并由子进程抽取。
 * 不切换当前分支、不安装基线依赖；结束时解除本次 junction 并清理临时工作树，错误向调用方传播。
 */
// 基线来自显式 JSON 文件，或 Git 提交里的业务声明。
// Git 比较在独立临时工作树中抽取，不切换用户当前分支，也不安装/执行基线脚本。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abs, type CageConfig } from './config.js';
import { readOntology } from './impact.js';
import { run } from './process.js';
import { projectManifests } from './upgrade.js';

/**
 * 选择显式文件或真实 Git 提交作为修改前的比较依据，baseFile 优先。
 * Git 路径使用当前依赖解释旧声明，不能证明旧项目在原依赖版本下的行为。
 * @param cfg 当前应用位置。
 * @param opts base 为 Git ref，baseFile 为本体或命名快照路径；都省略则不启用基线。
 * @returns 读取或重新抽取的本体，未指定基线时为 undefined。
 * @throws ref 无效、抽取失败、读写或 worktree 清理失败时抛出。
 */
export async function loadBaseline(cfg: CageConfig, opts: { base?: string; baseFile?: string }) {
  if (opts.baseFile) return readOntology(abs(cfg, opts.baseFile));
  if (!opts.base) return undefined;
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: cfg.root, encoding: 'utf8', windowsHide: true }).trim();
  const repository = git(['rev-parse', '--show-toplevel']);
  // 先解析 ref，错误基线必须报错，不能把“基线不存在”解释为“没有变化”。
  const commit = git(['rev-parse', '--verify', `${opts.base}^{commit}`]);
  mkdirSync(abs(cfg, '.cage'), { recursive: true });
  const temporary = mkdtempSync(abs(cfg, '.cage/baseline-'));
  const checkout = join(temporary, 'checkout');
  git(['worktree', 'add', '--detach', checkout, commit]);
  const links: string[] = [];
  try {
    const project = join(checkout, relative(repository, cfg.root));
    // 使用当前已经安装的框架版本；基线与当前声明由同一抽取器解释。
    // pnpm 把依赖链接放在各 workspace 包内，单独链接根目录不足以解析 domain。
    for (const original of new Set([repository, cfg.root, ...projectManifests(repository).map(dirname)])) {
      const destination = join(checkout, relative(repository, original));
      if (existsSync(destination) && existsSync(join(original, 'node_modules')) && !existsSync(join(destination, 'node_modules'))) {
        symlinkSync(
          join(original, 'node_modules'),
          join(destination, 'node_modules'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        links.push(join(destination, 'node_modules'));
      }
    }
    const code = await run(
      fileURLToPath(new URL('../bin/cage.js', import.meta.url)),
      ['analyze', '--root', project],
      project,
    );
    if (code !== 0) throw new Error('[CAGE-IMPACT-001] 基线抽取失败，请修复基线声明或使用保存的 --base-file');
    return readOntology(join(project, '.cage/ontology.json'));
  } finally {
    // 先断开本次建立的 junction，避免清理工作树时遍历共享依赖目录。
    for (const link of links) unlinkSync(link);
    git(['worktree', 'remove', '--force', checkout]);
    // temporary 是本次 mkdtemp 创建的绝对目录，只移除自己的临时目录。
    rmSync(temporary, { recursive: true, force: true });
  }
}
