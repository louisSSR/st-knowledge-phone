/** Historical project fixtures remain removable, but are no longer knowledge sources. */
export function isRetiredPack(id: string): boolean {
  return id === 'knowledge-phone-original-demo' || /^wikipedia-zh-(?:starter|general)-/.test(id);
}
