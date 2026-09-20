import type { ChatSettings, HistoryItem, SearchContext, Settings } from '../core/types.js';
import { emptyContext, validDate } from '../context/extractor.js';

export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function defaultChat(): ChatSettings {
  return { schemaVersion: 1, mode: 'story', customDate: '2008-07-18', location: '', strictTimeline: true, context: emptyContext() };
}
export function normalizeSettings(value?: Settings): Settings {
  return { schemaVersion: 1, theme: typeof value?.theme === 'string' ? value.theme : 'midnight', sourceMode: value?.sourceMode === 'offline' ? 'offline' : 'online' };
}
export function normalizeChat(value?: ChatSettings): ChatSettings {
  if (!value || value.schemaVersion !== 1) return defaultChat();
  const base = defaultChat();
  return { ...base, ...value, schemaVersion: 1,
    mode: ['story', 'custom', 'modern'].includes(value.mode) ? value.mode : base.mode,
    customDate: validDate(value.customDate) ? value.customDate : base.customDate,
    strictTimeline: value.strictTimeline !== false,
    location: typeof value.location === 'string' ? value.location.slice(0, 100) : '',
    context: { ...emptyContext(), ...value.context, schemaVersion: 1 },
  };
}
export function searchContext(chat: ChatSettings, chatKey: string): SearchContext {
  return {
    worldDate: chat.mode === 'custom' ? chat.customDate : chat.mode === 'modern' ? localToday() : chat.context.worldDate ?? null,
    location: chat.location.trim() ? chat.location.split(/[,，、/]/).map(s => s.trim()).filter(Boolean) : chat.context.location,
    strictTimeline: chat.strictTimeline, chatKey,
  };
}
export function worldline(context: SearchContext): string {
  return JSON.stringify([context.chatKey, context.worldDate, context.strictTimeline, [...context.location].sort()]);
}
export function visibleHistory(history: HistoryItem[], context: SearchContext): HistoryItem[] {
  return history.filter(row => row.schemaVersion === 1 && row.worldline === worldline(context)).slice(0, 100);
}
export const chatStorageKey = (chatKey: string, part = 'settings'): string => `chat:${encodeURIComponent(chatKey)}:${part}`;
