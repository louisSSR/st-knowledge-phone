import { init, dispose } from './main.js';
const snapshots = {
    'demo-2008': { chatKey: 'preview/2008', label: '独立预览 · 东京 2008', messages: ['世界时间：2008-07-18\n地点：日本/东京/涩谷\n话题：扑克牌、秋装'] },
    'demo-2025': { chatKey: 'preview/2025', label: '独立预览 · 2025', messages: ['世界时间：2025-09-19\n话题：未来、游戏'] },
    'demo-empty': { chatKey: 'preview/unknown', label: '独立预览 · 未识别时间', messages: ['今天我们来玩一局纸牌。'] },
};
let selected = 'demo-2008';
const listeners = new Set();
const host = {
    label: '独立预览（未连接酒馆）', snapshot: () => snapshots[selected],
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    dispose() { listeners.clear(); },
};
document.querySelector('#preview-chat')?.addEventListener('change', event => {
    selected = event.target.value;
    for (const callback of listeners)
        callback('chat', snapshots[selected]);
});
document.querySelector('#preview-reset')?.addEventListener('click', () => { dispose(); init(host); });
init(host);
