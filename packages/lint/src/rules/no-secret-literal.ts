// 仓库中出现密钥字面量即构建失败：密钥只写名字，值从密钥管理服务（或环境变量）读取
import type { Rule } from 'eslint';

const PATTERNS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'AWS 访问密钥'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私钥'],
  [/\b(sk|rk|pk)_(live|test)_[0-9a-zA-Z]{16,}/, '支付平台密钥'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API 密钥'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub 令牌'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack 令牌'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];
const NAME_RE = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i;

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: '禁止密钥字面量' },
    messages: { secret: '[CAGE-SECRET-002] 疑似{{what}}写在了代码里：密钥只写名字，值由密钥管理服务注入' },
    schema: [],
  },
  create(context) {
    const check = (node: any, value: string, name?: string) => {
      for (const [re, what] of PATTERNS) {
        if (re.test(value)) {
          context.report({ node, messageId: 'secret', data: { what } });
          return;
        }
      }
      // 名字像密钥、值又不像「密钥名」（全大写下划线）的长字符串
      if (name && NAME_RE.test(name) && value.length >= 12 && !/^[A-Z][A-Z0-9_]+$/.test(value) && !/\s/.test(value)) {
        context.report({ node, messageId: 'secret', data: { what: '密钥' } });
      }
    };
    return {
      Literal(node: any) {
        if (typeof node.value !== 'string') return;
        const p = node.parent;
        const name =
          p?.type === 'VariableDeclarator' ? p.id?.name
            : p?.type === 'Property' ? (p.key?.name ?? p.key?.value)
              : p?.type === 'AssignmentExpression' ? p.left?.property?.name
                : undefined;
        check(node, node.value, name);
      },
    };
  },
};
export default rule;
