import { init, dispose } from './dist/main.js';

export function onActivate() { init(); }
export function onEnable() { init(); }
export function onDisable() { dispose(); }
export function onClean() { dispose(); }
export function onDelete() { dispose(); }
