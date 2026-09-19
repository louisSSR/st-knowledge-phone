export class SearchService {
    providers;
    constructor(providers) {
        this.providers = providers;
    }
    async search(request) {
        const outcomes = await Promise.allSettled(this.providers.map(async (provider) => {
            if (!(await provider.isAvailable()))
                throw new Error(`${provider.name} 当前不可用`);
            return provider.search(request);
        }));
        const replies = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
        if (!replies.length && outcomes.length) {
            const failed = outcomes.find(outcome => outcome.status === 'rejected');
            throw failed.reason;
        }
        const results = replies.flatMap(reply => reply.results).sort((left, right) => right.score - left.score);
        const unique = new Map(results.map(result => [`${result.packId}\0${result.entry.id}`, result]));
        return { results: [...unique.values()].slice(0, Math.min(12, Math.max(1, request.limit ?? 12))),
            total: replies.reduce((total, reply) => total + reply.total, 0),
            suggestions: [...new Set(replies.flatMap(reply => reply.suggestions))].slice(0, 6) };
    }
}
