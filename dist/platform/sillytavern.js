// Source contract: SillyTavern 1.18.0, commit 8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8.
// See docs/HOST-CONTRACT.md. This adapter never writes host state or sends requests.
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 8000;
const LOBBY_KEY = 'st-knowledge-phone:lobby';
function identifier(value) {
    return (typeof value === 'string' && value.length > 0) ||
        (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}
function identity(context) {
    const chatId = identifier(context.getCurrentChatId());
    if (!chatId)
        return { chatKey: LOBBY_KEY, label: 'SillyTavern · 未选择聊天' };
    const groupId = identifier(context.groupId);
    if (groupId) {
        return { chatKey: JSON.stringify(['sillytavern', 'group', groupId, chatId]), label: 'SillyTavern · 群聊' };
    }
    const characterId = identifier(context.characterId);
    const character = characterId === null ? undefined : context.characters[Number(characterId)];
    const avatar = identifier(character?.avatar);
    // Array positions and display names are not stable character identities.
    if (!avatar)
        return { chatKey: LOBBY_KEY, label: 'SillyTavern · 无可用聊天身份' };
    const name = typeof character?.name === 'string' ? character.name.slice(0, 120) : '角色聊天';
    return { chatKey: JSON.stringify(['sillytavern', 'character', avatar, chatId]), label: `SillyTavern · ${name}` };
}
function textAt(context, floor) {
    const message = context.chat[floor];
    if (typeof message !== 'object' || message === null || !('mes' in message))
        return null;
    const text = message.mes;
    return typeof text === 'string' ? text.slice(0, MAX_MESSAGE_CHARS) : null;
}
function recent(context) {
    const who = identity(context);
    const floors = new Map();
    if (who.chatKey !== LOBBY_KEY) {
        const start = Math.max(0, context.chat.length - MAX_MESSAGES);
        for (let floor = start; floor < context.chat.length; floor++) {
            const text = textAt(context, floor);
            if (text !== null)
                floors.set(floor, text);
        }
    }
    return { snapshot: { ...who, messages: [...floors.values()] }, floors };
}
function hostApi() {
    const api = globalThis.SillyTavern;
    if (typeof api?.getContext !== 'function') {
        throw new Error('掌上知库需要 SillyTavern 宿主；请在酒馆扩展中打开，或单独使用明确标注的本地预览页。');
    }
    const context = api.getContext();
    const requiredEvents = ['CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED'];
    if (!context || !Array.isArray(context.chat) || !Array.isArray(context.characters) ||
        typeof context.getCurrentChatId !== 'function' || typeof context.eventSource?.on !== 'function' ||
        typeof context.eventSource?.removeListener !== 'function' ||
        requiredEvents.some(name => typeof context.eventTypes?.[name] !== 'string')) {
        throw new Error('SillyTavern 宿主缺少必要的只读上下文或事件接口；掌上知库 v0.1 的源码合约基线为 1.18.0。');
    }
    return api;
}
export function createSillyTavernAdapter() {
    const api = hostApi();
    const subscriptions = new Set();
    let disposed = false;
    return {
        label: 'SillyTavern',
        snapshot() {
            if (disposed)
                throw new Error('SillyTavern Adapter 已释放。');
            return recent(api.getContext()).snapshot;
        },
        subscribe(callback) {
            if (disposed)
                throw new Error('SillyTavern Adapter 已释放。');
            const context = api.getContext();
            const source = context.eventSource;
            const types = context.eventTypes;
            const listeners = [];
            let active = true;
            const initial = recent(context);
            let chatKey = initial.snapshot.chatKey;
            let lastSnapshot = JSON.stringify(initial.snapshot);
            let floors = initial.floors;
            let chatLength = context.chat.length;
            const reconcile = (kind, nextContext = api.getContext()) => {
                if (!active)
                    return;
                const next = recent(nextContext);
                const signature = JSON.stringify(next.snapshot);
                const changedChat = chatKey !== next.snapshot.chatKey;
                chatKey = next.snapshot.chatKey;
                floors = next.floors;
                chatLength = nextContext.chat.length;
                if (signature === lastSnapshot)
                    return;
                lastSnapshot = signature;
                callback(changedChat ? 'chat' : kind, next.snapshot);
            };
            const message = (floorValue, generationType) => {
                if (!active)
                    return;
                const nextContext = api.getContext();
                const who = identity(nextContext);
                if (who.chatKey !== chatKey) {
                    reconcile('chat', nextContext);
                    return;
                }
                if (who.chatKey === LOBBY_KEY || typeof floorValue !== 'number' ||
                    !Number.isInteger(floorValue) || floorValue < 0 || floorValue >= nextContext.chat.length)
                    return;
                const text = textAt(nextContext, floorValue);
                if (text === null || floors.get(floorValue) === text)
                    return;
                // Continuations, regenerated swipes and edits replace context, not append it.
                if (floorValue < chatLength || generationType === 'swipe' || generationType === 'continue') {
                    reconcile('reconcile', nextContext);
                    return;
                }
                floors.set(floorValue, text);
                while (floors.size > MAX_MESSAGES)
                    floors.delete(floors.keys().next().value);
                chatLength = nextContext.chat.length;
                // Invalidate the full snapshot after a one-floor update. A later host reload
                // may reconcile it once; repeated copies of the same host event are ignored.
                lastSnapshot = '';
                callback('message', { ...who, messages: [text] });
            };
            const listen = (name, listener) => {
                const type = types[name];
                if (typeof type !== 'string' || listeners.some(([event]) => event === type))
                    return;
                source.on(type, listener);
                listeners.push([type, listener]);
            };
            for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_RENAMED', 'APP_READY']) {
                listen(name, () => reconcile('chat'));
            }
            for (const name of ['MESSAGE_SENT', 'MESSAGE_RECEIVED'])
                listen(name, message);
            // MESSAGE_UPDATED is the final edit event, after MESSAGE_EDITED transforms.
            // MESSAGE_DELETED supplies the remaining length, not a deleted floor.
            for (const name of ['MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_DELETED']) {
                listen(name, () => reconcile('reconcile'));
            }
            const unsubscribe = () => {
                if (!active)
                    return;
                active = false;
                for (const [type, listener] of listeners)
                    source.removeListener(type, listener);
                listeners.length = 0;
                floors.clear();
                lastSnapshot = '';
                subscriptions.delete(unsubscribe);
            };
            subscriptions.add(unsubscribe);
            return unsubscribe;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            for (const unsubscribe of subscriptions)
                unsubscribe();
            subscriptions.clear();
        },
    };
}
