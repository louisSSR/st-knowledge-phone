import type { EntryType, KnowledgeEntry, SearchContext } from '../core/types.js';
import { isDate, normalizeText } from '../library/pack.js';

function locationMatches(entry: string[], requested: string[]): boolean {
  if (entry.length === 0 || requested.length === 0) return true;
  // Locations are ordered paths: a region includes its descendants; an empty path is global.
  const length = Math.min(entry.length, requested.length);
  for (let index = 0; index < length; index++) {
    if (normalizeText(entry[index]) !== normalizeText(requested[index])) return false;
  }
  return true;
}

export function isVisible(entry: KnowledgeEntry, context: SearchContext, types?: EntryType[]): boolean {
  if (types?.length && !types.includes(entry.type)) return false;
  if (!locationMatches(entry.location, context.location)) return false;
  if (!context.strictTimeline) return true;
  const dates = entry.dates;
  const hasDates = Object.values(dates).some(Boolean);
  if (!hasDates) return true;
  if (!context.worldDate || !isDate(context.worldDate) || !dates.knownFrom) return false;
  if (dates.knownFrom > context.worldDate) return false;
  if (dates.publishedAt && dates.publishedAt > context.worldDate) return false;
  if (dates.validFrom && dates.validFrom > context.worldDate) return false;
  if (dates.validUntil && dates.validUntil < context.worldDate) return false;
  // occurredAt is deliberately not substituted for knowledge/publication time.
  return true;
}
