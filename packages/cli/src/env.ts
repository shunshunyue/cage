// CLI 从项目根目录读取本地连接配置。显式传入的环境变量优先，CI/部署可以覆盖本地值。
// 使用 Node 自带的 dotenv 解析器，不展开 shell 表达式，也不打印文件中的凭证。
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

export function loadProjectEnv(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[name] === undefined) env[name] = value;
  }
}
