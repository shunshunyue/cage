/**
 * 创建应用前的终端交互层，向 main 返回已经明确的目录与模板选择。
 * 显式参数优先，缺项时使用 Clack 提示；非 TTY 必须提供完整参数，取消返回 null。
 * 本模块不复制模板或安装依赖，因此交互取消不会留下创建到一半的应用。
 */
// 交互只收集创建选项，所有问题结束后才复制文件；Ctrl+C 不会留下半个项目。
import { cancel, intro, isCancel, select, text } from '@clack/prompts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { appTemplates, isAppTemplate, type AppTemplate } from './create.js';

/**
 * 补齐创建目录与模板选项，供 main 在任何文件复制前调用。
 * @param target 显式目录；缺省时交互询问。
 * @param template blank 或 purchase；缺省时交互选择而非在 CI 静默默认。
 * @returns 完整创建选择；用户取消返回 null，由入口转换为取消退出码。
 * @throws 非交互缺项或模板名无效时抛出 CAGE-CREATE-001。
 */
export async function chooseApp(
  target?: string,
  template?: string,
): Promise<{ target: string; template: AppTemplate } | null> {
  if (template !== undefined && !isAppTemplate(template))
    throw new Error('[CAGE-CREATE-001] --template 只能是 blank 或 purchase');

  // 管道和 CI 没有可操作的终端，不隐式选择业务模板，也不让安装任务挂在提示上。
  if ((!target || !template) && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error(
      '[CAGE-CREATE-001] 非交互终端请指定目录和模板，例如：create-cage-app my-app --template blank',
    );

  if (!target || !template) intro('创建 Cage 业务应用');
  if (!target) {
    const answer = await text({
      message: '项目目录',
      placeholder: 'my-cage-app',
      defaultValue: 'my-cage-app',
      validate: (value) => {
        if (!value?.trim()) return '请输入项目目录';
        if (existsSync(resolve(value.trim()))) return '目标路径已存在，请选择新目录';
      },
    });
    if (isCancel(answer)) {
      cancel('已取消创建');
      return null;
    }
    target = answer.trim();
  }
  if (!template) {
    const answer = await select<AppTemplate>({
      message: '选择项目模板（↑↓ 选择，Enter 确认）',
      initialValue: 'blank',
      options: Object.entries(appTemplates).map(([value, option]) => ({
        value: value as AppTemplate,
        label: option.label,
        hint: option.hint,
      })),
    });
    if (isCancel(answer)) {
      cancel('已取消创建');
      return null;
    }
    template = answer;
  }
  return { target, template: template as AppTemplate };
}
