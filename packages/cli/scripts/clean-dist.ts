/**
 * CLI 构建前清理本包拥有的 dist，防止已删除源码仍残留在发布产物中。
 * 目标通过脚本相对位置固定解析，只删除该生成目录；可重复执行，缺目录不报错。
 * 不触及 src、模板或用户应用，后续编译负责重建，删除失败直接中止构建。
 */
// tsc 不会删除已从源码移除的模块。此脚本只拥有包内 dist；构建前清理，
// 避免已删除的数据库管理实现继续进入 npm 分发包。
import { rmSync } from 'node:fs';
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
