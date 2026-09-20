import type { ViewContext } from './view-types.js';
import { el } from './dom.js';

const MAX_HTML_CHARACTERS = 8 * 1024 * 1024;
const MAX_RESOURCES = 54;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CSS_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const ROOT = 'https://archive.invalid/';
const WIKIPEDIA = 'https://zh.wikipedia.org';
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const TAGS = new Set('a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr math mrow mi mn mo ms mtext mspace msup msub msubsup mfrac msqrt mroot mfenced mtable mtr mtd mover munder munderover semantics annotation mstyle mpadded mphantom menclose mmultiscripts mprescripts none mlabeledtr mlongdiv mscarries mscarry msgroup msline msrow mstack'.split(' '));
const ATTRIBUTES = new Set('id class title lang dir alt width height colspan rowspan scope headers open close datetime start reversed value align name aria-label aria-hidden aria-describedby role display mathvariant stretchy fence separator separators accent accentunder columnalign rowalign columnspan rowspacing columnspacing rowlines columnlines scriptlevel displaystyle mathcolor mathbackground mathsize notation bevelled linethickness minsize maxsize voffset depth lspace rspace encoding'.split(' '));
const READER_CSS = `
html{color-scheme:light!important;background:#fcfcfb!important;overflow-wrap:anywhere;scroll-behavior:auto!important}
body{margin:0!important;padding:14px 12px 24px!important;background:#fcfcfb!important;color:#242726!important;font:16px/1.85 system-ui,-apple-system,"Noto Sans SC",sans-serif!important;max-width:100%!important;box-sizing:border-box}
*,*::before,*::after{box-sizing:border-box;animation:none!important;transition:none!important}
h1,h2,h3,h4,h5,h6{line-height:1.4;overflow-wrap:anywhere}h1{font-size:1.65em}h2{font-size:1.4em}h3{font-size:1.17em}
p,ul,ol,dl,blockquote,figure,pre{max-width:100%}figure{margin:16px 0}img{max-width:100%!important;height:auto!important;object-fit:contain}a{color:#2458a2;text-decoration:underline;cursor:pointer}a[data-kp-external]::after{content:" ↗";font-size:.8em}
table{border-collapse:collapse;max-width:100%}th,td{padding:7px;border:1px solid #d4d7d5;text-align:start}th{background:#eef0ed}.kp-table-scroll{max-width:100%;overflow-x:auto;margin:15px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:#f0f1ee}blockquote{margin:16px 0;padding:3px 14px;border-inline-start:3px solid #bfc9c5}sup,sub{line-height:0}hr{border:0;border-top:1px solid #d4d7d5;margin:22px 0}
.kp-image-unavailable{display:block;font:12px/1.6 system-ui;color:#666;padding:7px;background:#f0f1ee}button,input,select,textarea,form{display:none!important}
.mwe-math-mathml-a11y{clip:auto!important;clip-path:none!important;position:static!important;height:auto!important;width:auto!important;margin:0!important;overflow:visible!important;display:inline!important;opacity:1!important;visibility:visible!important}
math{max-width:100%;overflow-x:auto;visibility:visible!important;opacity:1!important}math[display="block"]{display:block!important}
`;

interface Location { path?: string; hash: string; external?: string; }

/** Resolve only archive-relative paths or explicit HTTPS destinations. */
function archiveLocation(raw: string, path: string): Location | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value, new URL(path.replace(/^\/+/, ''), ROOT));
    if (url.origin !== new URL(ROOT).origin) {
      return url.protocol === 'https:' && !url.username && !url.password ? { external: url.href, hash: '' } : null;
    }
    if (url.search) return null;
    const result = decodeURIComponent(url.pathname.slice(1));
    if (!result || result.includes('\0')) return null;
    return { path: result, hash: url.hash };
  } catch { return null; }
}

function wikipediaPath(path: string): string {
  const value = path.startsWith('/wiki/') ? path : `/wiki/${encodeURIComponent(path.replace(/^\.?\//, ''))}`;
  return new URL(value, WIKIPEDIA).pathname;
}

/** Only the public article path stays inside the reader; other destinations remain explicit links. */
function wikipediaLocation(raw: string, path: string): Location | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value, new URL(wikipediaPath(path), WIKIPEDIA));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.origin === WIKIPEDIA && url.pathname.startsWith('/wiki/') && !url.search) {
      return { path: url.pathname, hash: url.hash };
    }
    return { external: url.href, hash: '' };
  } catch { return null; }
}

function cssUnescape(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex: string | undefined, escaped: string | undefined) => {
    const code = hex ? parseInt(hex, 16) : 0;
    return hex ? code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '' : escaped ?? '';
  });
}

