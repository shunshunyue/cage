// unsafe 必须写明原因和负责人
import type { Rule } from 'eslint';

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
