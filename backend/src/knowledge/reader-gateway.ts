import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { parsedKnowledgeSchema, KNOWLEDGE_MAX_BYTES, type ParsedKnowledge, type KnowledgeUploadInput } from './domain.js';

export interface KnowledgeReaderInput { inputPath: string; format: KnowledgeUploadInput['format']; bytes: number; }
export interface KnowledgeReader { read(input: KnowledgeReaderInput, signal: AbortSignal): Promise<ParsedKnowledge>; }
export function knowledgeReaderEnvironment(): NodeJS.ProcessEnv {
  return { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: '2' };
}
const execute = promisify(execFile), OUTPUT_LIMIT = 64 * 1024 * 1024;
export function createKnowledgeReader(options: { python?: string; script?: string; maxDurationMs?: number; maxRssMiB?: number }): KnowledgeReader {
  let runtime: Promise<{ python: string; script: string; prefix: string }> | undefined;
  async function prepare() {
    if (!options.python || !options.script || !isAbsolute(options.python) || !isAbsolute(options.script)) throw new Error('knowledge_reader_unavailable');
    const python = await realpath(options.python), script = await realpath(options.script);
    for (const path of [python, script]) {
      const info = await lstat(path);
      if (!info.isFile() || info.mode & 0o022 || ![0, process.getuid?.()].includes(info.uid)) throw new Error('knowledge_reader_unavailable');
    }
    // Trusted interpreter only, no document supplied to this bounded probe.
    const probe = await execute(python, ['-I', '-B', '-c', 'import sys,json;from importlib.metadata import version;print(json.dumps({"prefix":sys.base_prefix,"packages":{k:version(k) for k in ["pypdfium2","Pillow","openpyxl","ocrmac"]}}))'],
      { env: knowledgeReaderEnvironment(), timeout: 5000, maxBuffer: 4096 });
    const value = JSON.parse(probe.stdout), prefix = value.prefix;
    if (typeof prefix !== 'string' || !isAbsolute(prefix) || value.packages.pypdfium2 !== '5.14.0' || value.packages.Pillow !== '12.3.0'
      || value.packages.openpyxl !== '3.1.5' || value.packages.ocrmac !== '1.0.1') throw new Error('knowledge_reader_unavailable');
    return { python, script, prefix };
  }
  return { async read(input, signal) {
    if (signal.aborted) throw new Error('knowledge_reader_cancelled');
    let ready: Awaited<ReturnType<typeof prepare>>;
    try { ready = await (runtime ??= prepare()); } catch { runtime = undefined; throw new Error('knowledge_reader_unavailable'); }
    if (!isAbsolute(input.inputPath) || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > KNOWLEDGE_MAX_BYTES) throw new Error('knowledge_artifact_invalid');
    const info = await lstat(input.inputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size !== input.bytes) throw new Error('knowledge_artifact_invalid');
    if (signal.aborted) throw new Error('knowledge_reader_cancelled');
    const inputPath = await realpath(input.inputPath), scratch = dirname(inputPath), quote = JSON.stringify;
    const profile = `(version 1)(allow default)(deny network*)(deny process-fork)(deny process-exec)
      (deny file-write*)(deny file-read*)(allow file-read-metadata)
      (allow process-exec (literal ${quote(ready.python)}))
      (allow file-read* (literal ${quote(inputPath)}) (literal ${quote(ready.script)})
        (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/private/etc") (subpath "/dev")
        (subpath ${quote(dirname(dirname(ready.python)))}) (subpath ${quote(ready.prefix)}))
      (allow file-write* (subpath ${quote(scratch)}))`;
    // macOS local target: OS sandbox blocks network, user secrets and unrelated
    // files, not merely environment inheritance. No shell or child plugins.
    if (process.platform !== 'darwin') throw new Error('knowledge_reader_unavailable');
    const command = '/usr/bin/sandbox-exec', args = ['-p', profile, ready.python, '-I', '-B', ready.script];
    return new Promise<ParsedKnowledge>((resolve, reject) => {
      const child = spawn(command, args, { env: { ...knowledgeReaderEnvironment(), TMPDIR: scratch,
        MPLCONFIGDIR: `${scratch}/matplotlib`, XDG_CACHE_HOME: `${scratch}/cache` }, stdio: ['pipe', 'pipe', 'pipe'] });
      let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined, monitoring = false, bytes = 0;
      const chunks: Buffer[] = [];
      const stop = (code: string) => {
        if (failure) return; failure = new Error(code); child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      };
      const abort = () => stop('knowledge_reader_cancelled');
      const deadline = setTimeout(() => stop('knowledge_reader_limit'), options.maxDurationMs ?? 60 * 60_000);
      const watchdog = setInterval(() => {
        if (!child.pid || monitoring || failure) return; monitoring = true;
        void execute('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { env: {}, timeout: 1000, maxBuffer: 1024 })
          .then(value => { if (Number(value.stdout.trim()) > (options.maxRssMiB ?? 1536) * 1024) stop('knowledge_reader_limit'); })
          .catch(() => {}).finally(() => { monitoring = false; });
      }, 1000);
      child.stderr.resume(); // no parser diagnostics, paths or document text in logs
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > OUTPUT_LIMIT) stop('knowledge_reader_limit'); else if (!failure) chunks.push(chunk);
      });
      child.on('error', () => stop('knowledge_reader_unavailable')); child.stdin.on('error', () => {});
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      child.stdin.end(JSON.stringify({ ...input, inputPath }));
      child.once('close', code => {
        clearTimeout(deadline); clearTimeout(killTimer); clearInterval(watchdog); signal.removeEventListener('abort', abort);
        if (failure) { reject(failure); return; }
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!message.ok && /^knowledge_[a-z0-9_]{1,60}$/u.test(message.code)) throw new Error(message.code);
          if (code !== 0 || message.ok !== true) throw new Error('knowledge_reader_invalid');
          const parsed = parsedKnowledgeSchema.safeParse(message.result);
          if (!parsed.success) throw new Error('knowledge_reader_invalid'); resolve(parsed.data);
        } catch (error) { reject(error instanceof Error && /^knowledge_/u.test(error.message) ? error : new Error('knowledge_reader_invalid')); }
      });
    });
  } };
}
