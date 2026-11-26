import type { CapturedPage } from './knowledge-types';

/**
 * Self-contained so Chrome can serialize it into scripting.executeScript().
 * Reads the rendered page only when the user explicitly requests a capture.
 */
export function extractPageContent(): CapturedPage {
  const maxCharacters = 200_000;
  const maxSections = 200;
  const ignoredTags = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SVG', 'CANVAS',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'VIDEO', 'AUDIO', 'DIALOG',
  ]);
  const blockTags = new Set(['P', 'DIV', 'SECTION', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'BR', 'TR', 'DD', 'DT']);
  const sections: Array<{ heading: string; text: string }> = [];
  let visited = 0;
  let characters = 0;
  let truncated = false;
  let heading = '';
  let parts: string[] = [];

  function visible(element: Element): boolean {
    if (ignoredTags.has(element.tagName.toUpperCase())) return false;
    if (element.hasAttribute('hidden') || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') return false;
    const role = element.getAttribute('role');
    if (role === 'navigation' || role === 'textbox' || role === 'banner') return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.contentVisibility !== 'hidden' && style.opacity !== '0';
  }

  function renderedText(node: Node, depth = 0): string {
    if (depth > 100 || ++visited > 50_000) { truncated = true; return ''; }
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeType !== 1 || !visible(node as Element)) return '';
    return Array.from(node.childNodes, (child) => renderedText(child, depth + 1)).join('');
  }

  function append(text: string): void {
    if (characters >= maxCharacters) { truncated = true; return; }
    const bounded = text.slice(0, maxCharacters - characters);
    parts.push(bounded);
    characters += bounded.length;
    if (bounded.length !== text.length) truncated = true;
  }

  function flush(): void {
    const text = parts.join('').replace(/[ \t\r\f]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    parts = [];
    if (!text) return;
    if (sections.length >= maxSections) { truncated = true; return; }
    sections.push({ heading, text });
  }

  function walk(node: Node, depth = 0): void {
    if (characters >= maxCharacters || sections.length >= maxSections || depth > 100 || ++visited > 50_000) {
      truncated = true;
      return;
    }
    if (node.nodeType === 3) { append(node.textContent || ''); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (!visible(element)) return;
    if (/^H[1-6]$/i.test(element.tagName)) {
      flush();
      heading = renderedText(element).replace(/\s+/g, ' ').trim().slice(0, 240);
      return;
    }
    const block = blockTags.has(element.tagName.toUpperCase());
    if (block) append('\n');
    for (const child of Array.from(element.childNodes)) walk(child, depth + 1);
    if (block) append('\n');
  }

  const candidates = Array.from(document.querySelectorAll('article,main,[role="main"],[role="article"]')).filter((element) => {
    let ancestor: Element | null = element;
    while (ancestor) {
      if (!visible(ancestor)) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
  const root = candidates.sort((left, right) => (right.textContent?.length || 0) - (left.textContent?.length || 0))[0] || document.body;
  if (root) walk(root);
  flush();
  const title = document.title.replace(/\s+/g, ' ').trim().slice(0, 512) || sections[0]?.heading || window.location.hostname;
  return { url: window.location.href, title, sections, truncated };
}
