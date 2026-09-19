import { createSillyTavernAdapter } from './platform/sillytavern.js';
const ROOT_ID = 'st-knowledge-phone-root';
let cleanup;
/** The entry only mounts a launcher; asynchronous features load on explicit open. */
export function init(host = createSillyTavernAdapter()) {
    cleanup?.();
    const existing = document.getElementById(ROOT_ID);
    if (existing)
        return;
    const root = document.createElement('div');
    root.id = ROOT_ID;
    const shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial;position:fixed;right:18px;bottom:24px;z-index:2147483000;font-family:system-ui,sans-serif}.launcher{display:flex;align-items:center;gap:8px;padding:13px 18px;border:1px solid #a695b4;border-radius:18px;background:#211b30;color:#f2e5cc;box-shadow:0 8px 24px #0005;cursor:pointer;font:600 14px system-ui}.launcher:focus-visible{outline:3px solid #dfc49b;outline-offset:3px}.launcher:disabled{opacity:.6}.launcher[hidden]{display:none}.error{max-width:270px;padding:12px;background:#211b30;color:#ffd4c7;font:14px system-ui;border-radius:12px}';
    const launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.type = 'button';
    launcher.textContent = '▣ 掌上知库';
    launcher.setAttribute('aria-label', '打开掌上知库');
    const surface = document.createElement('div');
    shadow.append(style, launcher, surface);
    document.body.append(root);
    let controller;
    let ui;
    let closed = false;
    let opening = false;
    const close = () => {
        ui?.dispose();
        ui = undefined;
        controller?.pause();
        surface.replaceChildren();
        launcher.hidden = false;
        launcher.focus();
    };
    const open = async () => {
        if (opening || ui || closed)
            return;
        opening = true;
        launcher.disabled = true;
        try {
            const [{ Controller }, { mountPhone }] = await Promise.all([import('./controller.js'), import('./ui/phone.js')]);
            if (closed)
                return;
            controller ??= new Controller(host);
            launcher.hidden = true;
            const panel = document.createElement('div');
            surface.replaceChildren(panel);
            ui = mountPhone(panel.attachShadow({ mode: 'open' }), controller, close);
            await controller.start();
        }
        catch (error) {
            const notice = document.createElement('p');
            notice.className = 'error';
            notice.textContent = error instanceof Error ? error.message : '掌上知库暂时无法打开。';
            surface.replaceChildren(notice);
            launcher.hidden = false;
        }
        finally {
            opening = false;
            launcher.disabled = false;
        }
    };
    launcher.addEventListener('click', open);
    const pagehide = () => dispose();
    window.addEventListener('pagehide', pagehide, { once: true });
    cleanup = () => {
        closed = true;
        ui?.dispose();
        controller?.dispose();
        if (!controller)
            host.dispose();
        launcher.removeEventListener('click', open);
        window.removeEventListener('pagehide', pagehide);
        root.remove();
    };
}
export function dispose() { const stop = cleanup; cleanup = undefined; stop?.(); }
