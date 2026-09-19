import { button, el, emptyState, iconButton } from './dom.js';
import { searchForm } from './home.js';
const metadata = (entry, keys) => keys.flatMap(key => {
    const value = entry.metadata[key];
    return value === undefined ? [] : [Array.isArray(value) ? value.join(' / ') : String(value)];
});
const located = (entry) => entry.location;
const dated = (entry) => [entry.dates.occurredAt || entry.dates.publishedAt || '时间未标注'];
/** Adding a card type extends this registry without changing page or search logic. */
export const cardRenderers = {
    game_rule: { label: '游戏规则', detail: entry => metadata(entry, ['players', 'duration', 'difficulty']) },
    historical_event: { label: '历史事件', detail: dated },
    sports_match: { label: '体育赛事', detail: entry => [...dated(entry), ...metadata(entry, ['teams', 'score'])] },
    store: { label: '商店', detail: entry => [...located(entry), ...metadata(entry, ['hours', 'category'])] },
    brand: { label: '品牌', detail: entry => metadata(entry, ['category', 'origin']) },
    product: { label: '商品', detail: entry => metadata(entry, ['brand', 'category', 'price']) },
    person: { label: '人物', detail: entry => metadata(entry, ['occupation', 'nationality']) },
    place: { label: '地点', detail: located },
    article: { label: '知识短文', detail: entry => entry.tags.slice(0, 3) },
};
export function bookmarked(ctx, result) {
    return ctx.state.bookmarks.some(item => item.packId === result.packId && item.entryId === result.entry.id);
}
function resultCard(ctx, result) {
    const { entry } = result;
    const renderer = cardRenderers[entry.type];
    const card = el('article', 'result-card');
    const open = button('', () => ctx.run(ctx.controller.read(result)), 'result-open');
    open.dataset.focusKey = `result:${result.packId}:${entry.id}`;
    open.setAttribute('aria-label', `阅读：${entry.title}`);
    open.append(el('span', 'result-kind', `${renderer.label} / 离线资料`));
    open.append(el('h3', '', entry.title), el('p', '', entry.summary));
    const details = renderer.detail(entry).slice(0, 3).join(' · ');
    if (details)
        open.append(el('span', 'result-detail', details));
    const source = el('span', 'result-source');
    source.append(el('span', '', result.packName), el('span', '', '打开阅读 ↗'));
    open.append(source);
    const saved = bookmarked(ctx, result);
    const bookmark = iconButton(saved ? `取消收藏：${entry.title}` : `收藏：${entry.title}`, 'bookmark', () => ctx.run(ctx.controller.toggleBookmark(result)));
    bookmark.setAttribute('aria-pressed', String(saved));
    bookmark.dataset.focusKey = `bookmark:${result.packId}:${entry.id}`;
    card.append(open, bookmark);
    return card;
}
export function resultList(ctx) {
    const list = el('div', 'result-list');
    ctx.state.results.forEach(result => list.append(resultCard(ctx, result)));
    return list;
}
function filters(ctx) {
    const row = el('div', 'filters');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '按资料类型筛选');
    for (const [key, label] of [['all', '全部'], ...Object.entries(cardRenderers).map(([key, value]) => [key, value.label])]) {
        const chosen = key === 'all' ? !ctx.state.types.length : ctx.state.types.includes(key);
        const filter = button(label, () => ctx.search(ctx.state.query, key === 'all' ? [] : [key]), 'filter');
        filter.dataset.focusKey = `filter:${key}`;
        filter.setAttribute('aria-pressed', String(chosen));
        filter.disabled = ctx.state.busy;
        row.append(filter);
    }
    return row;
}
function pagination(ctx, bookmarks = false) {
    const row = el('div', 'pagination');
    const go = (offset) => {
        if (bookmarks)
            ctx.navigate('bookmarks', offset);
        else
            ctx.search(ctx.state.query, ctx.state.types, offset);
    };
    const previous = button('上一页', () => go(Math.max(0, ctx.offset - 12)), 'button small subtle');
    const next = button('下一页', () => go(ctx.offset + 12), 'button small subtle');
    previous.disabled = ctx.offset === 0 || ctx.state.busy;
    next.disabled = ctx.offset + ctx.state.results.length >= ctx.state.total || ctx.state.busy;
    row.append(previous, el('span', '', `第 ${Math.floor(ctx.offset / 12) + 1} 页`), next);
    return row;
}
export function searchView(ctx) {
    const page = el('div');
    page.append(searchForm(ctx), filters(ctx));
    if (!ctx.state.packs.length && !ctx.state.busy) {
        page.append(emptyState('先为书架添一点知识', '安装一个资料包后，就能浏览全部资料或输入关键词检索。', button('前往知库', () => ctx.navigate('library'), 'button primary')));
        return page;
    }
    const meta = el('div', 'results-meta');
    meta.append(el('span', '', `${ctx.state.query ? '找到' : '当前世界共有'} ${ctx.state.total} 条资料`), el('span', '', ctx.state.context.strictTimeline ? '已按当前世界筛选' : '自由查阅'));
    page.append(meta);
    if (ctx.state.results.length)
        page.append(resultList(ctx));
    else if (!ctx.state.busy)
        page.append(emptyState('这次还没找到', '试试更短的关键词，或检查世界日期、地点与已安装的资料包。'));
    if (ctx.state.suggestions.length) {
        const suggestions = el('div', 'suggestions');
        suggestions.setAttribute('aria-label', '相关搜索');
        ctx.state.suggestions.slice(0, 6).forEach(query => suggestions.append(button(query, () => ctx.search(query), 'filter')));
        page.append(suggestions);
    }
    if (ctx.state.total > 12)
        page.append(pagination(ctx));
    return page;
}
export function bookmarksView(ctx) {
    const page = el('div');
    const heading = el('div', 'page-intro');
    heading.append(el('h2', '', '收藏夹'), el('p', '', '为以后留一页。这里的资料也遵守当前世界的时间与地点。'));
    page.append(heading);
    if (ctx.state.results.length) {
        page.append(resultList(ctx));
        if (ctx.state.total > 12)
            page.append(pagination(ctx, true));
    }
    else
        page.append(emptyState('还没有可展示的收藏', '在搜索结果或阅读页轻点书签。跨越世界时间后，部分收藏可能暂时不可见。', button('去搜索', () => ctx.run(ctx.controller.navigate('search')), 'button primary')));
    return page;
}
