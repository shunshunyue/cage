// 禁止字符串拼接 SQL：只能用 Kysely 的 sql 标签模板（自动参数化）或查询构建器
import type { Rule } from 'eslint';

const SQL_RE = /\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set|where)\b/i;

function isSqlish(node: any): boolean {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') return SQL_RE.test(node.value);
  if (node.type === 'TemplateLiteral') return node.quasis.some((q: any) => SQL_RE.test(q.value.raw));
  if (node.type === 'BinaryExpression') return isSqlish(node.left) || isSqlish(node.right);
  return false;
}

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
