import type { PackManifest } from '../core/types.js';
import type { ViewContext } from './view-types.js';
import { button, el, emptyState, sectionHeading } from './dom.js';

function packCard(ctx: ViewContext, pack: PackManifest): HTMLElement {
  const card = el('article', 'pack');
  card.append(el('h3', '', pack.name), el('p', '', pack.description));
  const meta = el('div', 'row between');
  meta.append(el('small', '', `${pack.entryCount} 条资料 · v${pack.version}`));
  const remove = button('移除', () => {
    if (card.querySelector('.confirm-row')) return;
    const confirm = el('div', 'confirm-row');
    confirm.append(el('p', '', `移除「${pack.name}」？本浏览器中该资料包将被删除。`));
    const row = el('div', 'row');
    const cancel = button('保留', () => { confirm.remove(); remove.focus(); }, 'button small subtle');
    const accept = button('确认移除', () => ctx.run(ctx.controller.uninstall(pack.id)), 'button small danger');
    row.append(cancel, accept);
    confirm.append(row);
    card.append(confirm);
    cancel.focus();
  }, 'button small subtle');
  remove.disabled = ctx.state.busy;
  meta.append(remove);
  card.append(meta);
  return card;
}

function importPanel(ctx: ViewContext): HTMLElement {
  const panel = el('section', 'import-panel');
  panel.append(el('h3', '', '给书架添一份资料'));
  panel.append(el('p', '', '演示包包含原创规则、地点与时间线样例，帮助你试用检索；它不是完整百科。'));
  const sampleInstalled = ctx.state.packs.some(pack => pack.id === 'knowledge-phone-original-demo');
  const sample = button('安装原创演示包', () => ctx.run(ctx.controller.installSample()), 'button primary full');
  sample.disabled = ctx.state.busy || sampleInstalled;
  if (sampleInstalled) sample.textContent = '演示包已安装';
  panel.append(sample);
  const label = el('label', 'file-picker', '导入自己的资料包');
  const input = el('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.disabled = ctx.state.busy;
  input.setAttribute('aria-label', '选择 JSON 知识资料包');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) ctx.run(ctx.controller.install(file));
  });
  label.append(input);
  panel.append(label, el('p', 'settings-caption', '支持 .pack.json，单包最多 10 MB。资料仅保存在当前浏览器。'));
  return panel;
}

export function libraryView(ctx: ViewContext): HTMLElement {
  const page = el('div');
  const intro = el('div', 'page-intro');
  intro.append(el('h2', '', '我的知库'), el('p', '', '把知识放进口袋。离线可用，随时阅读。'));
  page.append(intro);
  if (ctx.state.packs.length) page.append(button('浏览当前世界资料', () => ctx.search(''), 'button full'));
  page.append(sectionHeading('已安装资料包', `${ctx.state.packs.length} 个`));
  const packs = el('div', 'stack');
  ctx.state.packs.forEach(pack => packs.append(packCard(ctx, pack)));
  if (!ctx.state.packs.length) packs.append(emptyState('书架还是空的', '从下方安装演示包，开启第一次检索。'));
  page.append(packs, importPanel(ctx));
  return page;
}
