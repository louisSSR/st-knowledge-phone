import { validDate } from '../context/extractor.js';
import { ZimEngine, ZimTimeoutError } from '../zim/engine.js';
export function archiveDate(fileName) {
    const match = fileName.match(/_(\d{4})-(\d{2})[a-z]?\.zim$/i);
    if (!match)
        return undefined;
    const year = Number(match[1]), month = Number(match[2]);
    if (month < 1 || month > 12)
        return undefined;
    const value = `${match[1]}-${match[2]}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
    return validDate(value) ? value : undefined;
}
export function archiveVisible(archive, context) {
    // A current encyclopedia is not evidence of what was known in a historical scene.
    return !context.strictTimeline || Boolean(archive.date && context.worldDate && validDate(archive.date) && validDate(context.worldDate) && archive.date <= context.worldDate);
}
const normalize = (text) => text.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
export function termQuery(query) {
    return query.trim().replace(/^(?:请问\s*)?(?:什么是|什麼是)?\s*/, '').replace(/[？?。!！]+$/, '').replace(/(?:怎么玩|的规则|是什么意思|是什麼意思|是什么|是什麼|什么意思|的意思)$/, '').trim() || query.trim();
}
export const literalMatch = (text, query) => normalize(text).includes(normalize(query));
export class ZimProvider {
    id = 'zim';
    name = 'ZIM 原文资料库';
    engine = null;
    generation = 0;
    searchEpoch = 0;
    archive = null;
    cache = null;
    async attach(file) {
        const generation = ++this.generation;
        const engine = new ZimEngine();
        try {
            const meta = await engine.open(file);
            if (generation !== this.generation)
                throw new Error('资料库连接已取消。');
            const date = meta.date ?? archiveDate(file.name);
            const archive = { id: `zim:${meta.uuid || `${file.name}:${file.size}`}`, name: file.name.replace(/\.zim$/i, ''),
                fileName: file.name, size: file.size, articleCount: meta.articleCount, connected: true,
                date, dateSource: meta.date ? '库元数据' : date ? '文件名快照月份，按月末保守筛选；未核验逐条历史版本' : undefined };
            this.engine?.close();
            this.engine = engine;
            this.archive = archive;
            this.cache = null;
            return archive;
        }
        catch (error) {
            engine.close();
            throw error;
        }
    }
    cancelSearch() { this.searchEpoch++; this.engine?.cancelSearch(); }
    detach() { this.generation++; this.cancelSearch(); this.engine?.close(); this.engine = null; this.archive = null; this.cache = null; }
    async isAvailable() { return true; }
    connected(id) { return this.archive?.id === id && Boolean(this.engine?.recoverable()); }
    async search(request) {
        this.cancelSearch();
        const epoch = ++this.searchEpoch;
        const empty = { results: [], total: 0, suggestions: [] };
        const archive = this.archive, engine = this.engine;
        if (!archive || !engine || !request.query.trim())
            return empty;
        if (!engine.recoverable())
            throw new Error('当前页面已没有该文件的访问权，请重新选择同一 .zim 文件，无需重新下载。');
        if (!archiveVisible(archive, request.context))
            return { ...empty, notice: '当前世界时间不能使用这份资料库快照。可在设置中切换到现代查阅或关闭严格时间线；这不代表资料是历史版本。' };
        if (request.types?.length && !request.types.includes('article'))
            return { ...empty, notice: 'ZIM 保留来源原有分类，不推断人物/游戏等类型；请选“全部”或“原文词条”。' };
        const query = termQuery(request.query);
        if (!this.cache || this.cache.query !== query) {
            // Useful title results must not wait behind a potentially expensive full-text operation.
            const title = await Promise.allSettled([engine.suggest(query, { limit: 100 })]);
            if (epoch !== this.searchEpoch)
                return empty;
            if (title[0].status === 'rejected' && title[0].reason instanceof ZimTimeoutError)
                throw title[0].reason;
            const titleHits = title[0].status === 'fulfilled' ? title[0].value.filter(hit => literalMatch(hit.title, query)) : [];
            const body = titleHits.length
                ? { status: 'fulfilled', value: [] }
                : (await Promise.allSettled([engine.search(query, { limit: 30 })]))[0];
            const outcomes = [title[0], body];
            if (epoch !== this.searchEpoch)
                return empty;
            if (body.status === 'rejected' && body.reason instanceof ZimTimeoutError)
                throw body.reason;
            if (outcomes.every(item => item.status === 'rejected'))
                throw outcomes[1].reason;
            const rows = new Map();
            for (const [index, outcome] of outcomes.entries()) {
                if (outcome.status !== 'fulfilled')
                    continue;
                for (const hit of outcome.value) {
                    if (this.engine !== engine || epoch !== this.searchEpoch)
                        return empty;
                    let snippet = hit.snippet || '';
                    // Xapian's Chinese tokenization can match unrelated individual characters,
                    // even inside quotes. Never present such candidates as a term match.
                    if (!literalMatch(hit.title, query) && !literalMatch(snippet, query)) {
                        if (index === 0)
                            continue;
                        try {
                            const page = await engine.read(hit.path);
                            if (epoch !== this.searchEpoch)
                                return empty;
                            if (!/^(text\/html|application\/xhtml\+xml)/i.test(page.mimeType) || page.data.byteLength > 2 * 1024 * 1024)
                                continue;
                            const template = document.createElement('template');
                            template.innerHTML = new TextDecoder().decode(page.data);
                            template.content.querySelectorAll('script,style').forEach(node => node.remove());
                            const body = template.content.textContent || '';
                            if (!literalMatch(body, query))
                                continue;
                            // An exact source excerpt, not an authored explanation.
                            const position = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
                            snippet = position >= 0 ? body.slice(Math.max(0, position - 70), position + query.length + 130).replace(/\s+/g, ' ') : '';
                        }
                        catch (error) {
                            if (error instanceof ZimTimeoutError)
                                throw error;
                            continue;
                        }
                    }
                    const exact = normalize(hit.title) === normalize(query);
                    const prefix = normalize(hit.title).startsWith(normalize(query));
                    const score = exact ? 400 : index === 0 ? (prefix ? 300 : 250) : 100;
                    const result = this.result(archive, { ...hit, snippet }, score, exact ? '标题精确匹配' : index === 0 ? '标题索引匹配' : '原文命中片段 · 已核对词语');
                    const old = rows.get(hit.path);
                    if (!old || old.score < score)
                        rows.set(hit.path, result);
                    else if (!old.entry.summary && hit.snippet)
                        old.entry.summary = hit.snippet;
                }
            }
            const warnings = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [index === 1 ? '全文索引不可用，本次仅按标题查找' : '标题索引不可用，本次仅查全文索引'] : []);
            if (titleHits.length)
                warnings.push('本轮展示词条标题匹配；没有标题匹配时才检索正文。');
            if (outcomes[1].status === 'fulfilled' && outcomes[1].value.length === 30)
                warnings.push('已核对前 30 个全文候选；未遍历整库，更多结果可用更具体的词查找');
            const sorted = [...rows.values()].sort((a, b) => b.score - a.score);
            if (sorted.length >= 100)
                warnings.push('当前展示相关性最高的前 100 条，请缩短或细化关键词');
            if (this.engine !== engine)
                return empty;
            this.cache = { query, rows: sorted.slice(0, 100), notice: warnings.join('；') };
        }
        const offset = request.offset ?? 0, limit = request.limit ?? 12;
        return { results: this.cache.rows.slice(offset, offset + limit), total: this.cache.rows.length,
            suggestions: [], notice: this.cache.notice };
    }
    result(archive, hit, score = 0, reason) {
        const entry = { id: hit.path, type: 'article', title: hit.title, aliases: [],
            summary: hit.snippet || '', contentRef: hit.path, tags: [], location: [],
            dates: archive.date ? { knownFrom: archive.date } : { knownFrom: '9999-12-31' },
            source: { name: archive.name, updatedAt: archive.date || '', license: '依原文版权与来源库许可；插件不改写资料', kind: 'offline' },
            metadata: { archive: 'zim', snapshotBasis: archive.dateSource || '快照日期未知' } };
        return { entry, packId: archive.id, packName: archive.name, score, reason };
    }
    resultForPath(path) {
        if (!this.archive)
            throw new Error('请重新选择对应的 ZIM 文件。');
        return this.result(this.archive, { path, title: path.split('/').at(-1)?.replaceAll('_', ' ') || path });
    }
    async read(id, path) {
        if (!this.connected(id))
            throw new Error('此资料库尚未连接。请到知库重新选择同一 .zim 文件，收藏仍然保留。');
        return this.engine.read(path);
    }
}
