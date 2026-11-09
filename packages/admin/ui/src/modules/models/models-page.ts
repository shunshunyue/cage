/**
 * 管理当前租户已声明的托管模型连接，页面通过 AI 协议类型消费服务端数据。
 * 每个模型有独立保存版本与连接测试；密钥不回显，输入留空表示保留原密钥，成功后清空输入框。
 */
import type { AiModelConfig, AiModelProbe } from '@yss123/cage-ai-protocol';
import { api, run } from '../../shared/api.js';
import { badge, emptyState, field, formatTime, h, panel } from '../../shared/dom.js';

/** Admin 只管理框架模型配置；审批规则、业务工具与聊天界面仍由各自声明和应用负责。 */
/**
 * 读取托管模型列表并在 main 中构建配置表单，无模型时显示启用提示。
 * 表单以秒显示超时，提交转换为毫秒；保存携带已读取的 version 防止覆盖其他编辑。
 * 测试仅使用已保存配置，连接成功不证明全部协议特性或业务工具验收通过；错误由共享操作层反馈。
 */
export async function renderModels(main: HTMLElement) {
  const models = await api<AiModelConfig[]>('GET', '/api/ai/admin/models');
  if (!models.length) {
    main.append(panel('尚无可管理的模型', undefined, emptyState('应用尚未启用托管模型', '应用声明模型后，可在这里配置服务地址与密钥。', 'grid')));
    return;
  }
  main.append(h('div', { class: 'model-overview' }, h('div', {}, h('span', { class: 'eyebrow' }, 'MODEL CONNECTIONS'),
    h('h2', {}, '一个连接，支撑每次智能协作'), h('p', {}, '模型按当前租户配置。API Key 加密保存，不会回显到页面。')),
    badge(`${models.length} 个模型入口`, 'green')));
  for (let saved of models) {
    const label = h('input', { value: saved.label, required: true, maxlength: 100 });
    const baseUrl = h('input', { type: 'url', value: saved.baseUrl, placeholder: 'https://api.example.com/v1', required: true, maxlength: 1000 });
    const model = h('input', { value: saved.model, placeholder: '填写服务商提供的模型名称', required: true, maxlength: 200 });
    const apiKey = h('input', { type: 'password', autocomplete: 'new-password', placeholder: saved.hasApiKey ? '已保存；留空保留原密钥' : '粘贴 API Key', maxlength: 4096 });
    const enabled = h('input', { type: 'checkbox', checked: saved.enabled });
    const timeout = h('input', { type: 'number', min: 1, max: 180, value: saved.timeoutMs / 1000, required: true });
    const compaction = h('input', { type: 'checkbox', checked: saved.responsesCompaction, disabled: saved.apiFormat !== 'responses' });
    const apiFormat = h('select', { value: saved.apiFormat, onchange: () => {
      compaction.disabled = apiFormat.value !== 'responses'; if (compaction.disabled) compaction.checked = false;
    } }, h('option', { value: 'chat-completions' }, 'Chat Completions'), h('option', { value: 'responses' }, 'Responses'));
    const contextWindow = h('input', { type: 'number', min: 8192, max: 2000000, step: 1, value: saved.contextWindowTokens, required: true });
    const status = h('div', { class: 'model-save-status', role: 'status' });
    const summary = h('div', { class: 'model-meta' });
    const refresh = () => summary.replaceChildren(badge(saved.enabled ? '已启用' : '未启用', saved.enabled ? 'green' : 'neutral'),
      h('span', {}, saved.hasApiKey ? '密钥已保存' : '等待配置'), h('span', {}, saved.apiFormat === 'responses' ? 'Responses · 服务端接续' : 'Chat Completions'), h('span', {}, `更新于 ${formatTime(saved.updatedAt)}`));
    refresh();
    const save = h('button', { class: 'primary', type: 'submit' }, '保存配置');
    const test = h('button', { type: 'button', disabled: !saved.enabled, onclick: async () => {
      status.textContent = '正在测试已保存的配置…';
      const result = await run(() => api<AiModelProbe>('POST', `/api/ai/admin/models/${encodeURIComponent(saved.key)}/test`), undefined, test);
      status.textContent = result ? result.ok ? `连接成功 · ${result.latencyMs} ms · 配置版本 ${result.version}`
        : `连接未成功（${result.code}），请核对地址、模型名称与密钥。` : '测试未完成，请根据错误提示检查配置。';
    } }, '测试连接');
    const form = h('form', { class: 'model-form', onsubmit: async event => {
      event.preventDefault(); test.disabled = true;
      const result = await run(() => api<AiModelConfig>('POST', `/api/ai/admin/models/${encodeURIComponent(saved.key)}`, {
        version: saved.version, label: label.value, baseUrl: baseUrl.value, model: model.value, apiKey: apiKey.value || undefined,
        enabled: enabled.checked, timeoutMs: Number(timeout.value) * 1000,
        apiFormat: apiFormat.value, contextWindowTokens: Number(contextWindow.value), responsesCompaction: compaction.checked,
      }).catch(error => { status.textContent = (error as Error).message; throw error; }), '模型配置已保存', save);
      if (result) { saved = result; apiKey.value = ''; apiKey.placeholder = '已保存；留空保留原密钥'; refresh(); status.textContent = '已保存，后续模型调用将使用这份配置。'; }
      test.disabled = !saved.enabled;
    } }, h('div', { class: 'model-fields' }, field('显示名称', label), field('模型名称', model),
      field('接口协议', apiFormat, 'Responses 可由服务端接续对话，兼容服务须支持对应协议。'),
      field('模型上下文窗口（Token）', contextWindow, '按服务商公布的容量填写，用于预留回答空间和限制每次输入。'),
      field('API 基地址', baseUrl, '支持 HTTP / HTTPS。可填写基础地址或对应接口完整路径；更换地址时需重新填写密钥。'),
      field('API Key', apiKey, '仅在首次配置或更换密钥时填写。'), field('调用超时（秒）', timeout),
      field('服务端自动压缩', compaction, '仅对支持 context_management 的 Responses 服务启用；历史仍计入上下文与输入费用。'),
      h('label', { class: 'model-enabled' }, enabled, '启用此模型')),
      h('div', { class: 'model-actions' }, status, test, save));
    main.append(panel(saved.label, `模型入口：${saved.key}`, summary, form));
  }
}
