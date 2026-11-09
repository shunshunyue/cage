/**
 * 检查显式 unsafe 调用是否给出 reason 与 owner，以便越界方案可被追踪和评审。
 * 只识别名为 unsafe 的直接调用及其对象字面量参数；不会推断任意别名，也不会判断文字理由是否充分。
 * 存在且不是空白字面量即通过本语法检查，最终越界必要性仍需源码审查。
 */
// unsafe 必须写明原因和负责人
import type { Rule } from 'eslint';

/**
 * 静态检查首个对象参数的两个说明字段；缺失时返回 CAGE-UNSAFE-001。
 * 规则不放宽业务依赖边界，也不执行 unsafe 所描述的操作。
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'unsafe(...) 必须写明 reason 和 owner' },
    messages: { missing: '[CAGE-UNSAFE-001] unsafe 必须写明 reason 和 owner（详见 docs/errors/CAGE-UNSAFE-001.md）' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: any) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'unsafe') return;
        const arg = node.arguments[0];
        const props: any[] = arg?.type === 'ObjectExpression' ? arg.properties : [];
        const val = (k: string) => props.find((p) => (p.key?.name ?? p.key?.value) === k)?.value;
        const filled = (k: string) => {
          const v = val(k);
          return !!v && !(v.type === 'Literal' && String(v.value).trim() === '');
        };
        if (!filled('reason') || !filled('owner')) context.report({ node, messageId: 'missing' });
      },
    };
  },
};
export default rule;
