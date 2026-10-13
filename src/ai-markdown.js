// Safe Markdown for AI answers. The model's text is untrusted: everything is escaped first and the
// renderer emits only the tags below, so no HTML, script or event attribute can come from a reply.
// Links are limited to http(s) and mailto and open outside the app.

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function safeHref(raw) {
  try {
    const url = new URL(raw.trim());
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Inline: code spans, links, bold, italic, strike. Code spans are cut out first so their contents stay literal.

function inline(text) {
  const parts = [];
  let rest = text;
  const codeSpan = /`([^`\n]+)`/;
  while (rest) {
    const match = codeSpan.exec(rest);
    if (!match) { parts.push(formatText(rest)); break; }
    parts.push(formatText(rest.slice(0, match.index)));
    parts.push(`<code>${escapeHtml(match[1])}</code>`);
    rest = rest.slice(match.index + match[0].length);
  }
  return parts.join('');
}

function formatText(text) {
  if (!text) return '';
  const links = [];
  // Markdown links and bare URLs become placeholders before escaping, so their text is escaped once.
  let source = text.replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g, (whole, label, href) => {
    const url = safeHref(href);
    if (!url) return whole;
    links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeEmphasis(label)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  source = source.replace(/\bhttps?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g, raw => {
    const url = safeHref(raw);
    if (!url) return raw;
    links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(raw)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  return escapeEmphasis(source).replace(/\u0000(\d+)\u0000/g, (_, index) => links[Number(index)] ?? '');
}

function escapeEmphasis(text) {
  return escapeHtml(text)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
}

// ---------------------------------------------------------------------------------------------
// Code highlighting: a small tokenizer per language family. It colours, it never interprets.

const KEYWORDS = {
  js: 'await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield async interface type enum implements private protected public readonly as',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self print',
  sh: 'if then else elif fi for while do done case esac in function return export local echo cd ls cat grep sudo npm npx node git pip python',
  sql: 'select from where and or not insert into values update set delete create table drop alter add primary key foreign references join left right inner outer on group by order having limit offset as distinct count sum avg min max null is like in between union all case when then else end',
  c: 'auto break case catch char class const continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while bool string var let fn func fun val package import impl pub mut match mod use struct trait where self Self go defer chan select map range interface type final abstract extends implements override suspend when object data sealed lateinit',
  css: 'important media supports keyframes from to root'
};

const LANGUAGE_FAMILY = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', json: 'js',
  py: 'py', python: 'py',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', powershell: 'sh', ps1: 'sh',
  sql: 'sql', postgres: 'sql', mysql: 'sql',
  c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', java: 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', kotlin: 'c', kt: 'c', swift: 'c', php: 'c', dart: 'c',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html', svg: 'html', vue: 'html'
};

const keywordSets = Object.fromEntries(Object.entries(KEYWORDS).map(([family, words]) => [family, new Set(words.split(' '))]));

function highlight(code, language) {
  const family = LANGUAGE_FAMILY[language.toLowerCase()];
  if (!family) return escapeHtml(code);
  if (family === 'html') {
    return escapeHtml(code)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-c">$1</span>')
      .replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g, '$1<span class="tok-k">$2</span>')
      .replace(/([\w:-]+)=(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="tok-f">$1</span>=<span class="tok-s">$2</span>');
  }
  const comment = family === 'py' || family === 'sh' ? /#[^\n]*/y : family === 'sql' ? /--[^\n]*/y : /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y;
  const patterns = [
    ['c', comment],
    ['s', /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y],
    ['n', /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/y],
    ['w', /[A-Za-z_$][\w$]*/y],
    ['o', /\s+|[^\sA-Za-z_$\d"'`#/-]+|[\s\S]/y]
  ];
  const words = keywordSets[family] ?? new Set();
  let out = '';
  let index = 0;
  while (index < code.length) {
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = index;
      const match = pattern.exec(code);
      if (!match || !match[0]) continue;
      const token = match[0];
      index += token.length;
      if (kind === 'w') {
        if (words.has(family === 'sql' ? token.toLowerCase() : token)) out += `<span class="tok-k">${escapeHtml(token)}</span>`;
        else if (code[index] === '(') out += `<span class="tok-f">${escapeHtml(token)}</span>`;
        else out += escapeHtml(token);
      } else if (kind === 'o') {
        out += escapeHtml(token);
      } else {
        out += `<span class="tok-${kind}">${escapeHtml(token)}</span>`;
      }
      break;
    }
  }
  return out;
}

function codeBlock(code, language, open) {
  const label = /^[\w+#.-]{1,20}$/.test(language) ? language : '';
  return `<div class="ai-code${open ? ' is-open' : ''}"><div class="ai-code-head"><span>${escapeHtml(label || 'код')}</span><button type="button" class="ai-code-copy" data-copy-code aria-label="Копіювати код">Копіювати</button></div><pre><code>${highlight(code, label)}</code></pre></div>`;
}

// ---------------------------------------------------------------------------------------------
// Blocks

function tableBlock(lines) {
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  const head = cells(lines[0]);
  const align = cells(lines[1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : '');
  const row = (values, tag) => `<tr>${values.map((value, index) => `<${tag}${align[index] ? ` style="text-align:${align[index]}"` : ''}>${inline(value)}</${tag}>`).join('')}</tr>`;
  return `<div class="ai-table"><table><thead>${row(head, 'th')}</thead><tbody>${lines.slice(2).map(line => row(cells(line), 'td')).join('')}</tbody></table></div>`;
}

/** Markdown → safe HTML. `streaming` keeps an unclosed code fence open instead of dropping it. */
export function renderMarkdown(source, { streaming = false } = {}) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker)) { body.push(lines[index]); index += 1; }
      const closed = index < lines.length;
      html.push(codeBlock(body.join('\n'), fence[2] ?? '', !closed && streaming));
      index += 1;
      continue;
    }
    if (!line.trim()) { flush(); index += 1; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flush(); const level = Math.min(4, heading[1].length + 1); html.push(`<h${level}>${inline(heading[2])}</h${level}>`); index += 1; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html.push('<hr>'); index += 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[index + 1] ?? '')) {
      flush();
      const rows = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) { rows.push(lines[index]); index += 1; }
      html.push(tableBlock(rows));
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) { quoted.push(lines[index].replace(/^\s*>\s?/, '')); index += 1; }
      html.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    const listItem = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flush();
      const ordered = /\d/.test(listItem[2]);
      const start = ordered ? Number.parseInt(listItem[2], 10) : 1;
      const items = [];
      while (index < lines.length) {
        const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[index]);
        if (item && /\d/.test(item[2]) === ordered) { items.push({ text: item[3], nested: item[1].length >= 2 }); index += 1; continue; }
        // A wrapped line continues the previous item.
        if (items.length && lines[index].trim() && /^\s{2,}\S/.test(lines[index])) { items[items.length - 1].text += ` ${lines[index].trim()}`; index += 1; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map(item => `<li${item.nested ? ' class="is-nested"' : ''}>${inline(item.text)}</li>`).join('')}</${tag}>`);
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flush();
  return html.join('');
}

export function escapeText(value) {
  return escapeHtml(value);
}
