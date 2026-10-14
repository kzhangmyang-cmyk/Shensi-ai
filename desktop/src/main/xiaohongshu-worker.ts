import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Main-only transport. Executable, arguments and approved commands never come from Renderer.
export function createXhsWorker(options: { executable: string; args: string[]; cwd: string }) {
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' },
  });
  let stopped = false;
  let isReady = false;
  let buffer = Buffer.alloc(0);
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const startupTimer = setTimeout(() => fail('xhs_worker_start_timeout'), 20_000);
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  function terminate(signal: NodeJS.Signals) {
    if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Group already exited. */ } }
  }
  function fail(code: string) {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    rejectReady(new Error(code));
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(code)); }
    pending.clear();
    child.stdin.destroy();
    terminate('SIGTERM');
  }
  child.stderr.resume(); // Deliberately do not retain upstream/browser error text.
  child.on('error', () => { fail('xhs_worker_disconnected'); resolveExit(); });
  child.on('exit', () => { fail('xhs_worker_disconnected'); resolveExit(); });
  child.stdin.on('error', () => fail('xhs_worker_disconnected'));
  child.stdout.on('data', (chunk: Buffer) => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > 65536) fail('xhs_worker_protocol_failed'); return; }
      if (end > 65536) { fail('xhs_worker_protocol_failed'); return; }
      const line = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { fail('xhs_worker_protocol_failed'); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('xhs_worker_protocol_failed'); return; }
      const message = value as Record<string, unknown>;
      if (!isReady && Object.keys(message).length === 1 && message.event === 'ready') {
        isReady = true; clearTimeout(startupTimer); resolveReady(); continue;
      }
      if (!isReady || typeof message.id !== 'string' || !pending.has(message.id)
        || Object.keys(message).length !== 2 || (('result' in message) === ('error' in message))) {
        fail('xhs_worker_protocol_failed'); return;
      }
      const entry = pending.get(message.id)!;
      pending.delete(message.id); clearTimeout(entry.timer);
      if ('error' in message) {
        const allowed = new Set(['invalid_request','worker_busy','worker_operation_failed','login_not_open',
          'login_already_open','login_origin_changed','im_state_not_ready','sending_disabled','account_busy',
          'session_not_owned','session_not_ready','command_not_executable','command_conflict','message_id_reused']);
        entry.reject(new Error(typeof message.error === 'string' && allowed.has(message.error)
          ? `xhs_${message.error}` : 'xhs_worker_operation_failed'));
      } else { entry.resolve(message.result); }
    }
  });
  return {
    ready,
    async request(input: { operation: 'open' | 'connect' | 'close'; accountId: string } | { operation: 'execute'; command: unknown }): Promise<unknown> {
      await ready;
      if (stopped) throw new Error('xhs_worker_disconnected');
      if (pending.size >= 32) throw new Error('xhs_worker_busy');
      const id = randomUUID();
      const line = JSON.stringify({ ...input, id }) + '\n';
      if (Buffer.byteLength(line) > 65536) throw new Error('xhs_invalid_request');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail('xhs_worker_request_timeout'), 65_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(line, error => { if (error) fail('xhs_worker_disconnected'); });
      });
    },
    async close() {
      if (!stopped) child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(() => { terminate('SIGKILL'); resolve(); }, 8_000); })]);
      if (timer) clearTimeout(timer);
      fail('xhs_worker_disconnected');
    },
  };
}
