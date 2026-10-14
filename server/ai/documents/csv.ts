/**
 * CSV by RFC 4180: quoted fields, doubled quotes, line breaks inside quotes. The separator is
 * detected from the first lines, because spreadsheets in Ukrainian locales save with «;».
 */

const MAX_ROWS = 100_000;

function detectSeparator(text: string): string {
  const sample = text.split('\n').slice(0, 10).join('\n');
  const counts = [',', ';', '\t'].map(separator => {
    let count = 0, quoted = false;
    for (const char of sample) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === separator) count += 1;
    }
    return [separator, count] as const;
  });
  return counts.sort((a, b) => b[1] - a[1])[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const separator = detectSeparator(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === separator) { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field); field = '';
      if (row.some(cell => cell.trim())) rows.push(row);
      row = [];
      if (rows.length >= MAX_ROWS) break;
    } else field += char;
  }
  row.push(field);
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}

export function toCsv(rows: string[][]): string {
  const cell = (value: string) => /[",\n\r;]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  // The BOM makes Excel open UTF-8 Cyrillic correctly.
  return `﻿${rows.map(row => row.map(value => cell(value ?? '')).join(',')).join('\r\n')}\r\n`;
}
