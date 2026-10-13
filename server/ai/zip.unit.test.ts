import { describe, expect, it } from 'vitest';
import { extractArchiveText, parseAnswerFiles, renderAttachment, safeArchivePath } from './files.js';
import { createZip, crc32, readZipEntries, readZipEntry, ZipFormatError } from './zip.js';

describe('ZIP reading and writing', () => {
  it('writes a standard archive that reads back with UTF-8 names and text', () => {
    const zip = createZip([
      { path: 'src/app.js', content: "console.log('привіт');\n" },
      { path: 'Документи/README.md', content: '# Проєкт\n' }
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map(entry => entry.path)).toEqual(['src/app.js', 'Документи/README.md']);
    expect(readZipEntry(zip, entries[0]!, 1024).toString('utf8')).toBe("console.log('привіт');\n");
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
  });

  it('keeps text files and explains every file it leaves out', () => {
    const zip = createZip([
      { path: 'src/main.py', content: 'print("ok")\n' },
      { path: 'node_modules/lib/index.js', content: 'module.exports = 1;' },
      { path: 'logo.png', content: 'not really a png' },
      { path: 'package-lock.json', content: '{}' },
      { path: '.env', content: 'SECRET=1' },
      { path: '.env.example', content: 'SECRET=' },
      { path: 'empty.txt', content: '' },
      { path: '../escape.txt', content: 'x' },
      { path: '/etc/passwd', content: 'x' },
      { path: '__MACOSX/._main.py', content: 'x' },
      { path: 'notes/', content: '' }
    ]);
    const { files, skipped } = extractArchiveText(zip);
    expect(files.map(file => file.path)).toEqual(['src/main.py', '.env.example']);
    const reasons = Object.fromEntries(skipped.map(item => [item.path, item.reason]));
    expect(reasons).toMatchObject({
      'node_modules/lib/index.js': 'службова папка',
      'logo.png': 'двійковий або згенерований файл (.png)',
      'package-lock.json': 'lock-файл залежностей',
      '.env': 'файл із секретами',
      'empty.txt': 'порожній файл',
      '../escape.txt': 'небезпечний шлях',
      '/etc/passwd': 'небезпечний шлях',
      '__MACOSX/._main.py': 'службова папка'
    });
    const text = renderAttachment('project.zip', files, skipped);
    expect(text).toContain('--- файл: src/main.py ---\nprint("ok")\n\n--- кінець файлу ---');
    expect(text).toContain('logo.png (двійковий або згенерований файл (.png))');
  });

  it('never inflates past the limit, even when the archive lies about a file size', () => {
    const big = 'a'.repeat(3 * 1024 * 1024);
    const honest = createZip([{ path: 'big.txt', content: big }]);
    expect(honest.length).toBeLessThan(20_000);
    expect(extractArchiveText(honest).skipped).toEqual([{ path: 'big.txt', reason: 'файл завеликий' }]);

    // Rewrite the declared size in the central directory to look small: decompression must still stop.
    const lying = Buffer.from(honest);
    const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lying.writeUInt32LE(10, central + 24);
    expect(() => readZipEntry(lying, readZipEntries(lying)[0]!, 1024 * 1024)).toThrow(ZipFormatError);
    expect(extractArchiveText(lying).skipped[0]).toMatchObject({ path: 'big.txt', reason: 'файл завеликий' });
  });

  it('skips binary content, encrypted entries and rejects non-archives', () => {
    const binary = createZip([{ path: 'data.txt', content: 'ok\u0000binary' }]);
    expect(extractArchiveText(binary).skipped[0]).toMatchObject({ reason: 'не текстовий файл' });
    const encrypted = Buffer.from(createZip([{ path: 'secret.txt', content: 'x' }]));
    encrypted.writeUInt16LE(encrypted.readUInt16LE(encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8) | 1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(extractArchiveText(encrypted).skipped[0]).toMatchObject({ reason: 'файл зашифровано' });
    expect(() => readZipEntries(Buffer.from('%PDF-1.7 not a zip at all, just text'))).toThrow(ZipFormatError);
  });

  it('accepts only relative paths that stay inside the archive', () => {
    expect(safeArchivePath('src\\app.js')).toBe('src/app.js');
    expect(safeArchivePath('./a/b.txt')).toBe('a/b.txt');
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:/win', '', 'a\u0000b']) expect(safeArchivePath(bad), bad).toBeNull();
  });
});

describe('files in model answers', () => {
  it('reads code blocks that name a path and ignores plain examples', () => {
    const answer = [
      'Ось проєкт:',
      '```js src/app.js',
      "console.log('a');",
      '```',
      '```python:tools/run.py',
      'print(1)',
      '```',
      '```html title="index.html"',
      '<h1>Привіт</h1>',
      '```',
      '```js',
      'const example = true;',
      '```',
      '```node.js',
      'const notAPath = 1;',
      '```',
      '```js ../../etc/passwd',
      'nope',
      '```',
      '```js src/app.js',
      "console.log('b');",
      '```',
      '```js unclosed.js',
      'never closed'
    ].join('\n');
    expect(parseAnswerFiles(answer)).toEqual([
      { path: 'src/app.js', content: "console.log('b');\n" },
      { path: 'tools/run.py', content: 'print(1)\n' },
      { path: 'index.html', content: '<h1>Привіт</h1>\n' }
    ]);
    expect(parseAnswerFiles('Звичайна відповідь без файлів.')).toEqual([]);
  });
});
