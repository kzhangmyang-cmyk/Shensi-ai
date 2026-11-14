import { UPDATE_CHANNELS } from "../shared/app-update.ts";
import type { PublicUpdateState } from "../shared/app-update.ts";

type Handler = (event: { senderFrame?: { url?: string } | null; sender?: unknown }) => unknown;
interface RendererSender { mainFrame: { url?: string }; send(channel: string, value: unknown): void; isDestroyed(): boolean; }

export function registerAppUpdateIpc(options: {
  localOrigin: string;
  ipcMain: { handle(channel: string, handler: Handler): void; removeHandler(channel: string): void };
  authorizedSender: () => RendererSender | undefined;
  service: {
    getState(): PublicUpdateState;
    check(): Promise<PublicUpdateState>;
    download(): Promise<PublicUpdateState>;
    cancel(): Promise<PublicUpdateState>;
    retry(): Promise<PublicUpdateState>;
    reveal(): Promise<PublicUpdateState>;
  };
}): { dispose(): void } {
  const origin = new URL(options.localOrigin).origin;
  const channels = [UPDATE_CHANNELS.getState, UPDATE_CHANNELS.check, UPDATE_CHANNELS.download,
    UPDATE_CHANNELS.cancel, UPDATE_CHANNELS.retry, UPDATE_CHANNELS.reveal];
  const authorize = (event: { senderFrame?: { url?: string } | null; sender?: unknown }) => {
    const sender = options.authorizedSender();
    let frameOrigin = "";
    try { frameOrigin = new URL(event.senderFrame?.url ?? "").origin; } catch { frameOrigin = ""; }
    if (!sender || sender.isDestroyed() || event.sender !== sender || event.senderFrame !== sender.mainFrame
      || frameOrigin !== origin) throw new Error("IPC sender is not local");
  };
  const methods = {
    [UPDATE_CHANNELS.getState]: () => options.service.getState(),
    [UPDATE_CHANNELS.check]: () => options.service.check(),
    [UPDATE_CHANNELS.download]: () => options.service.download(),
    [UPDATE_CHANNELS.cancel]: () => options.service.cancel(),
    [UPDATE_CHANNELS.retry]: () => options.service.retry(),
    [UPDATE_CHANNELS.reveal]: () => options.service.reveal()
  };
  for (const channel of channels) {
    options.ipcMain.handle(channel, (event) => {
      authorize(event);
      return methods[channel as keyof typeof methods]();
    });
  }
  return { dispose() { for (const channel of channels) options.ipcMain.removeHandler(channel); } };
}
