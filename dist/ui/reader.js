import { button, el, icon } from './dom.js';
import { bookmarked, cardRenderers } from './results.js';
function sourceNote(ctx) {
    const reader = ctx.state.reader;
    const source = reader.result.entry.source;
    const note = el('dl', 'source-note');
    const rows = [
        ['来源', `${source.name} · ${reader.result.packName}`],
        ['资料更新', source.updatedAt || '未标注'],
        ['使用许可', source.license || '未标注'],
    ];
    rows.forEach(([label, value]) => note.append(el('dt', '', label), el('dd', '', value)));
    if (source.url) {
        try {
            const url = new URL(source.url);
            if (url.protocol === 'https:' || url.protocol === 'http:') {
                const link = el('a', '', '查看原始来源（打开外部网页）');
                link.href = url.href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                const item = el('dd');
                item.append(link);
                note.append(el('dt', '', '原始链接'), item);
            }
        }
        catch { /* Invalid source URLs remain plain pack data and are not navigable. */ }
    }
    return note;
}
export function readerView(ctx) {
    const { result, content } = ctx.state.reader;
    const page = el('article', 'reader');
    const back = button('', () => ctx.controller.closeReader(), 'reader-back');
    back.append(icon('back'), document.createTextNode('返回列表'));
    back.dataset.focusKey = 'reader-back';
    page.append(back, el('span', 'result-kind', `${cardRenderers[result.entry.type].label} / 离线阅读`));
    const title = el('h2', '', result.entry.title);
    title.tabIndex = -1;
    title.dataset.readerTitle = '';
    page.append(title, el('p', 'summary', result.entry.summary));
    const actions = el('div', 'reader-actions');
    actions.append(el('span', 'pill', ctx.state.context.strictTimeline ? '符合当前世界时间' : '自由查阅'));
    const saved = bookmarked(ctx, result);
    const save = button('', () => ctx.run(ctx.controller.toggleBookmark(result)), 'button small subtle');
    save.append(icon(saved ? 'check' : 'bookmark'), document.createTextNode(saved ? '已收藏' : '收藏这一页'));
    save.setAttribute('aria-pressed', String(saved));
    save.dataset.focusKey = 'reader-save';
    actions.append(save);
    page.append(actions);
    const text = el('div', 'reader-body', content || '此条资料暂无正文。');
    page.append(text, sourceNote(ctx));
    return page;
}
