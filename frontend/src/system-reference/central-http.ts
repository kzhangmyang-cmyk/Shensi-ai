import { ReferenceApiError } from './api';

export type CentralFetch = (path: string, init?: RequestInit) => Promise<Response>;
/** Internal transport for fixed central-page routes, not an arbitrary URL API. */
export async function centralRequest(fetcher: CentralFetch, path: string, init: RequestInit, signal: AbortSignal, acknowledgement = false): Promise<unknown> {
  signal.throwIfAborted();
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const failed = () => new ReferenceApiError('reference_unavailable');
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(failed()); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const timer = setTimeout(abort, 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const operation = async () => {
    const response = await fetcher(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (controller.signal.aborted || response.redirected || !response.ok) {
      void response.body?.cancel().catch(() => {}); throw new ReferenceApiError('reference_unavailable', response.status);
    }
    if (acknowledgement) { void response.body?.cancel().catch(() => {}); if (response.status !== 204) throw failed(); return; }
    const length = response.headers.get('content-length');
    if (response.status !== 200 || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')
      || (length !== null && (!/^\d+$/u.test(length) || Number(length) > 262144))) { void response.body?.cancel().catch(() => {}); throw failed(); }
    reader = response.body?.getReader(); if (!reader) throw failed();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0, content = '';
    try {
      while (true) {
        const part = await reader.read(); controller.signal.throwIfAborted(); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > 262144) throw failed(); content += decoder.decode(part.value, { stream: true });
      }
      content += decoder.decode(); return JSON.parse(content) as unknown;
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  try { return await Promise.race([operation(), cancelled]); }
  catch (error) { if (error instanceof ReferenceApiError) throw error; throw failed(); }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort(); if (reader) void reader.cancel().catch(() => {});
  }
}
