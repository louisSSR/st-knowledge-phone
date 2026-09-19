import { button, el, icon, sectionHeading } from './dom.js';
export function searchForm(ctx, home = false) {
    const form = el('form', `search-form${home ? ' home-search' : ''}`);
    form.setAttribute('role', 'search');
    const input = el('input');
    input.type = 'search';
    input.name = 'query';
    input.placeholder = '输入条目名称或关键词…';
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
        if (query)
            ctx.search(query, home ? [] : ctx.state.types);
        else
            input.focus();
    });
    return form;
}
function worldCard(ctx) {
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
    if (!date && state.context.strictTimeline)
        card.append(el('p', 'context-note', '日期明确前，只展示不受时间限制的资料。'));
    return card;
}
export function homeView(ctx) {
    const page = el('div', 'home');
    const status = el('div', 'status-line');
    const offline = el('span');
    offline.append(el('span', 'offline-dot'), '离线知识终端');
    status.append(offline, el('span', '', 'VOL. 01 / 随身阅览'));
    page.append(status, el('div', 'eyebrow', 'A LITTLE WINDOW TO YOUR WORLD'));
    page.append(el('h2', 'welcome', '好奇心，随身携带。'));
    page.append(el('p', 'intro', '从已有知识库查找原文，沿文中的名词继续探索。'));
    page.append(worldCard(ctx), searchForm(ctx, true));
    const keywords = [...new Set(ctx.state.chat.context.recentKeywords.map(value => value.trim()).filter(Boolean))].slice(0, 6);
    if (keywords.length) {
        page.append(sectionHeading('聊天中提到的话题', '点击查原文'));
        const shortcuts = el('div', 'shortcuts');
        for (const query of keywords) {
            const shortcut = button(query, () => ctx.search(query), 'shortcut');
            shortcut.style.overflowWrap = 'anywhere';
            shortcuts.append(shortcut);
        }
        page.append(shortcuts);
    }
    const connected = ctx.state.archives.find(archive => archive.connected);
    const library = button('', () => ctx.run(ctx.controller.navigate('library')), 'library-note');
    const copy = el('span');
    copy.style.minWidth = '0';
    copy.style.overflowWrap = 'anywhere';
    copy.append(el('strong', '', connected ? '本地知识库已连接' : '连接你的本地知识库'));
    copy.append(el('small', '', connected ? `${connected.name || connected.fileName} · 读取原文` : '选择已下载的 .zim 文件，开始检索原文。'));
    const arrow = el('i', 'arrow');
    arrow.append(icon('arrow'));
    library.append(icon('library'), copy, arrow);
    page.append(library);
    const footer = el('div', 'home-footnote');
    footer.append(el('span', '', '原文检索 · 不生成答案'), el('span', '', '本地读取 · 无联网检索'));
    page.append(footer);
    return page;
}
