import { Lexer, type Token, type Tokens } from 'marked';

/**
 * Markdown is the shared shape of documents here: uploaded Word files become Markdown for the model,
 * and the model writes Markdown that becomes Word, PDF, PowerPoint or Excel. This module converts in
 * both directions and keeps headings, lists, tables, emphasis and Cyrillic.
 */

export interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean; link?: string }
export interface ListItem { runs: Run[]; sublist?: ListBlock }
export interface ListBlock { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | ListBlock
  | { type: 'table'; header: Run[][]; rows: Run[][][] }
  | { type: 'quote'; runs: Run[] }
  | { type: 'code'; text: string; lang: string }
  | { type: 'rule' };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', deg: '°' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function runsText(runs: Run[]): string {
  return runs.map(run => run.text).join('');
}

// ---------------------------------------------------------------------------------------------
// Markdown → blocks (for the writers).

function inline(tokens: Token[] | undefined, style: Omit<Run, 'text'> = {}): Run[] {
  const runs: Run[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong': runs.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true })); break;
      case 'em': runs.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true })); break;
      case 'del': runs.push(...inline((token as Tokens.Del).tokens, style)); break;
      case 'codespan': runs.push({ ...style, text: decodeEntities((token as Tokens.Codespan).text), code: true }); break;
      case 'link': runs.push(...inline((token as Tokens.Link).tokens, { ...style, link: (token as Tokens.Link).href })); break;
      case 'br': runs.push({ ...style, text: '\n' }); break;
      case 'image': runs.push({ ...style, text: (token as Tokens.Image).text ? `[${(token as Tokens.Image).text}]` : '' }); break;
      case 'html': break;
      case 'text':
      case 'escape': {
        const text = token as Tokens.Text;
        if (text.tokens?.length) runs.push(...inline(text.tokens, style));
        else runs.push({ ...style, text: decodeEntities(text.text) });
        break;
      }
      default: if ('text' in token && typeof token.text === 'string') runs.push({ ...style, text: decodeEntities(token.text) });
    }
  }
  // Neighbouring runs with the same style merge, which keeps Word and PDF output tidy.
  return runs.reduce<Run[]>((merged, run) => {
    const last = merged[merged.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.code === run.code && last.link === run.link) last.text += run.text;
    else if (run.text) merged.push({ ...run });
    return merged;
  }, []);
}

function listBlock(token: Tokens.List, depth: number): ListBlock {
  return {
    type: 'list', ordered: token.ordered, start: typeof token.start === 'number' ? token.start : 1,
    items: token.items.map(item => {
      const runs: Run[] = [];
      let sublist: ListBlock | undefined;
      for (const child of item.tokens) {
        if (child.type === 'list') {
          if (depth < 2) sublist = listBlock(child as Tokens.List, depth + 1);
          else runs.push({ text: ' ' + (child as Tokens.List).items.map(sub => sub.text).join('; ') });
        } else if (child.type === 'text' || child.type === 'paragraph') {
          if (runs.length) runs.push({ text: ' ' });
          runs.push(...inline((child as Tokens.Text).tokens ?? [{ type: 'text', raw: (child as Tokens.Text).text, text: (child as Tokens.Text).text } as Tokens.Text]));
        }
      }
      if (item.task) runs.unshift({ text: item.checked ? '☑ ' : '☐ ' });
      return { runs, ...(sublist ? { sublist } : {}) };
    })
  };
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case 'heading': {
          const heading = token as Tokens.Heading;
          blocks.push({ type: 'heading', level: Math.min(4, Math.max(1, heading.depth)) as 1 | 2 | 3 | 4, runs: inline(heading.tokens) });
          break;
        }
        case 'paragraph': blocks.push({ type: 'paragraph', runs: inline((token as Tokens.Paragraph).tokens) }); break;
        case 'text': blocks.push({ type: 'paragraph', runs: inline((token as Tokens.Text).tokens ?? [token]) }); break;
        case 'list': blocks.push(listBlock(token as Tokens.List, 1)); break;
        case 'table': {
          const table = token as Tokens.Table;
          blocks.push({ type: 'table', header: table.header.map(cell => inline(cell.tokens)), rows: table.rows.map(row => row.map(cell => inline(cell.tokens))) });
          break;
        }
        case 'blockquote': {
          const quote = token as Tokens.Blockquote;
          const runs: Run[] = [];
          for (const child of quote.tokens) {
            if (runs.length) runs.push({ text: '\n' });
            if ('tokens' in child && Array.isArray(child.tokens)) runs.push(...inline(child.tokens as Token[]));
            else if ('text' in child && typeof child.text === 'string') runs.push({ text: child.text });
          }
          blocks.push({ type: 'quote', runs });
          break;
        }
        case 'code': blocks.push({ type: 'code', text: (token as Tokens.Code).text, lang: (token as Tokens.Code).lang ?? '' }); break;
        case 'hr': blocks.push({ type: 'rule' }); break;
        default: break;
      }
    }
  };
  walk(new Lexer({ gfm: true }).lex(markdown.replace(/\r\n?/g, '\n')));
  return blocks.filter(block => block.type !== 'paragraph' || runsText(block.runs).trim());
}

