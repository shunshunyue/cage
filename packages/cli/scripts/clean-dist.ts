// tsc 不会删除已从源码移除的模块。此脚本只拥有包内 dist；构建前清理，
// 避免已删除的数据库管理实现继续进入 npm 分发包。
import { rmSync } from 'node:fs';
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
