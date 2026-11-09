/**
 * 检查业务代码是否绕过声明直接注册 HTTP 路由。
 * 通过常见接收器名、HTTP 方法和路径形状识别调用，命中返回 CAGE-ROUTE-001。
 * 这是有界语法检查，不解析任意变量别名或运行时动态路由；框架自己的 HTTP 实现由其维护边界管理。
 */
// 业务项目里禁止手写 HTTP 路由：没有声明就没有路由，所有写入都经过内核
import type { Rule } from 'eslint';

/**
 * 常见路由注册方法集合；只有同时匹配接收器和路径形状才报告，避免把普通对象 get 操作当路由。
 */
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'route', 'all', 'head', 'options']);
const RECEIVERS = /^(app|server|fastify|router|api|instance)$/i;

/**
 * ESLint 规则定义，每个文件由 create 建立 CallExpression 访问器。
 * 支持字符串路径、模板路径及含 url 属性的路由对象；不执行任何被检查的代码。
 */
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
