import type { ChatSettings } from '../core/types.js';
import { availableThemes } from '../themes/manager.js';
import type { ViewContext } from './view-types.js';
import { el } from './dom.js';

function field(label: string, input: HTMLElement, description?: string): HTMLLabelElement {
  const node = el('label', 'field');
  node.append(el('span', '', label), input);
  if (description) node.append(el('small', '', description));
  return node;
}

function select(name: string, value: string, options: [string, string][]): HTMLSelectElement {
  const input = el('select');
  input.name = name;
  input.dataset.focusKey = name;
  options.forEach(([key, label]) => {
    const option = el('option', '', label);
    option.value = key;
    input.append(option);
  });
  input.value = value;
  return input;
}

function timeSettings(ctx: ViewContext): HTMLElement {
  const group = el('div', 'setting-group');
  const mode = select('mode', ctx.state.chat.mode, [
    ['story', '跟随剧情'], ['custom', '自定义世界日期'], ['modern', '现代模式 · 今天'],
  ]);
  const descriptions: Record<string, string> = {
    story: '从最近的剧情中读取明确标注的世界日期与地点；未识别时会如实显示。',
    custom: '用你指定的日期检索，适合回忆、历史故事或另一个时间点。',
    modern: '使用此设备的本地日历日期，适合发生在当下的故事。',
  };
  group.append(field('世界时间', mode));
  const help = el('p', 'settings-help', descriptions[mode.value]);
  group.append(help);
  const date = el('input');
  date.type = 'date';
  date.name = 'customDate';
  date.dataset.focusKey = 'customDate';
  date.value = ctx.state.chat.customDate;
  date.disabled = mode.value !== 'custom';
  date.required = mode.value === 'custom';
  mode.addEventListener('change', () => {
    date.disabled = mode.value !== 'custom';
    date.required = mode.value === 'custom';
    help.textContent = descriptions[mode.value]!;
  });
  group.append(field('自定义日期', date));
  const location = el('input');
  location.name = 'location';
  location.dataset.focusKey = 'location';
  location.value = ctx.state.chat.location;
  location.placeholder = '例如：日本, 东京, 涩谷';
  location.maxLength = 200;
  group.append(field('当前地点', location, '多个地点可用逗号分隔。留空时跟随剧情识别。'));
  const strict = el('input');
  strict.type = 'checkbox';
  strict.name = 'strictTimeline';
  strict.checked = ctx.state.chat.strictTimeline;
  strict.dataset.focusKey = 'strictTimeline';
  const strictLabel = el('label', 'check-field');
  const copy = el('span');
  copy.append(el('strong', '', '严格遵循世界时间'), el('small', '', '过滤尚不可知的内容，以及在此时此地无效的资料。'));
  strictLabel.append(strict, copy);
  group.append(strictLabel);
  return group;
}

function offlineSetting(): HTMLElement {
  const group = el('div', 'setting-group');
  const row = el('div', 'online-off');
  row.append(el('span', '', '在线模型增强'));
  const toggle = el('button', '', 'OFF');
  toggle.type = 'button';
  toggle.disabled = true;
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', '在线模型增强，不提供启用');
  toggle.setAttribute('aria-checked', 'false');
  row.append(toggle);
  group.append(row, el('p', 'settings-caption', '使用本地资料库的原有索引，不调用模型，也不上传聊天。大库快照不等于历史版本，严格时间线按快照日期保守过滤。'));
  return group;
}

export function settingsView(ctx: ViewContext): HTMLElement {
  const page = el('div');
  const intro = el('div', 'page-intro');
  intro.append(el('h2', '', '终端设置'), el('p', '', '调整你的阅读空间与世界坐标。'));
  page.append(intro);
  const form = el('form', 'settings-form');
  const theme = select('theme', ctx.state.settings.theme, availableThemes().map(item => [item.id, item.name]));
  form.append(field('外观主题', theme, '午夜书房 · 墨紫与薄金 / 彩色棋局 · 原创彩色棋盘'));
  form.append(timeSettings(ctx), offlineSetting());
  const save = el('button', 'button primary full', '保存设置');
  save.type = 'submit';
  save.disabled = ctx.state.busy;
  const saveRow = el('div', 'save-row');
  saveRow.append(save);
  form.append(saveRow);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const data = new FormData(form);
    const chat: ChatSettings = {
      ...ctx.state.chat,
      mode: data.get('mode') as ChatSettings['mode'],
      customDate: String(data.get('customDate') ?? ctx.state.chat.customDate),
      location: String(data.get('location') ?? '').trim(),
      strictTimeline: data.has('strictTimeline'),
    };
    ctx.run(ctx.controller.saveSettings({ ...ctx.state.settings, theme: String(data.get('theme')) }, chat));
  });
  page.append(form);
  return page;
}
