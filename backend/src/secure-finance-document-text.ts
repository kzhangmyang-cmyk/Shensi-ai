import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import yauzl from 'yauzl';
import sax from 'sax';

export type FinanceTextCell = (
  | { sourceRef: string; page: number; item: number; text: string }
  | { sourceRef: string; paragraph: number; text: string }
  | { sourceRef: string; table: number; row: number; column: number; text: string }
) & { segment?: number; startOffset?: number; endOffset?: number };
export interface FinanceTextDocumentResult { fileHash: string; cells: FinanceTextCell[]; uncertain: string[] }
export class FinanceDocumentTextError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'FinanceDocumentTextError'; }
}
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LIMIT = 'finance_document_limit_exceeded';
const INVALID = 'finance_document_artifact_invalid';
const UNAVAILABLE = 'finance_document_text_unavailable';
function fail(code: string): never { throw new FinanceDocumentTextError(code); }

/** Only local bytes enter the bounded parser worker; neither URLs nor credentials are accepted. */
export async function inspectFinanceTextDocument(input: { content: Buffer; mediaType: string; signal?: AbortSignal }): Promise<FinanceTextDocumentResult> {
  input.signal?.throwIfAborted();
  if (input.mediaType !== PDF && input.mediaType !== DOCX) fail('finance_document_format_unsupported');
  if (!Buffer.isBuffer(input.content) || !input.content.length) fail(INVALID);
  if (input.content.length > 5 * 1024 * 1024) fail(LIMIT);
  const data = { financeTextWorker: true, content: input.content, mediaType: input.mediaType, moduleURL: import.meta.url };
  const development = import.meta.url.endsWith('.ts');
  const loader = development ? pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href : '';
  const worker = new Worker(development
    ? `import(${JSON.stringify(loader)}).then(({tsImport}) => tsImport(require('node:worker_threads').workerData.moduleURL, require('node:worker_threads').workerData.moduleURL));`
    : new URL(import.meta.url), {
    eval: development, workerData: data, env: {}, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    stdout: true, stderr: true
  });
  // Parser diagnostics can contain document text; never forward them to application logs.
  worker.stdout?.resume(); worker.stderr?.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: FinanceTextDocumentResult) => {
      if (settled) return; settled = true; clearTimeout(timer);
      input.signal?.removeEventListener('abort', aborted);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const aborted = () => finish(input.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new FinanceDocumentTextError(LIMIT)), 10_000);
    worker.once('error', () => finish(new FinanceDocumentTextError(LIMIT)));
    worker.once('exit', () => finish(new FinanceDocumentTextError(INVALID)));
    worker.once('message', (message) => message.error
      ? finish(new FinanceDocumentTextError(message.error)) : finish(undefined, message.result));
    input.signal?.addEventListener('abort', aborted, { once: true });
    if (input.signal?.aborted) aborted();
  });
}

