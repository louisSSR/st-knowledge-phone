import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContext, validDate } from '../dist/context/extractor.js';
import { chatStorageKey, defaultChat, searchContext, visibleHistory, worldline } from '../dist/settings/settings.js';

test('explicit story date/location are incremental and do not guess dialogue years', () => {
  const initial = extractContext(['世界时间：2008年7月18日\n地点：日本/东京/涩谷\n话题：纸牌、秋装']);
  assert.equal(initial.worldDate, '2008-07-18');
  assert.deepEqual(initial.location, ['日本', '东京', '涩谷']);
  const later = extractContext(['我看了一本关于2025年的小说。'], initial);
  assert.equal(later.worldDate, '2008-07-18');
  assert.ok(!JSON.stringify(later).includes('小说'));
  assert.equal(extractContext(['日期：2008-02-30'], initial).worldDate, '2008-07-18');
});
test('date validator rejects rolled-over days and timestamps', () => {
  assert.equal(validDate('2008-02-29'), true); assert.equal(validDate('2009-02-29'), false);
  assert.equal(validDate('2008-7-18'), false); assert.equal(validDate('2008-07-18T00:00:00'), false);
});
test('context reads at most the last eight bounded messages', () => {
  const context = extractContext(['日期：2025-01-01', ...Array(8).fill('过去十年的故事')]);
  assert.equal(context.worldDate, undefined);
});
test('date, place, strict mode and chat identity isolate history', () => {
  const chat = defaultChat(); chat.mode = 'custom';
  const first = searchContext(chat, 'character-a/chat');
  const row = { schemaVersion: 1, worldline: worldline(first), query: 'test' };
  assert.equal(visibleHistory([row], first).length, 1);
  for (const changed of [{ ...first, chatKey: 'character-b/chat' }, { ...first, worldDate: '2025-01-01' }, { ...first, strictTimeline: false }, { ...first, location: ['东京'] }]) {
    assert.equal(visibleHistory([row], changed).length, 0);
  }
  assert.notEqual(chatStorageKey('a:b'), chatStorageKey('a', 'b:settings'));
});
