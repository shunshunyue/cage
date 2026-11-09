/**
 * 供需要运行环境的 CLI 子命令加载应用 .env，统一使用 Node 的 dotenv 解析规则。
 * 只补充目标环境对象中尚未定义的键，已有部署变量及空字符串均保持原值。
 * 读取内容不做 shell 展开、不打印秘密；缺少文件是无操作，解析或文件读取异常交给命令入口处理。
 */
// CLI 从项目根目录读取本地连接配置。显式传入的环境变量优先，CI/部署可以覆盖本地值。
// 使用 Node 自带的 dotenv 解析器，不展开 shell 表达式，也不打印文件中的凭证。
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

/**
 * 将本地配置补入指定环境对象，已有同名值优先。
 * @param root 应用根目录，只读取其 .env。
 * @param env 要原地补充的环境对象，默认 process.env。
 * 文件缺失时无副作用；不会输出值，读取或解析失败向上抛出。
 */
export function loadProjectEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[name] === undefined) env[name] = value;
  }
}
