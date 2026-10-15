/** Reads JSON values received so far. No evaluation and no guessing missing code or JSON tokens. */
interface Node { value: unknown; complete: boolean; fields?: Record<string, Node>; items?: Node[] }
export interface ProjectFragment {
  title?: string; kind?: 'website' | 'code'; projectId?: string;
  files: Array<{ path: string; content: string }>;
  offset?: number;
}

export function projectFragment(raw: string, tool: string): ProjectFragment | null {
  if (raw.length > 1_000_000) return null;
  let at = 0;
  const space = () => { while (/\s/.test(raw[at] ?? '') && at < raw.length) at++; };
  const string = (): Node | null => {
    const start = at++;
    while (at < raw.length) {
      const ch = raw[at]!;
      if (ch === '"') {
        at++;
        try { return { value: JSON.parse(raw.slice(start, at)), complete: true }; } catch { return null; }
      }
      if (ch === '\\') {
        const escaped = raw[at + 1];
        if (!escaped) break;
        if (escaped === 'u') { if (!/^[\da-f]{4}$/i.test(raw.slice(at + 2, at + 6))) break; at += 6; }
        else { if (!'"\\/bfnrt'.includes(escaped)) return null; at += 2; }
      } else { if (ch.charCodeAt(0) < 32) return null; at++; }
    }
    try {
      let value: string = JSON.parse(`${raw.slice(start, at)}"`);
      // A Unicode escape for the second half of a surrogate pair may arrive in the next frame.
      if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
      return { value, complete: false };
    } catch { return null; }
  };
  const read = (depth: number): Node | null => {
    if (depth > 12) return null;
    space();
    if (raw[at] === '"') return string();
    const object = raw[at] === '{';
    if (object || raw[at] === '[') {
      at++;
      const fields: Record<string, Node> = Object.create(null);
      const items: Node[] = [];
      const value: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      const node: Node = { value, complete: false, ...(object ? { fields } : { items }) };
      while (at < raw.length) {
        space();
        if (raw[at] === (object ? '}' : ']')) { at++; node.complete = true; return node; }
        let key: string | undefined;
        if (object) {
          if (raw[at] !== '"') return node;
          const name = string();
          if (!name?.complete) return node;
          key = String(name.value); space();
          if (raw[at++] !== ':') return node;
        }
        const child = read(depth + 1);
        if (!child) return node;
        if (object) { fields[key!] = child; (value as Record<string, unknown>)[key!] = child.value; }
        else { items.push(child); (value as unknown[]).push(child.value); }
        if (!child.complete) return node;
        space();
        if (raw[at] === ',') { at++; continue; }
        if (raw[at] !== (object ? '}' : ']')) return node;
      }
      return node;
    }
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,}\]]|$)/.exec(raw.slice(at));
    if (!literal) return null;
    at += literal[0].length;
    try { return { value: JSON.parse(literal[0]), complete: true }; } catch { return null; }
  };
  const root = read(0)?.fields;
  if (!root) return null;
  const text = (key: string) => root[key]?.complete && typeof root[key].value === 'string' ? root[key].value as string : undefined;
  const result: ProjectFragment = { files: [] };
  const title = text('title'), kind = text('kind'), projectId = text('projectId');
  if (title) result.title = title;
  if (kind === 'website' || kind === 'code') result.kind = kind;
  if (projectId) result.projectId = projectId;
  const nodes = tool === 'append_project_file' ? [{ fields: root }] : root.files?.items ?? [];
  for (const node of nodes) {
    const path = node.fields?.path, content = node.fields?.content;
    if (path?.complete && typeof path.value === 'string' && typeof content?.value === 'string' && content.value) result.files.push({ path: path.value, content: content.value });
  }
  if (tool === 'append_project_file' && typeof root.offset?.value === 'number' && Number.isSafeInteger(root.offset.value)) result.offset = root.offset.value;
  return result.files.length ? result : null;
}
