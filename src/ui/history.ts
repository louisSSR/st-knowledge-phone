import type { ViewContext } from './view-types.js';
import { button, el, emptyState, icon } from './dom.js';

export function historyView(ctx: ViewContext): HTMLElement {
  const page = el('div');
  const intro = el('div', 'page-intro');
  intro.append(el('h2', '', '搜索足迹'), el('p', '', '只记录你主动发起的搜索。当前对话与世界线各自保存。'));
  page.append(intro);
  if (!ctx.state.history.length) {
    page.append(emptyState('还没有搜索足迹', '遇到一个好问题时，从搜索开始。'));
    return page;
  }
  for (const item of ctx.state.history) {
    const row = button('', () => ctx.search(item.query), 'history-item');
    const copy = el('span');
    const time = new Date(item.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    copy.append(el('strong', '', item.query), el('small', '', `${time} · 世界日期 ${item.worldDate || '未识别'}`));
    const arrow = el('i', 'arrow');
    arrow.append(icon('arrow'));
    row.append(icon('history'), copy, arrow);
    page.append(row);
  }
  let confirming = false;
  const clear = button('清空当前世界线的足迹', () => {
    if (confirming) { ctx.run(ctx.controller.clearHistory()); return; }
    confirming = true;
    clear.textContent = '确认清空';
    clear.classList.add('danger');
  }, 'button subtle full');
  const footer = el('div', 'section-heading');
  footer.append(clear);
  page.append(footer);
  return page;
}
