import test from 'node:test';
import assert from 'node:assert/strict';
import { createSillyTavernAdapter } from '../dist/platform/sillytavern.js';

function fixture(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'SillyTavern');
  t.after(() => previous ? Object.defineProperty(globalThis, 'SillyTavern', previous) : delete globalThis.SillyTavern);
  const handlers = new Map();
  const names = ['CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_RENAMED', 'APP_READY', 'MESSAGE_SENT', 'MESSAGE_RECEIVED',
    'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED'];
  const eventTypes = Object.fromEntries(names.map(name => [name, name.toLowerCase()]));
  let chatId = 'same-chat';
  let reads = 0;
  const message = text => ({ get mes() { reads++; return text; } });
  const context = {
    chat: [message('开始聊天')], characters: [{ name: 'Same', avatar: 'a.png' }, { name: 'Same', avatar: 'b.png' }],
    characterId: 0, groupId: undefined, getCurrentChatId: () => chatId, eventTypes,
    get chatMetadata() { throw new Error('must not inspect metadata'); },
    get accountStorage() { throw new Error('must not inspect unrelated account state'); },
    eventSource: {
      on(type, fn) { const listeners = handlers.get(type) ?? new Set(); listeners.add(fn); handlers.set(type, listeners); },
      removeListener(type, fn) { handlers.get(type)?.delete(fn); },
    },
  };
  globalThis.SillyTavern = { getContext: () => context };
  return {
    context, message, setChatId(value) { chatId = value; },
    readCount() { return reads; }, resetReads() { reads = 0; },
    listenerCount() { return [...handlers.values()].reduce((count, listeners) => count + listeners.size, 0); },
    emit(name, ...args) { for (const fn of handlers.get(eventTypes[name]) ?? []) fn(...args); },
  };
}

test('missing host and missing required APIs fail explicitly instead of using preview data', t => {
  const host = fixture(t);
  delete globalThis.SillyTavern;
  assert.throws(() => createSillyTavernAdapter(), /需要 SillyTavern/);
  globalThis.SillyTavern = { getContext: () => host.context };
  delete host.context.eventTypes.MESSAGE_UPDATED;
  assert.throws(() => createSillyTavernAdapter(), /缺少必要/);
});

test('snapshot reads only the last eight messages and truncates each to 8000 characters', t => {
  const host = fixture(t);
  host.context.chat = Array.from({ length: 20 }, (_, index) => host.message(String(index).padEnd(10000, 'x')));
  const adapter = createSillyTavernAdapter();
  t.after(() => adapter.dispose());
  const snapshot = adapter.snapshot();
  assert.equal(host.readCount(), 8);
  assert.equal(snapshot.messages.length, 8);
  assert.ok(snapshot.messages[0].startsWith('12'));
  assert.ok(snapshot.messages.every(text => text.length === 8000));
});

test('same-name chats on different characters and group chats use distinct identities', t => {
  const host = fixture(t);
  const adapter = createSillyTavernAdapter();
  t.after(() => adapter.dispose());
  const first = adapter.snapshot().chatKey;
  host.context.characterId = 1;
  const second = adapter.snapshot().chatKey;
  host.context.groupId = '1';
  const group = adapter.snapshot().chatKey;
  assert.equal(new Set([first, second, group]).size, 3);
  host.setChatId(undefined);
  host.resetReads();
  const lobby = adapter.snapshot();
  assert.deepEqual(lobby.messages, []);
  assert.equal(host.readCount(), 0);
  assert.notEqual(lobby.chatKey, first);
  host.setChatId('same-chat');
  host.context.groupId = undefined;
  host.context.characters[1].avatar = undefined;
  assert.deepEqual(adapter.snapshot().messages, []);
});

test('new-message events read one floor, reject invalid payloads and suppress duplicate content', t => {
  const host = fixture(t);
  const adapter = createSillyTavernAdapter();
  t.after(() => adapter.dispose());
  const changes = [];
  adapter.subscribe((kind, snapshot) => changes.push({ kind, snapshot }));
  host.context.chat.push(host.message('世界时间：2022-01-01'));
  host.resetReads();
  host.emit('MESSAGE_RECEIVED', 1, 'normal');
  assert.equal(host.readCount(), 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'message');
  assert.deepEqual(changes[0].snapshot.messages, ['世界时间：2022-01-01']);
  host.emit('MESSAGE_RECEIVED', 1, 'normal');
  host.emit('MESSAGE_SENT', 1);
  for (const invalid of [-1, 0.5, 99, '1', null, {}]) host.emit('MESSAGE_SENT', invalid);
  assert.equal(changes.length, 1);
});

test('edits, swipes and deletion reconcile current bounded content; repeated chat loads are ignored', t => {
  const host = fixture(t);
  const adapter = createSillyTavernAdapter();
  t.after(() => adapter.dispose());
  const changes = [];
  adapter.subscribe((kind, snapshot) => changes.push({ kind, snapshot }));
  host.emit('CHAT_LOADED', { detail: { character: 'payload is not read' } });
  assert.equal(changes.length, 0);
  host.context.chat[0] = host.message('世界时间：2023-01-01');
  host.emit('MESSAGE_UPDATED', 0);
  assert.equal(changes.at(-1).kind, 'reconcile');
  assert.deepEqual(changes.at(-1).snapshot.messages, ['世界时间：2023-01-01']);
  const countAfterEdit = changes.length;
  host.emit('MESSAGE_SWIPED', 0);
  host.emit('MESSAGE_SWIPE_DELETED', { messageId: 0, swipeId: 1, newSwipeId: 0 });
  assert.equal(changes.length, countAfterEdit);
  host.context.chat[0] = host.message('另一页没有时间标注');
  host.emit('MESSAGE_SWIPED', 0);
  assert.deepEqual(changes.at(-1).snapshot.messages, ['另一页没有时间标注']);
  host.context.chat.length = 0;
  host.emit('MESSAGE_DELETED', 0);
  assert.deepEqual(changes.at(-1).snapshot.messages, []);
  host.context.characterId = 1;
  host.emit('CHAT_CHANGED', 'same-chat');
  assert.equal(changes.at(-1).kind, 'chat');
  const countAfterChat = changes.length;
  host.emit('CHAT_LOADED');
  assert.equal(changes.length, countAfterChat);
});

test('unsubscribe and dispose remove exactly their listeners and are idempotent', t => {
  const host = fixture(t);
  const adapter = createSillyTavernAdapter();
  let firstCalls = 0;
  let secondCalls = 0;
  const stop = adapter.subscribe(() => firstCalls++);
  const secondStop = adapter.subscribe(() => secondCalls++);
  assert.equal(host.listenerCount(), 20);
  stop(); stop();
  assert.equal(host.listenerCount(), 10);
  host.context.chat.push(host.message('新消息'));
  host.emit('MESSAGE_SENT', 1);
  assert.equal(firstCalls, 0);
  assert.equal(secondCalls, 1);
  adapter.dispose(); adapter.dispose(); secondStop();
  assert.equal(host.listenerCount(), 0);
  assert.throws(() => adapter.snapshot(), /已释放/);
  assert.throws(() => adapter.subscribe(() => {}), /已释放/);
});
