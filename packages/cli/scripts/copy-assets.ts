/**
 * 将仓库已同步的完整模板复制到 CLI 分发包，作为 build 的资源阶段。
 * 先清理包内旧 templates 与旧 managed/errors，再复制仓库两套模板，排除缓存、依赖和真实 .env。
 * 不会运行模板或同步业务逻辑；覆盖的是脚本拥有的分发目录，失败会保留部分复制结果，需要修复后重跑。
 */
// npm 包包含完整业务模板（含 AGENTS、AI 指南与错误码册）。
// 只复制已同步的模板，避免安装后的 CLI 再拼装几套可能不同版本的文档。
import { cpSync, rmSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = new URL('../', import.meta.url);
// 目标是由本脚本完全拥有的包内资源目录。先清理，避免删除的模板文件残留进 npm 包。
rmSync(new URL('templates/', here), { recursive: true, force: true });
// 清除旧版独立文档资源；新版本从完整模板一次复制，避免重复分发。
rmSync(new URL('managed/errors/', here), { recursive: true, force: true });
// 两种模板都随 npm 包交付，安装后的脚手架无需下载仓库或临时删改业务。
const source = fileURLToPath(new URL('../../templates/', here));
cpSync(source, new URL('templates/', here), {
  recursive: true,
  filter: (path) =>
    !/(^|[\\/])(node_modules|dist|\.cage|generated|\.turbo)([\\/]|$)/.test(relative(source, path)) &&
    (!/^\.env(?:\..+)?$/.test(basename(path)) || basename(path) === '.env.example'),
});
