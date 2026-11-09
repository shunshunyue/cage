/**
 * 扫描字符串字面量中的常见凭据格式与疑似密钥赋值。
 * 已知供应商格式先匹配，再依据变量/属性名、长度及字符形状作启发式判断。
 * 环境变量名称允许作为引用；检查并不覆盖任意编码、拼接或运行时构造的秘密，不应把未报错当作绝对无泄漏。
 */
// 仓库中出现密钥字面量即构建失败：密钥只写名字，值从密钥管理服务（或环境变量）读取
import type { Rule } from 'eslint';

/**
 * 已知凭据外形及面向开发者的分类名称；这里只存模式，不包含真实密钥样本。
 */
const PATTERNS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/, 'AWS 访问密钥'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, '私钥'],
  [/\b(sk|rk|pk)_(live|test)_[0-9a-zA-Z]{16,}/, '支付平台密钥'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'API 密钥'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub 令牌'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack 令牌'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
];
/**
 * 对变量或属性名的末尾做密钥语义匹配，供第二阶段启发式判断使用。
 */
const NAME_RE = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i;

/**
 * 检查 Literal 的字符串值，并从父节点提取变量名、属性名或赋值目标名。
 * 同一值命中已知格式后立即报告并结束该值检查，避免重复提示。
 */
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
