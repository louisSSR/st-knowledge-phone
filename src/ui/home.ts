import type { ViewContext } from './view-types.js';
import { button, el, icon, sectionHeading } from './dom.js';

export function searchForm(ctx: ViewContext, home = false): HTMLFormElement {
  const form = el('form', `search-form${home ? ' home-search' : ''}`);
  form.setAttribute('role', 'search');
  const input = el('input');
  input.type = 'search';
  input.name = 'query';
  input.placeholder = '查一条规则，认识一个地方…';
  input.setAttribute('aria-label', '搜索离线知识库');
  input.dataset.focusKey = 'query';
  input.autocomplete = 'off';
  input.maxLength = 200;
  input.value = home ? '' : ctx.state.query;
  const submit = el('button', 'submit');
  submit.type = 'submit';
  submit.setAttribute('aria-label', '开始搜索');
  submit.append(icon('arrow'));
  submit.disabled = ctx.state.busy;
  form.append(icon('search'), input, submit);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const query = input.value.trim();
    if (query) ctx.search(query, home ? [] : ctx.state.types);
    else input.focus();
  });
  return form;
}

function worldCard(ctx: ViewContext): HTMLElement {
  const { state } = ctx;
  const card = el('section', 'world-card');
  card.setAttribute('aria-label', '当前世界上下文');
  card.append(el('div', 'eyebrow', 'WORLD CONTEXT · 世界坐标'));
  const date = state.context.worldDate;
  card.append(el('div', `world-date${date ? '' : ' unknown'}`, date ? date.replaceAll('-', ' / ') : '等待故事中的日期'));
  const footer = el('div', 'context-footer');
  footer.append(icon('pin'), el('span', 'context-location', state.context.location.join(' · ') || '地点未指定'));
  footer.append(el('span', 'pill', state.context.strictTimeline ? '严格时间线' : '自由查阅'));
  card.append(footer);
  if (!date && state.context.strictTimeline) card.append(el('p', 'context-note', '日期明确前，只展示不受时间限制的资料。'));
  return card;
}

export function homeView(ctx: ViewContext): HTMLElement {
  const page = el('div', 'home');
  const status = el('div', 'status-line');
  const offline = el('span');
  offline.append(el('span', 'offline-dot'), '离线知识终端');
  status.append(offline, el('span', '', 'VOL. 01 / 随身阅览'));
  page.append(status, el('div', 'eyebrow', 'A LITTLE WINDOW TO YOUR WORLD'));
  page.append(el('h2', 'welcome', '好奇心，随身携带。'));
  page.append(el('p', 'intro', '在故事的此时此地，找到恰好用得上的知识。'));
  page.append(worldCard(ctx), searchForm(ctx, true), sectionHeading('从一个小问题开始', '点击即可检索'));
  const shortcuts = el('div', 'shortcuts');
  for (const [symbol, label, query] of [['♧', '扑克牌怎么玩', '扑克牌怎么玩'], ['⌖', '逛逛涩谷', '涩谷'], ['✧', '找一点秋装灵感', '秋装']]) {
    const shortcut = button('', () => ctx.search(query!), 'shortcut');
    shortcut.append(el('span', 'shortcut-symbol', symbol), document.createTextNode(label!));
    shortcuts.append(shortcut);
  }
  page.append(shortcuts);
  const installed = ctx.state.packs.length;
  const library = button('', () => ctx.run(ctx.controller.navigate('library')), 'library-note');
  const copy = el('span');
  copy.append(el('strong', '', installed ? '你的随身书架已就绪' : '先给书架添一点知识'));
  copy.append(el('small', '', installed ? `已安装 ${installed} 个资料包 · 内容保存在本浏览器` : '安装原创演示包，或导入自己的离线资料。'));
  const arrow = el('i', 'arrow');
  arrow.append(icon('arrow'));
  library.append(icon('library'), copy, arrow);
  page.append(library);
  const footer = el('div', 'home-footnote');
  footer.append(el('span', '', '只查资料 · 不代写故事'), el('span', '', '本地保存 · 无联网检索'));
  page.append(footer);
  return page;
}
