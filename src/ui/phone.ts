import type { EntryType, PhoneController, PhoneState } from '../core/types.js';
import { themeCSS } from '../themes/manager.js';
import { el, button, icon, iconButton } from './dom.js';
import { homeView } from './home.js';
import { historyView } from './history.js';
import { libraryView } from './library.js';
import { bookmarksView, searchView } from './results.js';
import { readerView } from './reader.js';
import { settingsView } from './settings.js';
import { styles } from './styles.js';
import type { ViewContext } from './view-types.js';
import { captureDraft, captureFocus, restoreDraft, restoreFocus } from './focus.js';

const navigation: [Exclude<PhoneState['page'], 'home'>, string, string][] = [
  ['search', '搜索', 'search'], ['library', '知库', 'library'], ['bookmarks', '收藏', 'bookmark'],
  ['history', '历史', 'history'], ['settings', '设置', 'settings'],
];
const views: Record<PhoneState['page'], (ctx: ViewContext) => HTMLElement> = {
  home: homeView, search: searchView, library: libraryView, bookmarks: bookmarksView,
  history: historyView, settings: settingsView,
};
const focusable = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]';

function topbar(controller: PhoneController, run: (task: Promise<unknown>) => void, close: () => void): HTMLElement {
  const header = el('header', 'topbar');
  const mark = el('div', 'brand-mark');
  mark.append(icon('book'));
  const brand = button('', () => run(controller.navigate('home')), 'brand');
  brand.setAttribute('aria-label', '掌上知库，返回首页');
  const title = el('h1', '', '掌上知库');
  title.id = 'kp-title';
  brand.append(title, el('small', '', 'KNOWLEDGE, WITHIN REACH'));
  header.append(mark, brand, iconButton('关闭掌上知库', 'close', close));
  return header;
}

