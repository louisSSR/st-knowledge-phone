import { button, el, icon, sectionHeading } from './dom.js';
export function searchForm(ctx, home = false) {
    const form = el('form', `search-form${home ? ' home-search' : ''}`);
    form.setAttribute('role', 'search');
    const input = el('input');
    input.type = 'search';
    input.name = 'query';
    input.placeholder = '输入条目名称或关键词…';
    input.setAttribute('aria-label', ctx.state.settings.sourceMode === 'online' ? '搜索中文维基百科' : '搜索离线知识库');
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
            ctx.search(query, home || ctx.state.settings.sourceMode === 'online' ? [] : ctx.state.types);
        else
            input.focus();
    });
    return form;
}
export function sourceModeSwitch(ctx) {
    const row = el('div', 'filters');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '搜索来源');
    for (const [mode, label] of [['online', '联网科普'], ['offline', '离线资料']]) {
        const choose = button(label, () => ctx.run(ctx.controller.setSourceMode(mode)), 'filter');
        choose.setAttribute('aria-pressed', String(ctx.state.settings.sourceMode === mode));
        choose.dataset.focusKey = `source-mode:${mode}`;
        choose.disabled = ctx.state.busy;
        row.append(choose);
    }
    return row;
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
    const online = ctx.state.settings.sourceMode === 'online';
    const page = el('div', 'home');
    const status = el('div', 'status-line');
    const source = el('span');
    source.append(el('span', 'offline-dot'), online ? '联网科普 · 中文维基百科' : '离线资料 · 本机查阅');
    status.append(source, el('span', '', '随身阅览'));
    page.append(status, el('div', 'eyebrow', 'A LITTLE WINDOW TO YOUR WORLD'));
    page.append(el('h2', 'welcome', '好奇心，随身携带。'));
    page.append(el('p', 'intro', online ? '输入不熟悉的名词，查找现成百科原文，沿术语链接继续了解。' : '从已有知识库查找原文，沿文中的名词继续探索。'));
    page.append(sourceModeSwitch(ctx));
    if (!online)
        page.append(worldCard(ctx));
    page.append(searchForm(ctx, true), el('p', 'settings-caption', online
        ? '点击搜索时仅发送查询词，不发送聊天内容。无需先下载资料库；已读正文会保存在本机。'
        : '检索本机资料，不联网。需要通用百科时，可切换到联网科普。'));
    const keywords = [...new Set(ctx.state.chat.context.recentKeywords.map(value => value.trim()).filter(Boolean))].slice(0, 6);
    if (keywords.length) {
        page.append(sectionHeading('聊天中提到的话题', online ? '点击后发送该词搜索' : '点击查原文'));
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
    copy.append(el('strong', '', online ? '来源与已读缓存' : connected ? '本地知识库已连接' : '选择可选的离线资料'));
    copy.append(el('small', '', online ? `${ctx.state.cachedPages.length} 篇已读原文 · 可在本机再次打开`
        : connected ? `${connected.name || connected.fileName} · 读取原文` : '已有 ZIM 文件可在这里连接；联网搜索无需安装。'));
    const arrow = el('i', 'arrow');
    arrow.append(icon('arrow'));
    library.append(icon('library'), copy, arrow);
    page.append(library);
    const footer = el('div', 'home-footnote');
    footer.append(el('span', '', '检索来源原文'), el('span', '', online ? '联网查词 · 本机缓存' : '本地读取 · 不联网'));
    page.append(footer);
    return page;
}
