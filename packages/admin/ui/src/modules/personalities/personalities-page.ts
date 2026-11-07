import type { AiPersonality, AiPersonalityAdmin, AiPersonalityFields, AiPersonalitySettings, AiPersonalityPreviewEvent } from '@yss123/cage-ai-protocol';
import { api, postEvents, run } from '../../shared/api.js';
import { badge, field, h } from '../../shared/dom.js';

/** 编辑器只提交框架协议；配置与试聊的权限、模型和持久化全部由 AI 运行时处理。 */
export async function renderPersonalities(main: HTMLElement) {
  let catalog = await api<AiPersonalityAdmin>('GET', '/api/ai/admin/personalities');
  let selected = catalog.settings.defaultKey, saving = false, activePreview: AbortController | null = null;
  const drafts = new Map<string, AiPersonality>();
  const grid = h('div', { class: 'persona-grid', 'aria-label': '性格列表' });
  const editor = h('div', { class: 'persona-editor-area' });
  const defaults = h('div', { class: 'persona-default' });
  const current = () => drafts.get(selected) ?? catalog.items.find(p => p.key === selected)!;
  function drawDefault() {
    const select = h('select', { 'aria-label': '默认性格', value: catalog.settings.defaultKey },
      catalog.items.filter(p => p.enabled).map(p => h('option', { value: p.key }, `${p.avatar} ${p.label}`)));
    const save = h('button', { onclick: async () => {
      const result = await run(() => api<AiPersonalitySettings>('POST', '/api/ai/admin/assistant-settings', {
        version: catalog.settings.version, defaultKey: select.value,
      }), '默认性格已更新', save);
      if (result) { catalog.settings = result; drawCards(); drawDefault(); }
    } }, '设为默认');
    defaults.replaceChildren(h('div', {}, h('strong', {}, '默认的相处方式'), h('p', {}, '跟随默认的会话，从下一条消息开始使用此性格。')),
      h('div', { class: 'persona-default-actions' }, select, save));
  }
  function drawCards() {
    const all = new Map(catalog.items.map(p => [p.key, p]));
    for (const [key, draft] of drafts) if (!all.has(key)) all.set(key, draft);
    grid.replaceChildren(...[...all.values()].map(profile => h('button', { class: `persona-card${selected === profile.key ? ' selected' : ''}`,
      'aria-pressed': selected === profile.key, onclick: () => { if (saving) return; selected = profile.key; drawCards(); drawEditor(); },
    }, h('span', { class: 'persona-avatar', 'aria-hidden': 'true' }, profile.avatar), h('span', { class: 'persona-card-copy' },
      h('strong', {}, profile.label), h('small', {}, profile.description)),
      h('span', { class: 'persona-card-tags' }, profile.key === catalog.settings.defaultKey ? badge('默认', 'green') : !profile.enabled ? badge('已停用') : badge(profile.builtin ? '预设' : '自定义')))));
  }
  function drawEditor() {
    activePreview?.abort(); activePreview = null;
    let profile = current();
    const label = h('input', { value: profile.label, required: true, maxlength: 40 });
    const avatar = h('input', { value: profile.avatar, required: true, maxlength: 16 });
    const description = h('textarea', { rows: 5, required: true, maxlength: 3000, value: profile.description, placeholder: '描述你希望助理怎样表达、解释和与你相处…' });
    const verbosity = h('select', { value: profile.verbosity }, ...[['concise', '简短利落'], ['balanced', '详略适中'], ['detailed', '详细解释']].map(([value, text]) => h('option', { value }, text)));
    const emoji = h('select', { value: profile.emoji }, ...[['none', '不使用'], ['light', '偶尔点缀'], ['expressive', '活泼一些']].map(([value, text]) => h('option', { value }, text)));
    const address = h('input', { value: profile.address, maxlength: 40, placeholder: '留空，自然称呼' });
    const examples = [0, 1, 2].map(i => h('input', { value: profile.examples[i] ?? '', maxlength: 400, 'aria-label': `说话示例 ${i + 1}`, placeholder: `示例 ${i + 1}（可选）` }));
    const enabled = h('input', { type: 'checkbox', checked: profile.enabled });
    const status = h('p', { class: 'persona-save-status', role: 'status' }, drafts.has(profile.key) ? '有未保存的修改' : profile.version ? `已保存 · 版本 ${profile.version}` : '框架预设，可直接调整');
    const values = (): AiPersonalityFields => ({ label: label.value, avatar: avatar.value, description: description.value,
      verbosity: verbosity.value as AiPersonalityFields['verbosity'], emoji: emoji.value as AiPersonalityFields['emoji'], address: address.value,
      examples: examples.map(e => e.value.trim()).filter(Boolean), enabled: enabled.checked });
    const save = h('button', { class: 'primary', type: 'submit' }, '保存性格');
    const form = h('form', { class: 'persona-form', oninput: () => {
      drafts.set(profile.key, { ...profile, ...values() }); status.textContent = '有未保存的修改';
    }, onsubmit: async event => {
      event.preventDefault(); if (saving) return; saving = true;
      // 保存期间冻结这份表单，避免请求结束后把后来输入的草稿误标为已保存。
      const controls = [label, avatar, description, verbosity, emoji, address, ...examples, enabled];
      controls.forEach(control => { control.disabled = true; });
      try {
        const result = await run(() => api<AiPersonality>('POST', `/api/ai/admin/personalities/${encodeURIComponent(profile.key)}`, {
          ...values(), version: profile.version,
        }).catch(error => { status.textContent = (error as Error).message; throw error; }), '性格已保存', save);
        if (result) {
          profile = result; drafts.delete(result.key);
          catalog.items = [...catalog.items.filter(p => p.key !== result.key), result];
          status.textContent = `已保存 · 版本 ${result.version} · 后续消息生效`; drawCards(); drawDefault();
        }
      } finally { saving = false; controls.forEach(control => { control.disabled = false; }); }
    } }, h('div', { class: 'persona-section-heading' }, h('span', { class: 'eyebrow' }, 'CHARACTER'), h('h2', {}, '定义它的表达方式')),
      h('div', { class: 'persona-fields' }, field('性格名称', label), field('头像符号', avatar, '输入一个表情或短符号'),
        field('回复长度', verbosity), field('表情使用', emoji)), field('性格描述', description), field('如何称呼用户', address),
      h('div', { class: 'persona-examples' }, h('strong', {}, '说话示例'), h('small', {}, '两三句自然的话，帮助助理找到语气。'), examples),
      h('label', { class: 'persona-enabled' }, enabled, '允许用户选择此性格'), h('div', { class: 'persona-save-row' }, status, save));

    const output = h('div', { class: 'persona-preview-answer', role: 'log', 'aria-live': 'polite' }, '先打个招呼，听听它会怎么说。');
    const message = h('textarea', { rows: 2, required: true, maxlength: 2000, 'aria-label': '试聊消息', value: '今天事情有点多，你能怎么帮我？' });
    const previewStatus = h('p', { class: 'persona-preview-status', role: 'status' });
    const tryButton = h('button', { class: 'primary', type: 'submit' }, '试聊一下');
    const stop = h('button', { type: 'button', hidden: true, onclick: () => activePreview?.abort() }, '停止');
    const preview = h('form', { class: 'persona-preview', onsubmit: async event => {
      event.preventDefault(); if (activePreview || !form.reportValidity()) return;
      const controller = new AbortController(); activePreview = controller; tryButton.disabled = true; stop.hidden = false;
      output.textContent = ''; previewStatus.textContent = '正在准备回复…'; let done = false;
      const abort = () => controller.abort();
      window.addEventListener('hashchange', abort, { once: true }); window.addEventListener('cage:session-expired', abort, { once: true });
      try {
        await postEvents<AiPersonalityPreviewEvent>('/api/ai/admin/personality-preview', { profile: values(), message: message.value }, value => {
          if (value.type === 'delta') { output.append(document.createTextNode(value.text)); previewStatus.textContent = '正在回复…'; }
          if (value.type === 'done') { output.textContent = value.result.text; previewStatus.textContent = `试聊完成 · ${(value.result.latencyMs / 1000).toFixed(1)} 秒`; done = true; }
          if (value.type === 'error') throw new Error(value.code === 'RATE_LIMITED' ? '已有试聊正在进行，请稍后重试' : `试聊未完成（${value.code}），请检查模型配置后重试`);
        }, controller.signal);
        if (!done) throw new Error('试聊连接中断，请重试');
      } catch (error) { previewStatus.textContent = controller.signal.aborted ? '已停止，保留已收到的文字' : (error as Error).message; }
      finally { window.removeEventListener('hashchange', abort); window.removeEventListener('cage:session-expired', abort); if (activePreview === controller) activePreview = null; tryButton.disabled = false; stop.hidden = true; }
    } }, h('span', { class: 'eyebrow' }, 'SAY HELLO'), h('h2', {}, '先聊两句'),
      h('p', { class: 'persona-preview-intro' }, '直接体验当前草稿的语气，不必先保存。这里仅预览表达风格，不处理实际业务。'),
      output, previewStatus, field('你想说什么', message), h('div', { class: 'persona-preview-actions' }, stop, tryButton));
    editor.replaceChildren(form, preview);
  }
  const create = h('button', { class: 'primary', onclick: () => {
    if (saving) return;
    const key = `custom-${crypto.randomUUID()}`;
    drafts.set(key, { key, label: '我的助理', avatar: '✨', description: '', verbosity: 'balanced', address: '', emoji: 'light', examples: [], enabled: true, version: 0, builtin: false, updatedAt: null });
    selected = key; drawCards(); drawEditor(); editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, '＋ 自定义性格');
  main.append(h('div', { class: 'persona-overview' }, h('div', {}, h('span', { class: 'eyebrow' }, 'A LITTLE CHARACTER'),
    h('h2', {}, '同样的可靠，多一点个性。'), h('p', {}, '选一种合拍的语气，或创造属于团队的助理。')), create), defaults, grid, editor);
  drawDefault(); drawCards(); drawEditor();
}
