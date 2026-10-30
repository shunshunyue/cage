// 业务项目里禁止手写 HTTP 路由：没有声明就没有路由，所有写入都经过内核
import type { Rule } from 'eslint';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'route', 'all', 'head', 'options']);
const RECEIVERS = /^(app|server|fastify|router|api|instance)$/i;

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止在业务项目里手写 HTTP 路由' },
    messages: { route: '[CAGE-ROUTE-001] 不要手写路由 {{call}}：在 domain 里声明命令或查询，路由由框架生成' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: any) {
        const c = node.callee;
        if (c.type !== 'MemberExpression' || c.property?.type !== 'Identifier' || !METHODS.has(c.property.name)) return;
        const recv = c.object?.type === 'Identifier' ? c.object.name : c.object?.type === 'MemberExpression' ? c.object.property?.name : '';
        const first = node.arguments[0];
        const isPath =
          (first?.type === 'Literal' && typeof first.value === 'string' && first.value.startsWith('/')) ||
          (first?.type === 'TemplateLiteral' && String(first.quasis[0]?.value?.raw ?? '').startsWith('/')) ||
          (first?.type === 'ObjectExpression' && first.properties.some((p: any) => (p.key?.name ?? p.key?.value) === 'url'));
        if (RECEIVERS.test(recv ?? '') && isPath) context.report({ node, messageId: 'route', data: { call: `${recv}.${c.property.name}()` } });
      },
    };
  },
};
export default rule;