async function parse(content: Buffer, mediaType: string): Promise<FinanceTextDocumentResult> {
  const cells: FinanceTextCell[] = []; const uncertain = new Set<string>();
  const add = (cell: FinanceTextCell) => {
    if (!cell.text.trim()) return;
    if (cell.text.length > 500) {
      uncertain.add('document_text_segmented');
      let startOffset = 0; let segment = 0;
      while (startOffset < cell.text.length) {
        if (cells.length >= 2000) { uncertain.add('inspection_truncated'); break; }
        let endOffset = Math.min(startOffset + 500, cell.text.length);
        if (endOffset < cell.text.length) {
          const window = cell.text.slice(startOffset, endOffset);
          const boundary = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'), window.lastIndexOf('\t'));
          if (boundary >= 250) endOffset = startOffset + boundary + 1;
          if (/[\uD800-\uDBFF]/u.test(cell.text[endOffset - 1])) endOffset--;
        }
        cells.push({ ...cell, sourceRef: `${cell.sourceRef}:s:${++segment}`, segment, startOffset, endOffset,
          text: cell.text.slice(startOffset, endOffset) });
        startOffset = endOffset;
      }
      return;
    }
    if (cells.length >= 2000) { uncertain.add('inspection_truncated'); return; }
    cells.push(cell);
  };
  if (mediaType === PDF) {
    if (content.subarray(0, 5).toString() !== '%PDF-') fail(INVALID);
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const packageRoot = new URL('./', pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')));
    // All auxiliary assets are installed package files, never document-supplied paths.
    const task = pdf.getDocument({ data: new Uint8Array(content),
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, stopAtErrors: true,
      cMapUrl: fileURLToPath(new URL('cmaps/', packageRoot)), cMapPacked: true,
      standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', packageRoot)),
      verbosity: 0 });
    try {
      const document = await task.promise;
      if (document.numPages > 100) fail(LIMIT);
      uncertain.add('pdf_text_layout_unverified');
      for (let page = 1; page <= document.numPages; page++) {
        const source = await document.getPage(page); let hasText = false;
        const text = await source.getTextContent();
        text.items.forEach((item, index) => {
          if ('str' in item && item.str.trim()) {
            hasText = true; add({ sourceRef: `pdf:${page}:${index + 1}`, page, item: index + 1, text: item.str });
          }
        });
        if (!hasText) uncertain.add('pdf_pages_without_text');
        source.cleanup();
      }
    } catch (error) {
      if (error instanceof FinanceDocumentTextError) throw error;
      if (error instanceof Error && error.name === 'PasswordException') fail('finance_document_encrypted');
      fail(INVALID);
    } finally { await task.destroy(); }
  } else {
    const xml = await docxXml(content);
    readDocx(xml, add, uncertain);
  }
  if (!cells.length) fail(UNAVAILABLE);
  return { fileHash: `sha256:${createHash('sha256').update(content).digest('hex')}`, cells, uncertain: [...uncertain] };
}

async function docxXml(content: Buffer): Promise<string> {
  if (content.readUInt32LE(0) !== 0x04034b50) fail(INVALID);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(content,
    { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
    (error, result) => error ? reject(error) : resolve(result)));
  return new Promise((resolve, reject) => {
    let count = 0; let total = 0; let main: string | undefined; let types: string | undefined;
    const names = new Set<string>(); let settled = false;
    const stop = (error: unknown) => { if (settled) return; settled = true; zip.close(); reject(error); };
    zip.on('error', stop);
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        if (++count > 1000 || (total += entry.uncompressedSize) > 20 * 1024 * 1024) fail(LIMIT);
        if (entry.isEncrypted()) fail('finance_document_encrypted');
        if (names.has(entry.fileName)) fail(INVALID);
        names.add(entry.fileName);
        if (entry.fileName !== 'word/document.xml' && entry.fileName !== '[Content_Types].xml') { zip.readEntry(); return; }
        if (entry.uncompressedSize > 4 * 1024 * 1024) fail(LIMIT);
        zip.openReadStream(entry, (error, stream) => {
          if (error) { stop(error); return; }
          const chunks: Buffer[] = []; let bytes = 0;
          stream.on('error', stop);
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) { stream.destroy(); stop(new FinanceDocumentTextError(LIMIT)); }
            else chunks.push(chunk);
          });
          stream.on('end', () => {
            try {
              const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
              if (entry.fileName === 'word/document.xml') main = value; else types = value;
              zip.readEntry();
            } catch (failure) { stop(failure); }
          });
        });
      } catch (error) { stop(error); }
    });
    zip.on('end', () => {
      if (settled) return;
      try {
        if (!main || !types) fail(INVALID);
        let valid = false;
        const parser = xmlParser();
        parser.onopentag = node => {
          const tag = node as sax.QualifiedTag;
          if (tag.uri === 'http://schemas.openxmlformats.org/package/2006/content-types' && tag.local === 'Override'
            && attribute(tag, 'PartName') === '/word/document.xml'
            && attribute(tag, 'ContentType') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') valid = true;
        };
        parser.write(types).close();
        if (!valid) fail(INVALID);
        settled = true; resolve(main);
      } catch (error) { stop(error); }
    });
    zip.readEntry();
  });
}
function xmlParser() {
  const options = { xmlns: true, strictEntities: true };
  const parser = sax.parser(true, options);
  parser.ondoctype = () => fail(INVALID);
  parser.onsgmldeclaration = () => fail(INVALID);
  parser.onerror = () => fail(INVALID);
  return parser;
}
function attribute(tag: sax.QualifiedTag, local: string) {
  return Object.values(tag.attributes).find(value => value.local === local)?.value;
}
function readDocx(xml: string, add: (cell: FinanceTextCell) => void, uncertain: Set<string>) {
  const parser = xmlParser(); const stack: Array<{ local: string; word: boolean }> = [];
  const wordNamespaces = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
  let paragraph = 0; let table = 0; let tableDepth = 0; let row = 0; let column = 0;
  let text = ''; let collecting: 'paragraph' | 'cell' | null = null; let body = false; let document = false;
  let ignoredDepth = 0;
  uncertain.add('docx_main_document_only');
  // Header/footer, comments, footnotes, images, embedded objects and field instructions are not followed.
  parser.onopentag = node => {
    const tag = node as sax.QualifiedTag; const word = wordNamespaces.has(tag.uri);
    stack.push({ local: tag.local, word });
    if (stack.length > 128) fail(LIMIT);
    if (stack.length === 1) { if (!word || tag.local !== 'document') fail(INVALID); document = true; }
    if (word && tag.local === 'body') body = true;
    if (!body) return;
    if (ignoredDepth) { ignoredDepth++; return; }
    if (word && ['drawing', 'pict', 'object', 'del', 'txbxContent', 'altChunk'].includes(tag.local)) {
      ignoredDepth = 1; uncertain.add('docx_non_body_content_omitted'); return;
    }
    if (!word) return;
    if (['fldSimple', 'fldChar', 'instrText'].includes(tag.local)) uncertain.add('docx_field_cache_unverified');
    if (tag.local === 'tbl') {
      tableDepth++;
      if (tableDepth > 1) { uncertain.add('docx_nested_table_omitted'); ignoredDepth = 1; tableDepth--; return; }
      table++; row = 0; column = 0;
    }
    if (tag.local === 'tr' && tableDepth) { row++; column = 0; }
    if (tag.local === 'tc' && tableDepth) { column++; text = ''; collecting = 'cell'; }
    if (tag.local === 'p' && !tableDepth) { paragraph++; text = ''; collecting = 'paragraph'; }
    if (['gridSpan', 'vMerge', 'hMerge'].includes(tag.local)) uncertain.add('docx_table_merge_layout_unverified');
    if (['br', 'tab'].includes(tag.local) && collecting) text += tag.local === 'br' ? '\n' : '\t';
  };
  parser.ontext = value => {
    const current = stack.at(-1);
    if (!ignoredDepth && collecting && current?.word && current.local === 't') text += value;
  };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => {
    const tag = stack.pop()!;
    if (ignoredDepth) { ignoredDepth--; return; }
    if (!tag.word || !body) return;
    if (tag.local === 'p' && collecting === 'paragraph') {
      add({ sourceRef: `docx:p:${paragraph}`, paragraph, text }); collecting = null;
    } else if (tag.local === 'p' && collecting === 'cell') text += '\n';
    if (tag.local === 'tc' && collecting === 'cell') {
      add({ sourceRef: `docx:t:${table}:${row}:${column}`, table, row, column, text: text.replace(/\n$/u, '') }); collecting = null;
    }
    if (tag.local === 'tbl') tableDepth--;
    if (tag.local === 'body') body = false;
  };
  parser.write(xml).close();
  if (!document) fail(INVALID);
}

if (!isMainThread && workerData?.financeTextWorker === true) {
  void parse(Buffer.from(workerData.content), workerData.mediaType).then(
    result => parentPort!.postMessage({ result }),
    error => parentPort!.postMessage({ error: error instanceof FinanceDocumentTextError ? error.code : INVALID })
  );
}
