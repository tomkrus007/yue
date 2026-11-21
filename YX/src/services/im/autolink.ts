/**
 * 消息文本里的链接识别。
 *
 * 文本来自别人，必须当不可信输入处理：只认 http/https，`javascript:` 等伪协议一律不生成链接。
 * 生成的 `<a class="msg-link" data-msg-link>` 只是展示用，真正的打开动作由消息组件拦截点击后
 * 交给 `@tauri-apps/plugin-opener`，避免 WebView 直接把应用导航走。
 *
 * 地址只取 ASCII 可见字符：正文里的中文（如 “请访问https://a.com了解”）通常紧贴链接，
 * 允许中文会让整段话被吞进地址；真正的中文路径在浏览器里也会被百分号编码。
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+/gi

/** 紧跟在地址后面的标点通常属于句子，不属于 URL。 */
const TRAILING = new Set([
  '.', ',', ';', ':', '!', '?',
  '…', '“', '”', '‘', '’',
  ')', ']', '}',
])

const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function countOf(text: string, char: string): number {
  return text.split(char).length - 1
}

/** 去掉句末标点；成对的括号算 URL 的一部分（如维基百科的 `Foo_(bar)`）。 */
export function trimUrlTail(raw: string): string {
  let end = raw.length
  while (end > 0) {
    const char = raw[end - 1]
    if (!TRAILING.has(char)) break
    const open = PAIRS[char]
    if (open) {
      const head = raw.slice(0, end)
      if (countOf(head, open) >= countOf(head, char)) break
    }
    end -= 1
  }
  return raw.slice(0, end)
}

/** 把文本追加到 parent，其中的 http(s) 地址转成可点击的锚点。 */
export function appendAutoLinkText(parent: HTMLElement, text: string): void {
  if (!text) return
  let start = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0
    const href = trimUrlTail(match[0])
    if (href.length <= 'https://'.length) continue
    if (index > start) parent.appendChild(document.createTextNode(text.slice(start, index)))
    const anchor = document.createElement('a')
    anchor.className = 'msg-link'
    anchor.dataset.msgLink = '1'
    anchor.href = href
    anchor.textContent = href
    anchor.rel = 'noreferrer noopener'
    parent.appendChild(anchor)
    start = index + href.length
  }
  if (start < text.length) parent.appendChild(document.createTextNode(text.slice(start)))
}

/** 从被点击的节点找到消息链接并返回其地址，非链接返回空串。 */
export function msgLinkHref(target: EventTarget | null): string {
  const element = target instanceof Element ? target.closest('a[data-msg-link]') : null
  const href = element?.getAttribute('href') || ''
  return /^https?:\/\//i.test(href) ? href : ''
}
