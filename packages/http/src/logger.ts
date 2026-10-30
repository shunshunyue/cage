// 日志自动打码：需要打码的字段从声明里的 sensitive 字段自动算出来，新增敏感字段时不会漏。
import type { Fields, Registry } from '@yss123/cage-kernel';

export function sensitiveFieldPaths(reg: Registry): string[] {
  const names = new Set<string>();
  for (const a of reg.aggregates) {
    for (const [k, f] of Object.entries(a.fields as Fields)) if (f.sensitiveKind || f.isHidden) names.add(k);
  }
  for (const e of reg.events) {
    for (const [k, f] of Object.entries(e.fields as Fields)) if (f.sensitiveKind) names.add(k);
  }
  return [...names].flatMap((n) => [`*.${n}`, `req.body.${n}`]);
}

export function buildLogger(reg: Registry): object {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]',
        'req.body.password', '*.password', ...sensitiveFieldPaths(reg),
      ],
      censor: '***',
    },
  };
}