/** Plain text of blocks, for .txt output and for checks. */
export function blocksToText(blocks: Block[]): string {
  const list = (block: ListBlock, indent: string): string => block.items.map((item, index) =>
    `${indent}${block.ordered ? `${block.start + index}.` : '•'} ${runsText(item.runs)}${item.sublist ? `\n${list(item.sublist, `${indent}  `)}` : ''}`).join('\n');
  return blocks.map(block => {
    switch (block.type) {
      case 'heading': return runsText(block.runs).toUpperCase() === runsText(block.runs) ? runsText(block.runs) : `${runsText(block.runs)}\n${'='.repeat(Math.min(60, runsText(block.runs).length))}`;
      case 'paragraph': return runsText(block.runs);
      case 'list': return list(block, '');
      case 'table': return [block.header, ...block.rows].map(row => row.map(runsText).join('\t')).join('\n');
      case 'quote': return runsText(block.runs).split('\n').map(line => `  ${line}`).join('\n');
      case 'code': return block.text;
      case 'rule': return '—'.repeat(20);
    }
  }).join('\n\n');
}

export function markdownTable(header: string[], rows: string[][]): string {
  const width = Math.max(header.length, ...rows.map(row => row.length), 1);
  const cell = (value: string | undefined) => (value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, index) => cell(cells[index])).join(' | ')} |`;
  return [line(header.map(value => value || ' ')), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------------------------
// HTML (from Word via mammoth) → Markdown. mammoth emits a small, well-formed subset.

interface HtmlNode { tag: string; children: Array<HtmlNode | string>; attrs: string }
const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'col']);

function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: 'root', children: [], attrs: '' };
  const stack: HtmlNode[] = [root];
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<!--[\s\S]*?-->|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const [, closing, rawTag, attrs, text] = match;
    const top = stack[stack.length - 1]!;
    if (text !== undefined) { top.children.push(decodeEntities(text)); continue; }
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const index = stack.map(node => node.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
      continue;
    }
    const node: HtmlNode = { tag, children: [], attrs: attrs ?? '' };
    top.children.push(node);
    if (!VOID.has(tag) && !(attrs ?? '').trim().endsWith('/')) stack.push(node);
  }
  return root;
}

function inlineMarkdown(nodes: Array<HtmlNode | string>): string {
  return nodes.map(node => {
    if (typeof node === 'string') return node.replace(/\s+/g, ' ');
    const inner = inlineMarkdown(node.children);
    switch (node.tag) {
      case 'strong': case 'b': return inner.trim() ? `**${inner.trim()}**` : inner;
      case 'em': case 'i': return inner.trim() ? `*${inner.trim()}*` : inner;
      case 'br': return '  \n';
      case 'img': return '';
      case 'a': {
        const href = /href="([^"]+)"/.exec(node.attrs)?.[1];
        return href && /^https?:/i.test(href) && inner.trim() ? `[${inner.trim()}](${decodeEntities(href)})` : inner;
      }
      case 'sup': return `^${inner}`;
      default: return inner;
    }
  }).join('');
}

function blockMarkdown(node: HtmlNode, depth = 0): string[] {
  const out: string[] = [];
  let pending: Array<HtmlNode | string> = [];
  const flushInline = () => {
    const text = inlineMarkdown(pending).trim();
    if (text) out.push(text);
    pending = [];
  };
  for (const child of node.children) {
    if (typeof child === 'string' || !['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'blockquote', 'div', 'pre', 'hr'].includes(child.tag)) { pending.push(child); continue; }
    flushInline();
    switch (child.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const text = inlineMarkdown(child.children).replace(/\*\*/g, '').trim();
        if (text) out.push(`${'#'.repeat(Math.min(4, Number(child.tag[1])))} ${text}`);
        break;
      }
      case 'p': { const text = inlineMarkdown(child.children).trim(); if (text) out.push(text); break; }
      case 'ul': case 'ol': out.push(listMarkdown(child, depth)); break;
      case 'table': out.push(tableMarkdown(child)); break;
      case 'blockquote': out.push(blockMarkdown(child, depth).map(line => line.split('\n').map(part => `> ${part}`).join('\n')).join('\n>\n')); break;
      case 'pre': out.push(`\`\`\`\n${textOf(child)}\n\`\`\``); break;
      case 'hr': out.push('---'); break;
      default: out.push(...blockMarkdown(child, depth));
    }
  }
  flushInline();
  return out;
}

function textOf(node: HtmlNode | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('');
}

function listMarkdown(list: HtmlNode, depth: number): string {
  const indent = '  '.repeat(depth);
  let number = 1;
  return list.children.filter((child): child is HtmlNode => typeof child !== 'string' && child.tag === 'li').map(item => {
    const nested = item.children.filter((child): child is HtmlNode => typeof child !== 'string' && (child.tag === 'ul' || child.tag === 'ol'));
    const own = item.children.filter(child => typeof child === 'string' || (child.tag !== 'ul' && child.tag !== 'ol'));
    const text = own.map(child => typeof child === 'string' ? child : child.tag === 'p' ? inlineMarkdown(child.children) : inlineMarkdown([child])).join(' ').replace(/\s+/g, ' ').trim();
    const marker = list.tag === 'ol' ? `${number++}.` : '-';
    return [`${indent}${marker} ${text}`, ...nested.map(child => listMarkdown(child, depth + 1))].join('\n');
  }).join('\n');
}

function tableMarkdown(table: HtmlNode): string {
  const rows: string[][] = [];
  const visit = (node: HtmlNode) => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'tr') rows.push(child.children.filter((cell): cell is HtmlNode => typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th')).map(cell => blockMarkdown(cell).join(' ').replace(/\s+/g, ' ').trim()));
      else visit(child);
    }
  };
  visit(table);
  if (!rows.length) return '';
  return markdownTable(rows[0]!, rows.slice(1));
}

export function htmlToMarkdown(html: string): string {
  return blockMarkdown(parseHtml(html)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