function safeDeclarations(style: CSSStyleDeclaration): string {
  const values: string[] = [];
  for (let index = 0; index < style.length; index++) {
    const property = style.item(index);
    const value = style.getPropertyValue(property);
    const normalized = cssUnescape(value).replace(/\/\*[\s\S]*?\*\//g, '');
    // No CSS resource lookup, dynamic value, binding, or generated image is needed
    // for the preserved document layout. Images are loaded explicitly below.
    if (/url\s*\(|image-set\s*\(|image\s*\(|paint\s*\(|expression\s*\(|(?:https?|data|blob|javascript):|\/\//i.test(normalized)
      || /behavior|binding|animation|transition/i.test(property) || property.startsWith('--')) continue;
    values.push(`${property}:${value}${style.getPropertyPriority(property) ? '!important' : ''}`);
  }
  return values.join(';');
}

function safeCSS(text: string): string {
  if (text.length > MAX_CSS_BYTES) return '';
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    function rules(input: CSSRuleList, depth = 0): string {
      if (depth > 4) return '';
      return [...input].map(rule => {
        if (rule.type === CSSRule.STYLE_RULE) {
          const item = rule as CSSStyleRule;
          return `${item.selectorText}{${safeDeclarations(item.style)}}`;
        }
        if (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE) {
          const group = rule as CSSGroupingRule & { conditionText: string };
          const condition = cssUnescape(group.conditionText);
          if (/url\s*\(|https?:|[{}]/i.test(condition)) return '';
          return `@${rule.type === CSSRule.MEDIA_RULE ? 'media' : 'supports'} ${group.conditionText}{${rules(group.cssRules, depth + 1)}}`;
        }
        return ''; // @import, fonts, keyframes, namespace and page rules are omitted.
      }).join('\n');
    }
    return rules(sheet.cssRules);
  } catch { return ''; }
}

export function createArchiveReader(ctx: ViewContext): { element: HTMLElement; dispose(): void } {
  const reader = ctx.state.reader!;
  const packId = reader.result.packId;
  const online = reader.result.entry.source.kind !== 'offline';
  const rawPath = reader.path ?? String(reader.result.entry.metadata.archivePath ?? reader.result.entry.title);
  const currentPath = online ? wikipediaPath(rawPath) : rawPath;
  const locate = (raw: string): Location | null => online ? wikipediaLocation(raw, currentPath) : archiveLocation(raw, currentPath);
  const element = el('section', 'archive-reader');
  const policy = el('p', 'settings-caption', online
    ? `${reader.result.entry.source.kind === 'cache' ? '正在阅读本机已读缓存。' : '正在阅读来源百科正文。'}文中百科链接可继续查词；点击未缓存词条时需要联网。图片和外部资源不自动加载，原页面脚本与互动组件已停用。`
    : '正在读取本地知识库原文。原页面的脚本、表单和互动组件已停用；外部链接会明确打开新网页。');
  const status = el('p', 'settings-caption');
  status.setAttribute('role', 'status');
  element.append(policy, status);
  let disposed = false;
  const urls = new Set<string>();
  let observer: ResizeObserver | null = null;
  let frameId = 0;
  let hashFrameId = 0;
  let cleanupDocument = (): void => {};
  const iframe = el('iframe');
  iframe.title = `${reader.result.entry.title} · 来源原文`;
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.cssText = 'display:block;width:100%;height:480px;min-height:320px;border:1px solid #d4d7d5;border-radius:10px;background:#fcfcfb;';
  let images = 0, loadedImages = 0, failedImages = 0, omittedImages = 0, skippedStyles = 0, mathCount = 0;
  const jobs: Array<{ kind: 'image' | 'css'; path: string; key?: string }> = [];
  function updateStatus(): void {
    if (disposed) return;
    const notes = [images ? online ? `本页 ${images} 张图片未联网加载` : `本页图片：已读取 ${loadedImages} / ${images}` : '本页原文未提供可读取的图片引用。'];
    if (failedImages) notes.push(`${failedImages} 张图片未能从本地知识库读取`);
    if (omittedImages && !online) notes.push(`${omittedImages} 张图片因外部来源或资源限额未加载`);
    if (skippedStyles) notes.push(`${skippedStyles} 份样式未加载，已使用阅读排版`);
    if (mathCount) notes.push(`${mathCount} 个公式使用原文 MathML 呈现，图像回退不重复加载`);
    status.textContent = notes.join(' · ');
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    cancelAnimationFrame(frameId);
    cancelAnimationFrame(hashFrameId);
    cleanupDocument();
    iframe.removeEventListener('load', loaded);
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    iframe.remove();
  }
  if (reader.content.length > MAX_HTML_CHARACTERS) {
    status.textContent = '本页原文超过当前阅读器的安全大小上限，未截断或改写正文。';
    return { element, dispose };
  }
  // A template keeps parser-created resources inert until they have been checked.
  const template = document.createElement('template');
  template.innerHTML = reader.content;
  const inlineCSS: string[] = [];
  for (const style of [...template.content.querySelectorAll('style')].slice(0, 6)) inlineCSS.push(safeCSS(style.textContent ?? ''));
  for (const link of [...template.content.querySelectorAll('link[rel~="stylesheet"]')].slice(0, 6)) {
    const location = locate(link.getAttribute('href') ?? '');
    if (!online && location?.path) jobs.push({ kind: 'css', path: location.path });
    else skippedStyles++;
  }
  template.content.querySelectorAll('script,style,link,base,meta,title,iframe,frame,frameset,object,embed,applet,portal,template,noscript,svg,canvas,audio,video,source,track,input,button,select,textarea').forEach(node => node.remove());
  for (const wrapper of template.content.querySelectorAll('.mwe-math-element')) {
    if (wrapper.querySelector('math')) wrapper.querySelectorAll('img.mwe-math-fallback-image-inline,img.mwe-math-fallback-image-display').forEach(image => image.remove());
  }
  let imageJobs = 0;
  for (const node of [...template.content.querySelectorAll('*')]) {
    if (!template.content.contains(node)) continue;
    const tag = node.localName.toLowerCase();
    if (!TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
    const href = node.getAttribute('href');
    const src = node.getAttribute('src');
    const inlineStyle = node.getAttribute('style');
    for (const attr of [...node.attributes]) if (!ATTRIBUTES.has(attr.name.toLowerCase())) node.removeAttribute(attr.name);
    if (inlineStyle) {
      const holder = document.createElement('span');
      holder.style.cssText = inlineStyle;
      const declarations = safeDeclarations(holder.style);
      if (declarations) node.setAttribute('style', declarations);
    }
    if (tag === 'a' && href) {
      const location = locate(href);
      if (location) {
        node.setAttribute('href', '#');
        if (location.external) {
          node.setAttribute('data-kp-external', location.external);
          node.setAttribute('title', `${node.textContent?.trim() || '外部链接'}（打开外部 HTTPS 网页）`);
          node.setAttribute('aria-label', `${node.textContent?.trim() || '外部链接'}（打开外部网页）`);
        } else {
          node.setAttribute('data-kp-path', location.path!);
          node.setAttribute('data-kp-hash', location.hash);
        }
      }
    }
    if (tag === 'img') {
      images++;
      const location = locate(src ?? '');
      const key = `image-${images}`;
      node.setAttribute('data-kp-image', key);
      if (!online && location?.path && imageJobs < 48) {
        jobs.push({ kind: 'image', path: location.path, key });
        imageJobs++;
      } else {
        omittedImages++;
        const replacement = document.createElement('span');
        replacement.className = 'kp-image-unavailable';
        replacement.textContent = node.getAttribute('alt') ? `图片未加载：${node.getAttribute('alt')}`
          : online ? '图片未加载：此阅读方式不自动请求图片。' : '图片未加载：外部引用、缺少资源路径或超出本页限额。';
        node.replaceWith(replacement);
      }
    }
  }
  for (const table of [...template.content.querySelectorAll('table')]) {
    const wrapper = document.createElement('div');
    wrapper.className = 'kp-table-scroll';
    table.replaceWith(wrapper); wrapper.append(table);
  }
  for (const math of template.content.querySelectorAll('math')) {
    mathCount++;
    math.removeAttribute('aria-hidden');
    const wrapper = math.closest('.mwe-math-mathml-a11y');
    if (wrapper) { wrapper.removeAttribute('aria-hidden'); wrapper.removeAttribute('style'); }
  }
  updateStatus();
  const body = template.innerHTML;
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${inlineCSS.join('\n').replace(/<\/style/gi, '<\\/style')}\n${READER_CSS}</style></head><body>${body}</body></html>`;
  let started = false;
  async function loaded(): Promise<void> {
    if (disposed || started) return;
    const doc = iframe.contentDocument;
    if (!doc?.body) return;
    started = true;
    function resize(): void {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        if (!disposed && iframe.contentDocument === doc) iframe.style.height = `${Math.min(12000, Math.max(320, doc!.body.scrollHeight + 6))}px`;
      });
    }
    function scrollHash(hash: string): void {
      let id = hash.replace(/^#/, '');
      try { id = decodeURIComponent(id); } catch { /* Keep a literal fragment. */ }
      const target = doc!.getElementById(id) ?? [...doc!.getElementsByName(id)][0];
      target?.scrollIntoView({ block: 'start' });
    }
    function initialHash(): void {
      if (!reader.hash) return;
      cancelAnimationFrame(hashFrameId);
      hashFrameId = requestAnimationFrame(() => {
        if (!disposed && iframe.contentDocument === doc) scrollHash(reader.hash!);
      });
    }
    function click(event: Event): void {
      const button = (event as MouseEvent).button;
      if (typeof button === 'number' && button !== 0 && button !== 1) return;
      const target = event.target && (event.target as Node).nodeType === Node.ELEMENT_NODE ? event.target as Element : null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      event.preventDefault(); event.stopPropagation();
      const external = anchor.getAttribute('data-kp-external');
      if (external) { window.open(external, '_blank', 'noopener,noreferrer'); return; }
      const path = anchor.getAttribute('data-kp-path');
      const hash = anchor.getAttribute('data-kp-hash') ?? '';
      if (!path) return;
      if (path === currentPath && hash) {
        scrollHash(hash);
        return;
      }
      if (path === currentPath) { iframe.contentWindow?.scrollTo(0, 0); return; }
      ctx.run(ctx.controller.readArchivePath(packId, path + hash));
    }
    function keydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ctx.controller.closeReader(); }
    }
    doc.addEventListener('click', click);
    doc.addEventListener('auxclick', click);
    doc.addEventListener('keydown', keydown);
    cleanupDocument = () => { doc.removeEventListener('click', click); doc.removeEventListener('auxclick', click); doc.removeEventListener('keydown', keydown); };
    observer = new ResizeObserver(resize); observer.observe(doc.body); resize(); initialHash();
    let cursor = 0, resources = 0, totalBytes = 0;
    const cache = new Map<string, Promise<{ mimeType: string; data: Uint8Array }>>();
    async function resource(path: string): Promise<{ mimeType: string; data: Uint8Array }> {
      let promise = cache.get(path);
      if (!promise) {
        if (++resources > MAX_RESOURCES) throw new Error('本页资源数量超过上限');
        promise = ctx.controller.readArchiveResource(packId, path).then(value => {
          if (disposed) throw new Error('阅读已结束');
          totalBytes += value.data.byteLength;
          if (value.data.byteLength > MAX_IMAGE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error('本页资源大小超过上限');
          return value;
        });
        cache.set(path, promise);
      }
      return promise;
    }
    async function worker(): Promise<void> {
      while (!disposed) {
        const job = jobs[cursor++];
        if (!job) return;
        try {
          const value = await resource(job.path);
          if (disposed || iframe.contentDocument !== doc) return;
          const mime = value.mimeType.split(';')[0]!.trim().toLowerCase();
          if (job.kind === 'css') {
            if (mime !== 'text/css' || value.data.byteLength > MAX_CSS_BYTES) throw new Error('样式类型或大小不支持');
            const css = safeCSS(new TextDecoder().decode(value.data));
            const style = doc!.createElement('style'); style.textContent = css;
            doc!.head.insertBefore(style, doc!.head.querySelector('style'));
          } else {
            if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/.test(mime)) throw new Error('图片格式未启用');
            const image = doc!.querySelector<HTMLImageElement>(`[data-kp-image="${job.key}"]`);
            if (!image) continue;
            const blob = new Blob([new Uint8Array(value.data)], { type: mime });
            const url = URL.createObjectURL(blob); urls.add(url);
            image.src = url;
            image.addEventListener('load', resize, { once: true });
            image.addEventListener('error', () => { if (!disposed) { loadedImages--; failedImages++; updateStatus(); resize(); } }, { once: true });
            loadedImages++;
          }
        } catch {
          if (disposed) return;
          if (job.kind === 'css') skippedStyles++;
          else {
            failedImages++;
            const image = doc!.querySelector(`[data-kp-image="${job.key}"]`);
            if (image) {
              const fallback = doc!.createElement('span'); fallback.className = 'kp-image-unavailable';
              fallback.textContent = `图片暂不可读${image.getAttribute('alt') ? `：${image.getAttribute('alt')}` : '：本地资源缺失、格式不支持或超过限额'}`;
              image.replaceWith(fallback);
            }
          }
        }
        updateStatus(); resize();
      }
    }
    await Promise.all(Array.from({ length: 3 }, worker));
    if (!disposed) { resize(); initialHash(); }
  }
  iframe.addEventListener('load', loaded);
  element.append(iframe);
  return { element, dispose };
}
