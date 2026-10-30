import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { CageConfig } from './config.js';
import type { GraphSnapshot } from './graph-snapshot.js';

/** 只采集声明元数据，不连接业务数据库。子进程的 IPC 把日志和 JSON 分开，
 * domain 的普通日志不会污染响应，也不会把进程环境变量发送给浏览器。 */
export function collectGraph(root: string): Promise<GraphSnapshot> {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./graph-snapshot.js', import.meta.url)), [root], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let failure = '';
    child.stderr!.on('data', (chunk) => {
      failure += String(chunk);
    });
    child.once('message', (message: { snapshot?: GraphSnapshot; error?: string }) => {
      if (message.snapshot) resolve(message.snapshot);
      else reject(new Error(message.error));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(failure || `本体抽取进程退出（${code}）`)));
  });
}

/** 本地开发工具只监听回环地址；固定路由表不接受文件路径，不能拿来读取
 * 项目的 .env、源码或任意本机文件。它不挂载到业务 API 或生产 /admin。 */
export async function serveGraph(cfg: CageConfig, port = 15418) {
  let snapshot = await collectGraph(cfg.root);
  let refreshing: Promise<GraphSnapshot> | undefined;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/model.js', ['model.js', 'text/javascript; charset=utf-8']],
    ['/relations.js', ['relations.js', 'text/javascript; charset=utf-8']],
    ['/structure.js', ['structure.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ]);
  let origin = '';
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    // 限制 Host 和刷新来源，避免其他网站借用户浏览器触发本地模块求值。
    if (req.headers.host !== new URL(origin).host)
      return json(403, { error: '请使用终端输出的本地地址访问' });
    const path = new URL(req.url!, origin).pathname;
    try {
      if (req.method === 'GET' && path === '/api/graph') return json(200, snapshot);
      if (req.method === 'POST' && path === '/api/refresh') {
        if (req.headers.origin !== origin) return json(403, { error: '刷新必须由本地图谱页面发起' });
        // 同时点击刷新共享一次抽取；失败向页面报告，不伪装成新图。
        refreshing ??= collectGraph(cfg.root).finally(() => {
          refreshing = undefined;
        });
        snapshot = await refreshing;
        return json(200, snapshot);
      }
      const asset = req.method === 'GET' ? assets.get(path) : undefined;
      if (!asset) return json(404, { error: '页面不存在' });
      const content = await readFile(new URL(`../graph-ui/${asset[0]}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(content);
    } catch (error) {
      json(500, { error: (error as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  return { server, url: origin };
}