export function mountPhone(shadow: ShadowRoot, controller: PhoneController, onClose: () => void): { dispose(): void } {
  const previousFocus = document.activeElement as HTMLElement | null;
  const sheet = el('style');
  sheet.textContent = styles;
  const theme = el('style');
  const backdrop = el('div', 'backdrop');
  const phone = el('section', 'phone');
  phone.setAttribute('role', 'dialog');
  phone.setAttribute('aria-modal', 'true');
  phone.setAttribute('aria-labelledby', 'kp-title');
  phone.tabIndex = -1;
  const notice = el('div', 'notice');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const content = el('main', 'content');
  const nav = el('nav', 'bottom-nav');
  nav.setAttribute('aria-label', '终端导航');
  let offset = 0;
  let oldView = '';
  let disposed = false;
  let lastQuery = '';
  let renderedQuery = '';
  let renderedChat = '';
  let localError = '';
  let composing = false;
  let pendingState: PhoneState | null = null;
  let readerOrigin: { focus: ReturnType<typeof captureFocus>; scroll: number; page: PhoneState['page'] } | null = null;
  let resetScroll = false;
  let activeReader: ReturnType<typeof readerView> | null = null;
  let activeReaderContent = '';
  let activeReaderPath: string | undefined;
  let activeReaderHash: string | undefined;
  const run = (task: Promise<unknown>): void => {
    localError = '';
    task.catch(error => {
      if (disposed) return;
      localError = error instanceof Error ? error.message : '操作未完成，请重试。';
      notice.textContent = localError;
      notice.className = 'notice error';
    });
  };
  const search = (query: string, types?: EntryType[], nextOffset = 0): void => {
    offset = nextOffset;
    resetScroll = true;
    lastQuery = query;
    run(controller.search(query, types, nextOffset));
  };
  const navigate = (page: PhoneState['page'], nextOffset = 0): void => {
    offset = nextOffset;
    resetScroll = true;
    run(controller.navigate(page, nextOffset));
  };
  phone.append(topbar(controller, run, onClose), notice, content, nav);
  backdrop.append(phone);
  shadow.append(sheet, theme, backdrop);
  const render = (state: PhoneState): void => {
    if (disposed) return;
    if (composing) { pendingState = state; return; }
    const focus = captureFocus(shadow);
    const draft = captureDraft(content);
    if (state.query !== lastQuery) { offset = 0; lastQuery = state.query; }
    const viewKey = state.reader ? `reader:${state.reader.result.packId}:${state.reader.result.entry.id}` : state.page;
    const changedView = viewKey !== oldView;
    const returning = !state.reader && oldView.startsWith('reader:') && readerOrigin?.page === state.page;
    if (state.reader && !oldView.startsWith('reader:')) readerOrigin = { focus, scroll: content.scrollTop, page: state.page };
    const scroll = returning ? readerOrigin!.scroll : changedView || resetScroll ? 0 : content.scrollTop;
    resetScroll = false;
    theme.textContent = themeCSS(state.settings.theme);
    notice.className = `notice${localError ? ' error' : ''}`;
    notice.textContent = localError || state.notice;
    content.setAttribute('aria-busy', String(state.busy || !state.ready));
    const ctx: ViewContext = { state, controller, offset, run, search, navigate };
    const preserveReader = Boolean(activeReader && state.reader?.format === 'html' && !changedView
      && state.chatKey === renderedChat && state.reader.content === activeReaderContent && state.reader.path === activeReaderPath && state.reader.hash === activeReaderHash);
    if (preserveReader) activeReader!.update(ctx);
    else {
      activeReader?.dispose(); activeReader = null;
      content.replaceChildren();
      if (state.busy || !state.ready) content.append(el('div', 'loading', state.ready ? '正在整理资料…' : '正在打开你的书架…'));
      if (state.reader) {
        activeReader = readerView(ctx);
        activeReaderContent = state.reader.content;
        activeReaderPath = state.reader.path;
        activeReaderHash = state.reader.hash;
        content.append(activeReader.element);
      } else content.append(views[state.page](ctx));
    }
    renderNavigation(nav, state, controller, run, () => { offset = 0; });
    if (!changedView && state.chatKey === renderedChat) restoreDraft(content, draft, state.query !== renderedQuery);
    content.scrollTop = scroll;
    if (returning && restoreFocus(shadow, readerOrigin!.focus)) {
      readerOrigin = null;
    } else if (changedView && oldView) {
      const target = state.reader ? content.querySelector<HTMLElement>('[data-reader-title]') : content.querySelector<HTMLElement>('input, h2');
      if (target) { if (!target.matches('input')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
    } else restoreFocus(shadow, focus);
    oldView = viewKey;
    renderedQuery = state.query;
    renderedChat = state.chatKey;
  };
  const keydown = (event: Event): void => handleKeyboard(event as KeyboardEvent, shadow, controller, onClose);
  const isolate = (event: Event): void => event.stopPropagation();
  shadow.addEventListener('keydown', keydown);
  shadow.addEventListener('keyup', isolate);
  shadow.addEventListener('keypress', isolate);
  const compositionStart = (): void => { composing = true; };
  const compositionEnd = (): void => {
    composing = false;
    if (pendingState) {
      const state = pendingState; pendingState = null;
      queueMicrotask(() => render(state));
    }
  };
  shadow.addEventListener('compositionstart', compositionStart);
  shadow.addEventListener('compositionend', compositionEnd);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) onClose(); });
  const unsubscribe = controller.subscribe(render);
  render(controller.getState());
  phone.focus({ preventScroll: true });
  return { dispose(): void {
    disposed = true;
    unsubscribe();
    activeReader?.dispose(); activeReader = null;
    shadow.removeEventListener('keydown', keydown);
    shadow.removeEventListener('keyup', isolate);
    shadow.removeEventListener('keypress', isolate);
    shadow.removeEventListener('compositionstart', compositionStart);
    shadow.removeEventListener('compositionend', compositionEnd);
    backdrop.remove(); sheet.remove(); theme.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  } };
}

function renderNavigation(nav: HTMLElement, state: PhoneState, controller: PhoneController, run: (task: Promise<unknown>) => void, resetOffset: () => void): void {
  nav.replaceChildren();
  navigation.forEach(([page, label, glyph]) => {
    const item = button('', () => { resetOffset(); run(controller.navigate(page)); }, 'nav-item');
    item.dataset.focusKey = `nav:${page}`;
    if (state.page === page) item.setAttribute('aria-current', 'page');
    item.append(icon(glyph), el('span', '', label));
    nav.append(item);
  });
}

function handleKeyboard(event: KeyboardEvent, shadow: ShadowRoot, controller: PhoneController, onClose: () => void): void {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    if (controller.getState().reader) controller.closeReader();
    else onClose();
  }
  if (event.key !== 'Tab') return;
  const nodes = [...shadow.querySelectorAll<HTMLElement>(focusable)].filter(node => node.getClientRects().length > 0);
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (!first || !last) { event.preventDefault(); return; }
  const active = shadow.activeElement;
  if (event.shiftKey && (active === first || !nodes.includes(active as HTMLElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (active === last || !nodes.includes(active as HTMLElement))) {
    event.preventDefault(); first.focus();
  }
}
