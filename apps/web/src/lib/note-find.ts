export type TextMatch = {from: number; to: number};
export type FindResult = {matches: TextMatch[]; limited: boolean};
export const MAX_FIND_MATCHES = 2000;

export function findText(text: string, query: string, caseSensitive: boolean): FindResult {
  if (!query) return {matches: [], limited: false};
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  const matches: TextMatch[] = [];
  for (const match of text.matchAll(pattern)) {
    if (matches.length === MAX_FIND_MATCHES) return {matches, limited: true};
    matches.push({from: match.index!, to: match.index! + match[0].length});
  }
  return {matches, limited: false};
}

type TextPiece = {node: Text; from: number; to: number};
const blocks = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'TD', 'TH']);
/** Preserve inline continuity, but do not invent matches across paragraphs or table cells. */
export function indexRenderedText(root: HTMLElement) {
  let text = '';
  const pieces: TextPiece[] = [];
  const separate = () => {if (text && !text.endsWith('\n')) text += '\n';};
  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? '';
      pieces.push({node: node as Text, from: text.length, to: text.length + value.length});
      text += value;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.hidden || node.getAttribute('aria-hidden') === 'true' || ['SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA'].includes(node.tagName)) return;
    if (node.tagName === 'BR') {text += '\n'; return;}
    const block = blocks.has(node.tagName);
    if (block) separate();
    node.childNodes.forEach(visit);
    if (block) separate();
  }
  root.childNodes.forEach(visit);
  return {
    text,
    range(match: TextMatch): Range {
      const first = pieces.find(piece => piece.from <= match.from && piece.to > match.from)!;
      const last = pieces.find(piece => piece.from < match.to && piece.to >= match.to)!;
      const range = document.createRange();
      range.setStart(first.node, match.from - first.from);
      range.setEnd(last.node, match.to - last.from);
      return range;
    }
  };
}

export interface NoteFindEditor {
  selectedText(): string;
  highlight(matches: TextMatch[], active: number): void;
  clear(): void;
}
