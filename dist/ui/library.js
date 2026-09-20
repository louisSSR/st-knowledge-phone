import { button, el, emptyState, sectionHeading } from './dom.js';
function packCard(ctx, pack) {
    const card = el('article', 'pack');
    const legacy = pack.id === 'knowledge-phone-original-demo' ? '开发样本' : /^wikipedia-zh-(?:starter|general)-/.test(pack.id) ? '历史摘录' : '自定义资料';
    card.append(el('span', 'pill', legacy), el('h3', '', pack.name), el('p', '', pack.description));
    if (legacy !== '自定义资料')
        card.append(el('p', '', '保留既有文件，已从搜索与推荐中撤出；可手动移除。'));
    const meta = el('div', 'row between');
    meta.append(el('small', '', `${pack.entryCount} 条资料 · v${pack.version}`));
    const remove = button('移除', () => {
        if (card.querySelector('.confirm-row'))
            return;
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
function formatBytes(size) {
    if (!Number.isFinite(size) || size <= 0)
        return '文件大小未提供';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function archiveCard(ctx, archive) {
    const card = el('article', 'pack');
    card.style.overflowWrap = 'anywhere';
    card.append(el('span', 'pill', archive.connected ? '已连接 · 本地文件' : '未连接'), el('h3', '', archive.name || '未命名知识库'));
    card.append(el('p', '', `文件：${archive.fileName || '文件名未提供'}`));
    const count = Number.isSafeInteger(archive.articleCount) && archive.articleCount >= 0 ? `${archive.articleCount.toLocaleString('zh-CN')} 篇文章` : '文章数未提供';
    card.append(el('p', '', `${formatBytes(archive.size)} · ${count}`));
    card.append(el('p', '', archive.date
        ? `文件名快照月份：${archive.date.slice(0, 7)}（非逐条史料核验）`
        : '文件名未提供快照日期，严格时间线下不可用。'));
    if (!archive.connected)
        card.append(el('p', '', '重新选择对应的 .zim 文件即可连接。'));
    const remove = button('移除连接', () => ctx.run(ctx.controller.detachArchive(archive.id)), 'button small subtle');
    remove.disabled = ctx.state.busy;
    card.append(remove, el('p', 'settings-caption', '移除连接不会删除磁盘上的知识库文件。'));
    return card;
}
function archivePanel(ctx) {
    const panel = el('section', 'import-panel');
    panel.append(el('h3', '', '连接现成的本地知识库'));
    panel.append(el('p', '', '选择已下载的 .zim 知识库，在原文中查找条目并沿名词链接继续阅读。当前一次连接一个库，选择新库会切换连接。'));
    const label = el('label', 'file-picker', '选择本地 .zim 文件');
    const input = el('input');
    input.type = 'file';
    input.accept = '.zim';
    input.disabled = ctx.state.busy;
    input.setAttribute('aria-label', '选择本地 ZIM 知识库');
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file)
            ctx.run(ctx.controller.attachArchive(file));
        input.value = '';
    });
    label.append(input);
    if (ctx.state.canRetryArchive) {
        const retry = button('重试连接刚才的文件', () => ctx.run(ctx.controller.retryArchive()), 'button primary full');
        retry.disabled = ctx.state.busy;
        panel.append(retry, el('p', 'settings-caption', '已保留刚才选择的文件，无需再次下载或选择。'));
    }
    panel.append(label, el('p', 'settings-caption', '文件内容在本机读取，不上传。重新打开浏览器后可能需要重新选择文件。'));
    const sources = el('div', 'stack');
    for (const [title, url] of [
        ['Kiwix 官方资料库目录（按主题选择）', 'https://library.kiwix.org/'],
        ['中文维基教科书完整正文 · 94 MiB · 2026-07（无图）', 'https://download.kiwix.org/zim/wikibooks/wikibooks_zh_all_nopic_2026-07.zim'],
        ['维基百科整库目录（nopic 为无图正文，mini 仅含导言）', 'https://download.kiwix.org/zim/wikipedia/'],
    ]) {
        const link = el('a', '', title);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        sources.append(link);
    }
    panel.append(sources, el('p', 'settings-caption', '点击来源链接会联网；文件下载完成后再在上方选择。请核对语言、覆盖范围和版本，mini 不能代替全文库。'));
    return panel;
}
function importPanel(ctx) {
    const panel = el('section', 'import-panel');
    panel.append(el('h3', '', '导入自定义 JSON 资料'));
    panel.append(el('p', '', '保留旧版资料格式供自定义内容和开发测试使用；导入成功不表示内容属于成熟库原文。'));
    const label = el('label', 'file-picker', '选择自定义 .pack.json 文件');
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.disabled = ctx.state.busy;
    input.setAttribute('aria-label', '选择 JSON 知识资料包');
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file)
            ctx.run(ctx.controller.install(file));
    });
    label.append(input);
    panel.append(label, el('p', 'settings-caption', '仅支持 .pack.json，单包最多 10 MB。内容保存在当前浏览器。'));
    return panel;
}
export function libraryView(ctx) {
    const page = el('div');
    const intro = el('div', 'page-intro');
    intro.append(el('h2', '', '我的知库'), el('p', '', '查阅成熟来源，并保留你已经读过的原文。'));
    page.append(intro);
    const online = el('section', 'pack');
    online.append(el('span', 'pill', '联网科普来源'), el('h3', '', '中文维基百科'), el('p', '', '输入词语即可搜索并阅读来源原文，无需先下载资料库。只发送你主动查询的词，不发送聊天内容。'));
    const lookup = button(ctx.state.settings.sourceMode === 'online' ? '前往百科搜索' : '切换到联网科普', () => ctx.run((async () => {
        if (ctx.state.settings.sourceMode !== 'online')
            await ctx.controller.setSourceMode('online');
        await ctx.controller.navigate('search');
    })()), 'button small primary');
    lookup.disabled = ctx.state.busy;
    online.append(lookup, el('p', 'settings-caption', '现代百科知识未作剧情年代核验；来源缺少的内容不会由模型补写。'));
    page.append(online, sectionHeading('已读缓存', `${ctx.state.cachedPages.length} 篇`));
    const cached = el('div', 'stack');
    for (const result of ctx.state.cachedPages) {
        const read = button('', () => ctx.run(ctx.controller.readCached(result)), 'pack cached-page');
        read.setAttribute('aria-label', `阅读缓存：${result.entry.title}`);
        read.dataset.focusKey = `cached:${result.packId}:${result.entry.id}`;
        read.style.textAlign = 'left';
        read.style.overflowWrap = 'anywhere';
        const fetched = result.entry.metadata.fetchedAt;
        const date = typeof fetched === 'number' || typeof fetched === 'string' ? new Date(fetched) : null;
        const dateLabel = date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '未记录';
        read.append(el('span', 'pill', '本机已读缓存'), el('h3', '', result.entry.title), el('p', '', `${result.entry.source.name} · 获取于 ${dateLabel}`), el('small', '', '打开缓存正文 · 不联网刷新'));
        read.disabled = ctx.state.busy;
        cached.append(read);
    }
    if (!ctx.state.cachedPages.length)
        cached.append(emptyState('读过的原文会留在这里', '打开联网百科正文后，可从这里再次阅读已保存的页面。断网时也能打开已有缓存。'));
    page.append(cached);
    const offline = el('details', 'import-panel');
    offline.open = ctx.state.settings.sourceMode === 'offline' || ctx.state.canRetryArchive;
    offline.append(el('summary', '', `可选 · 离线知识库（${ctx.state.archives.length} 个）`), el('p', 'settings-caption', '需要断网检索大量资料时，可连接已下载的 ZIM 文件。联网科普和已读缓存不需要安装它。'));
    const chooseOffline = button('使用离线资料搜索', () => ctx.run(ctx.controller.setSourceMode('offline')), 'button small subtle');
    chooseOffline.disabled = ctx.state.busy || ctx.state.settings.sourceMode === 'offline';
    offline.append(chooseOffline, archivePanel(ctx), sectionHeading('本地知识库', `${ctx.state.archives.length} 个`));
    const archives = el('div', 'stack');
    ctx.state.archives.forEach(archive => archives.append(archiveCard(ctx, archive)));
    if (!ctx.state.archives.length)
        archives.append(emptyState('尚未连接知识库', '从上方选择现成的 .zim 文件，即可开始查找原文。'));
    offline.append(archives);
    page.append(offline);
    const advanced = el('details', 'import-panel');
    advanced.append(el('summary', '', `高级 · 自定义与旧版资料（${ctx.state.packs.length} 个）`));
    advanced.append(el('p', 'settings-caption', '已安装内容继续保留。开发样本和历史摘录与正式原文来源分开显示。'));
    const packs = el('div', 'stack');
    ctx.state.packs.forEach(pack => packs.append(packCard(ctx, pack)));
    advanced.append(packs, importPanel(ctx));
    page.append(advanced);
    return page;
}
