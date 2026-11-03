import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { CageConfig } from './config.js';
import type { GraphSnapshot } from './graph-snapshot.js';
import { buildContext, formatContext } from './context.js';

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

/** 本地开发工具只监听回环地址；源码预览只提供抽取快照内的注册声明，
 * 固定路由不接受文件路径。它不挂载到业务 API 或生产 /admin。 */
export async function serveGraph(cfg: CageConfig, port = 15418) {
  let snapshot = await collectGraph(cfg.root);
  let refreshing: Promise<GraphSnapshot> | undefined;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/model.js', ['model.js', 'text/javascript; charset=utf-8']],
    ['/relations.js', ['relations.js', 'text/javascript; charset=utf-8']],
    ['/structure.js', ['structure.js', 'text/javascript; charset=utf-8']],
    ['/approval-flow.js', ['approval-flow.js', 'text/javascript; charset=utf-8']],
    ['/graph-approvals.js', ['graph-approvals.js', 'text/javascript; charset=utf-8']],
    ['/graph-model.js', ['graph-model.js', 'text/javascript; charset=utf-8']],
    ['/graph-relations.js', ['graph-relations.js', 'text/javascript; charset=utf-8']],
    ['/graph-search.js', ['graph-search.js', 'text/javascript; charset=utf-8']],
    ['/graph-business.js', ['graph-business.js', 'text/javascript; charset=utf-8']],
    ['/business.js', ['business.js', 'text/javascript; charset=utf-8']],
    ['/flowchart.js', ['flowchart.js', 'text/javascript; charset=utf-8']],
    ['/flowchart-interaction.js', ['flowchart-interaction.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/business.css', ['business.css', 'text/css; charset=utf-8']],
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
    const requestUrl = new URL(req.url!, origin);
    const path = requestUrl.pathname;
    try {
      // 默认响应仍是声明元数据；实现代码由用户打开具体节点后单独请求。
      const displayedSnapshot = () => {
        const { sources, ...displayed } = snapshot;
        return displayed;
      };
      if (req.method === 'GET' && path === '/api/graph') return json(200, displayedSnapshot());
      if (req.method === 'GET' && path === '/api/source') {
        const key = requestUrl.searchParams.get('node');
        if (!key) return json(400, { error: '需要完整节点 key' });
        const node = snapshot.graph.nodes.find((n) => `${n.kind}:${n.id}` === key);
        if (!node) return json(404, { error: '当前图谱中没有这个节点' });
        const owner = ['field', 'state', 'capability'].includes(node.kind)
          ? snapshot.graph.nodes
              .filter((n) => n.kind === 'aggregate' && node.id.startsWith(`${n.id}.`))
              .sort((a, b) => b.id.length - a.id.length)[0]
          : undefined;
        const sourceKey = node.file ? key : owner ? `${owner.kind}:${owner.id}` : key;
        const source = snapshot.sources?.[sourceKey];
        if (!source)
          return json(404, {
            error: '该声明来自依赖包，或当前快照没有项目源码；可在完整本体中查看声明属性。',
          });
        return json(200, {
          ...source,
          nodeKey: key,
          sourceKey,
          precision: sourceKey === key ? 'declaration' : 'aggregate',
          extractedAt: snapshot.generatedAt,
          freshness: 'displayed-snapshot',
        });
      }
      if (req.method === 'GET' && path === '/api/context') {
        const node = requestUrl.searchParams.get('node');
        const format = requestUrl.searchParams.get('format') ?? 'json';
        if (!node?.trim() || !['json', 'md'].includes(format))
          return json(400, { error: '需要 node 参数；format 只能是 json 或 md' });
        // 使用页面已有快照，时间与来源随报告交付；要看代码最新状态应先重新抽取。
        const context = buildContext(cfg, snapshot, node, { freshness: 'displayed-snapshot' });
        if (format === 'json') return json(200, context);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(formatContext(context));
        return;
      }
      if (req.method === 'POST' && path === '/api/refresh') {
        if (req.headers.origin !== origin) return json(403, { error: '刷新必须由本地图谱页面发起' });
        // 同时点击刷新共享一次抽取；失败向页面报告，不伪装成新图。
        refreshing ??= collectGraph(cfg.root).finally(() => {
          refreshing = undefined;
        });
        snapshot = await refreshing;
        return json(200, displayedSnapshot());
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
