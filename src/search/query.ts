import { normalizeText } from '../library/pack.js';

export interface ParsedQuery { text: string; tokens: string[]; ruleOverview: boolean; }

/** Small deterministic phrase parser; callers retain the original request for history. */
export function parseQuery(input: string): ParsedQuery {
  const original = normalizeText(input.slice(0, 300)).replace(/[?？!！。]+$/u, '').trim();
  const withoutPrefix = original.replace(/^(?:(?:请问|我想知道|想知道|帮我查查|帮我查|查一下|告诉我|了解一下|请)[,，:：\s]*)+/u, '');
  const cleaned = withoutPrefix.replace(/(?:都?有(?:哪些|什么)(?:玩法|规则|种类)|(?:的)?(?:玩法|规则)(?:是什么|有哪些)?|(?:要)?怎么(?:玩|打)|如何(?:玩|打)|介绍(?:一下)?)$/u, '').trim();
  const text = cleaned || withoutPrefix || original;
  const ruleOverview = cleaned !== withoutPrefix && /^(?:扑克牌|扑克|纸牌|打牌|card games?)$/u.test(text);
  return { text: ruleOverview ? '' : text,
    tokens: ruleOverview ? [] : text.split(' ').filter(Boolean).slice(0, 20), ruleOverview };
}
