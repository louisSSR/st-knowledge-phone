export function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function emptyContext() {
    return { schemaVersion: 1, location: [], recentKeywords: [], updatedAt: 0 };
}
/** Only explicit markers are interpreted. A year in dialogue is not a world clock. */
export function extractContext(messages, previous = emptyContext()) {
    const result = { ...previous, location: [...previous.location], recentKeywords: [...previous.recentKeywords] };
    for (const message of messages.slice(-8)) {
        const text = message.slice(-8000);
        const dates = [...text.matchAll(/(?:世界时间|剧情日期|日期)\s*[:：]\s*(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})日?/g)];
        for (const match of dates) {
            const value = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
            if (validDate(value))
                result.worldDate = value;
        }
        const locations = [...text.matchAll(/(?:地点|位置)\s*[:：]\s*([^\n\r<>\[\]【】]{1,80})/g)];
        if (locations.length)
            result.location = locations.at(-1)[1].split(/[,，、/｜|]/).map(s => s.trim()).filter(Boolean).slice(0, 4);
        const keywords = [...text.matchAll(/(?:话题|关键词|人物)\s*[:：]\s*([^\n\r<>\[\]【】]{1,100})/g)];
        if (keywords.length) {
            result.recentKeywords = [...new Set(keywords.flatMap(m => m[1].split(/[,，、/｜|\s]+/)).filter(Boolean))].slice(0, 12);
        }
    }
    result.updatedAt = Date.now();
    return result;
}
