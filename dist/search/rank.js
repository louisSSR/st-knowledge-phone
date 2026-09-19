import { normalizeText } from '../library/pack.js';
import { isVisible } from './filters.js';
import { parseQuery } from './query.js';
function scoreEntry(entry, document, query, tokens) {
    if (!query)
        return 1;
    if (!tokens.every(token => document.includes(token)))
        return 0;
    const title = normalizeText(entry.title);
    const aliases = entry.aliases.map(normalizeText);
    let score = 1;
    if (title === query || aliases.includes(query))
        score += 100;
    else if (title.startsWith(query) || aliases.some(alias => alias.startsWith(query)))
        score += 50;
    if (title.includes(query))
        score += 20;
    if (normalizeText(entry.summary).includes(query))
        score += 10;
    if (document.includes(query))
        score += 5;
    return score;
}
export function searchCorpus(corpora, request) {
    const { text: query, tokens, ruleOverview } = parseQuery(request.query);
    const results = [];
    const suggestions = new Set();
    for (const corpus of corpora) {
        for (const entry of corpus.entries) {
            if (!isVisible(entry, request.context, request.types))
                continue;
            if (ruleOverview && entry.type !== 'game_rule')
                continue;
            const document = corpus.documents[entry.id];
            if (typeof document !== 'string')
                continue;
            if (ruleOverview && !/(?:扑克牌|扑克|纸牌|撲克牌|撲克|紙牌|card games?)/iu.test([entry.title, ...entry.aliases, ...entry.tags].join(' ')))
                continue;
            const score = scoreEntry(entry, document, query, tokens);
            if (score > 0)
                results.push({ entry, packId: corpus.packId, packName: corpus.packName, score });
            if (ruleOverview || (query && [entry.title, ...entry.aliases].some(title => normalizeText(title).includes(query))))
                suggestions.add(entry.title);
        }
    }
    results.sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title, 'zh-CN') || left.packId.localeCompare(right.packId) || left.entry.id.localeCompare(right.entry.id));
    const offset = Number.isFinite(request.offset) ? Math.max(0, Math.floor(request.offset ?? 0)) : 0;
    const limit = Number.isFinite(request.limit) ? Math.max(1, Math.min(12, Math.floor(request.limit ?? 12))) : 12;
    return { results: results.slice(offset, offset + limit), total: results.length, suggestions: [...suggestions].sort().slice(0, 6) };
}
