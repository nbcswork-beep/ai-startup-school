// Runs inside the AI worker image (CI): proves the dependencies the worker loads only when it needs
// them are really there and work — every document format is made and read back, the tokenizer
// counts, the PNG encoder for capability probes works.
// Usage, from the folder that holds the build: node <path>/ai-worker-runtime-check.mjs [server-dist]
import { pathToFileURL } from 'node:url';
const root = new URL(`${process.argv[2] ?? 'server-dist'}/server/`, pathToFileURL(`${process.cwd()}/`));
const { renderFile } = await import(new URL('ai/documents/write.js', root));
const { extractDocument } = await import(new URL('ai/documents/read.js', root));
const { countTokens } = await import(new URL('ai/tokenizer.js', root));
const { probeImage } = await import(new URL('ai/probe-image.js', root));

const markdown = '# Фотосинтез\n\nКороткий конспект.\n\n## Що потрібно\n\n- світло\n- вода\n- вуглекислий газ\n\n| Речовина | Роль |\n|---|---|\n| Хлорофіл | поглинає світло |\n';
const results = [];
for (const format of ['docx', 'pdf', 'pptx', 'xlsx', 'csv', 'md', 'txt']) {
  const file = await renderFile({ title: 'Фотосинтез', content: markdown, format });
  if (!file.bytes?.length) throw new Error(`${format}: empty file`);
  let readBack = '';
  if (['docx', 'pdf', 'pptx', 'xlsx', 'csv'].includes(format)) {
    const document = await extractDocument(format, Buffer.from(file.bytes));
    readBack = JSON.stringify(document);
    // Cyrillic must survive the round trip in every format.
    if (!readBack.includes('Хлорофіл')) throw new Error(`${format}: read-back lost the text`);
  }
  results.push(`${format}:${file.bytes.length}`);
}
const tokens = await countTokens('Привіт, світ! Hello, world!');
if (!(tokens > 0)) throw new Error('tokenizer returned nothing');
const png = Buffer.from(probeImage(), 'base64');
if (png.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('probe image is not a PNG');
console.log(JSON.stringify({ ok: true, files: results, tokens, png: png.length }));
