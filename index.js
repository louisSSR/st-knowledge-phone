import { init, dispose } from './dist/main.js';

export function onActivate() { init(); }
export function onEnable() { init(); }
export function onDisable() { dispose(); }
export async function onClean() {
  dispose();
  const { clearDatabase } = await import('./dist/library/storage.js');
  await clearDatabase();
}
export function onDelete() { dispose(); }
