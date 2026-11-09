/**
 * 浏览器关系解释的转导出入口，与 CLI 使用同一份 src/graph-relations 规则。
 * 这里只暴露可浏览器执行的纯解释逻辑，不加载数据库、审批引擎或 Node 文件访问模块。
 */
// Web 与 AI 上下文共用关系解释，保持证据和业务含义一致。
export { explainEdge, type RelationExplanation } from '../src/graph-relations.js';
