/**
 * 检查业务源码中的动态 SQL 文本拼接以及非字面量 sql.raw 调用。
 * 推荐参数化标签模板或查询构建器；检测通过 AST 形状与 SQL 关键词完成，不连接数据库。
 * 任意标签模板会被跳过，这是当前检查器的语法边界，不能据此证明所有被跳过标签都安全。
 */
// 禁止字符串拼接 SQL：只能用 Kysely 的 sql 标签模板（自动参数化）或查询构建器
import type { Rule } from 'eslint';

const SQL_RE = /\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set|where)\b/i;

/**
 * 递归判断字面量、模板静态片段或二元表达式中是否具有 SQL 语句外形。
 * 未知节点返回 false；该函数不追踪变量来源，也不把识别结果当成完整 SQL 解析。
 */
function isSqlish(node: any): boolean {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') return SQL_RE.test(node.value);
  if (node.type === 'TemplateLiteral') return node.quasis.some((q: any) => SQL_RE.test(q.value.raw));
  if (node.type === 'BinaryExpression') return isSqlish(node.left) || isSqlish(node.right);
  return false;
}

/**
 * 为插值模板、最外层加法表达式和 sql.raw 调用分别报告诊断。
 * 跳过嵌套加法节点避免重复报同一拼接；raw 仅允许普通字面量或无插值模板。
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止字符串拼接 SQL' },
    messages: {
      concat: '[CAGE-SQL-001] 不要拼接 SQL 字符串，改用 sql 标签模板或查询构建器（值会自动参数化）',
      raw: '[CAGE-SQL-002] sql.raw() 只能接收字面量',
    },
    schema: [],
  },
  create(context) {
    return {
      TemplateLiteral(node: any) {
        if (node.parent?.type === 'TaggedTemplateExpression') return; // sql`...` 是安全的
        if (node.expressions.length > 0 && isSqlish(node)) context.report({ node, messageId: 'concat' });
      },
      BinaryExpression(node: any) {
        if (node.operator !== '+' || node.parent?.type === 'BinaryExpression') return;
        if (isSqlish(node) && (node.left.type !== 'Literal' || node.right.type !== 'Literal')) context.report({ node, messageId: 'concat' });
      },
      CallExpression(node: any) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && c.object?.name === 'sql' && c.property?.name === 'raw') {
          const a = node.arguments[0];
          const literal = a && (a.type === 'Literal' || (a.type === 'TemplateLiteral' && a.expressions.length === 0));
          if (!literal) context.report({ node, messageId: 'raw' });
        }
      },
    };
  },
};
export default rule;
