import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.js';
import { decodeText, kindFromName, matchesKind } from './formats.js';
import { htmlToMarkdown, parseMarkdown } from './markdown.js';
import { DocumentReadError, extractDocument } from './read.js';
import { renderFile } from './write.js';

const SOURCE = [
  '# Фотосинтез',
  '',
  'Процес, у якому рослини перетворюють **світло** на *енергію*.',
  '',
  '## Основні етапи',
  '',
  '1. Світлова фаза',
  '2. Темнова фаза (цикл Кальвіна)',
  '',
  '## Що потрібно',
  '',
  '- Вода',
  '- Вуглекислий газ',
  '  - з повітря',
  '- Світло',
  '',
  '## Порівняння фаз',
  '',
  '| Фаза | Де відбувається | Результат |',
  '| --- | --- | --- |',
  '| Світлова | Тилакоїди | АТФ, кисень |',
  '| Темнова | Строма | Глюкоза |',
  '',
  '> Запамʼятай: без світла фотосинтез не йде.'
].join('\n');

describe('documents — writing real files that read back with their structure', () => {
  it('builds a Word document with headings, lists, a table and Cyrillic', async () => {
    const file = await renderFile({ title: 'Фотосинтез', content: SOURCE, format: 'docx' });
    expect(file.bytes.readUInt32LE(0)).toBe(0x04034b50);
    expect(file.extension).toBe('docx');
    expect(file.preview).toEqual({ kind: 'outline', items: ['Фотосинтез', 'Основні етапи', 'Що потрібно', 'Порівняння фаз'] });
    const read = await extractDocument('docx', file.bytes);
    expect(read.text).toMatch(/^# Фотосинтез/);
    expect(read.text).toContain('## Основні етапи');
    expect(read.text).toContain('**світло**');
    expect(read.text).toMatch(/1\. Світлова фаза\n2\. Темнова фаза/);
    expect(read.text).toMatch(/- Вуглекислий газ\n {2}- з повітря/);
    expect(read.text).toContain('| Світлова | Тилакоїди | АТФ, кисень |');
    expect(read.outline).toEqual(['Фотосинтез', 'Основні етапи', 'Що потрібно', 'Порівняння фаз']);
  });

  it('builds a PDF with embedded Cyrillic fonts; headings come back as headings', async () => {
    const file = await renderFile({ title: 'Фотосинтез', content: SOURCE, format: 'pdf' });
    expect(file.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const read = await extractDocument('pdf', file.bytes);
    expect(read.scanned).toBeFalsy();
    expect(read.pages).toBe(1);
    expect(read.text).toMatch(/^#+ Фотосинтез/m);
    expect(read.text).toMatch(/^#+ Основні етапи/m);
    expect(read.text).toContain('Процес, у якому рослини перетворюють світло на енергію.');
    expect(read.text).toContain('Тилакоїди');
    expect(read.text).toContain('Вуглекислий газ');
  });

  it('builds a presentation: a title slide and a slide per section, tables included', async () => {
    const file = await renderFile({ title: 'Фотосинтез', content: SOURCE, format: 'pptx' });
    expect(file.preview).toEqual({ kind: 'slides', items: ['Фотосинтез', 'Основні етапи', 'Що потрібно', 'Порівняння фаз'] });
    const read = await extractDocument('pptx', file.bytes);
    expect(read.slides).toBe(4);
    expect(read.outline).toEqual(['Фотосинтез', 'Основні етапи', 'Що потрібно', 'Порівняння фаз']);
    expect(read.text).toContain('- Темнова фаза (цикл Кальвіна)');
    expect(read.text).toContain('| Темнова | Строма | Глюкоза |');
    expect(read.text).toContain('> Нотатки: Запамʼятай: без світла фотосинтез не йде.');
  });

  it('splits a crowded section into continuation slides', async () => {
    const content = `# Дуже довгий список\n\n${Array.from({ length: 16 }, (_, index) => `- Пункт ${index + 1}`).join('\n')}`;
    const read = await extractDocument('pptx', (await renderFile({ title: 'Список', content, format: 'pptx' })).bytes);
    expect(read.outline).toEqual(['Список', 'Дуже довгий список', 'Дуже довгий список (продовження)', 'Дуже довгий список (продовження)']);
  });

  it('builds a workbook with a sheet per table, numbers as numbers and leading zeros kept', async () => {
    const content = '## Оцінки\n\n| Учень | Бал | Код |\n| --- | --- | --- |\n| Олена | 11 | 007 |\n| Тарас | 9,5 | 012 |\n\n## Відвідування\n\n| Дата | Присутні |\n| --- | --- |\n| 2026-10-01 | 18 |';
    const file = await renderFile({ title: 'Журнал', content, format: 'xlsx' });
    expect(file.preview).toEqual({ kind: 'table', sheet: 'Оцінки', header: ['Учень', 'Бал', 'Код'], rows: [['Олена', '11', '007'], ['Тарас', '9,5', '012']] });
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.bytes as unknown as ArrayBuffer);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['Оцінки', 'Відвідування']);
    expect(workbook.getWorksheet('Оцінки')!.getCell('B3').value).toBe(9.5);
    expect(workbook.getWorksheet('Оцінки')!.getCell('C2').value).toBe('007');
    const read = await extractDocument('xlsx', file.bytes);
    expect(read.sheets).toEqual([{ name: 'Оцінки', rows: 3, columns: 3 }, { name: 'Відвідування', rows: 2, columns: 2 }]);
    expect(read.text).toContain('| Тарас | 9.5 | 012 |');
  });

  it('writes CSV with a BOM for Excel, and plain text and Markdown files', async () => {
    const csv = await renderFile({ title: 'Таблиця', content: '| Назва | Ціна |\n| --- | --- |\n| Кава, мала | 45 |', format: 'csv' });
    expect(csv.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.bytes.toString('utf8').slice(1)).toBe('Назва,Ціна\r\n"Кава, мала",45\r\n');
    const txt = await renderFile({ title: 'Нотатка', content: SOURCE, format: 'txt' });
    expect(txt.bytes.toString('utf8')).toContain('• Вода');
    const md = await renderFile({ title: 'Нотатка', content: 'Лише текст.', format: 'md' });
    expect(md.bytes.toString('utf8')).toBe('# Нотатка\n\nЛише текст.\n');
  });

  it('refuses to build a spreadsheet without a table', async () => {
    await expect(renderFile({ title: 'x', content: 'Просто речення.', format: 'xlsx' })).rejects.toThrow('Для таблиці потрібна');
  });
});

describe('documents — reading uploads', () => {
  it('accepts only bytes that really are the format', async () => {
    const text = Buffer.from('Це звичайний текст, просто перейменований.', 'utf8');
    expect(matchesKind('pdf', text)).toBe(false);
    expect(matchesKind('docx', text)).toBe(false);
    await expect(extractDocument('pdf', text)).rejects.toBeInstanceOf(DocumentReadError);
    // A real XLSX is a ZIP, but not every ZIP is a Word document.
    const xlsx = (await renderFile({ title: 'x', content: '| a | b |\n| - | - |\n| 1 | 2 |', format: 'xlsx' })).bytes;
    expect(matchesKind('xlsx', xlsx)).toBe(true);
    expect(matchesKind('docx', xlsx)).toBe(false);
    expect(kindFromName('Реферат.doc')).toEqual({ error: 'Формат .doc не підтримується. Збережіть файл як .docx і прикріпіть ще раз.' });
    expect(kindFromName('notes.MD')).toEqual({ kind: 'md' });
  });

  it('reads Windows-1251 text and CSV with semicolons', async () => {
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2]); // «Привіт»
    expect(decodeText(cp1251)).toBe('Привіт');
    const csv = Buffer.concat([Buffer.from('Імʼя;Бал\r\n"Іван; молодший";10\r\n', 'utf8')]);
    const read = await extractDocument('csv', csv);
    expect(read.text).toBe('| Імʼя | Бал |\n| --- | --- |\n| Іван; молодший | 10 |');
    expect(parseCsv('a,"b ""c""",d\n1,"2\n3",4')).toEqual([['a', 'b "c"', 'd'], ['1', '2\n3', '4']]);
    expect(parseCsv(toCsv([['x', 'y, z']]))).toEqual([['x', 'y, z']]);
  });

  it('marks a PDF without a text layer as scanned instead of inventing text', async () => {
    const PdfMake = (await import('node:module')).createRequire(import.meta.url)('pdfmake');
    const vfs = (await import('node:module')).createRequire(import.meta.url)('pdfmake/build/vfs_fonts');
    for (const [name, data] of Object.entries(vfs as Record<string, string>)) PdfMake.virtualfs.writeFileSync(name, data, 'base64');
    PdfMake.setFonts({ Roboto: { normal: 'Roboto-Regular.ttf', bold: 'Roboto-Medium.ttf', italics: 'Roboto-Italic.ttf', bolditalics: 'Roboto-MediumItalic.ttf' } });
    PdfMake.setUrlAccessPolicy(() => false);
    const scan = Buffer.from(await PdfMake.createPdf({ content: [{ canvas: [{ type: 'rect', x: 0, y: 0, w: 400, h: 600, color: '#888888' }] }] }).getBuffer());
    const read = await extractDocument('pdf', scan);
    expect(read).toMatchObject({ scanned: true, text: '', pages: 1 });
  });

  it('turns Word HTML into Markdown with nested lists and tables', () => {
    const html = '<h1>План</h1><p>Вступ з <strong>жирним</strong> і <em>курсивом</em>.</p><ol><li>Перше<ul><li>деталь</li></ul></li><li>Друге</li></ol><table><tr><td><p>А</p></td><td><p>Б</p></td></tr><tr><td><p>1 | 2</p></td><td><p>3</p></td></tr></table><p>Кінець &amp; все</p>';
    expect(htmlToMarkdown(html)).toBe('# План\n\nВступ з **жирним** і *курсивом*.\n\n1. Перше\n  - деталь\n2. Друге\n\n| А | Б |\n| --- | --- |\n| 1 \\| 2 | 3 |\n\nКінець & все');
  });

  it('parses Markdown into blocks for the writers', () => {
    const blocks = parseMarkdown('# Т\n\nТекст із `кодом` і [посиланням](https://example.com).\n\n---\n\n```js\nlet x = 1;\n```');
    expect(blocks.map(block => block.type)).toEqual(['heading', 'paragraph', 'rule', 'code']);
    expect(blocks[1]).toEqual({ type: 'paragraph', runs: [{ text: 'Текст із ' }, { text: 'кодом', code: true }, { text: ' і ' }, { text: 'посиланням', link: 'https://example.com' }, { text: '.' }] });
  });
});
