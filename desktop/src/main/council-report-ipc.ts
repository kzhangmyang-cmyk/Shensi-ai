import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserWindow, BrowserWindowConstructorOptions, SaveDialogOptions, SaveDialogReturnValue } from 'electron';
import { COUNCIL_REPORT_CHANNEL, validateCouncilReportRequest, type CouncilReportResult } from '../shared/council-report.ts';

interface Sender { mainFrame: { url?: string }; isDestroyed(): boolean }
interface Event { sender?: unknown; senderFrame?: { url?: string } | null }
interface Options {
  localOrigin: string;
  authorizedSender(): Sender | undefined;
  ipcMain: { handle(channel: string, handler: (event: Event, value: unknown) => Promise<CouncilReportResult>): void; removeHandler(channel: string): void };
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  writeFile(filePath: string, bytes: Uint8Array): Promise<unknown>;
}
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

export function registerCouncilReportIpc(options: Options): { dispose(): void } {
  const origin = new URL(options.localOrigin).origin;
  let disposed = false; let busy = false;
  const active = new Set<BrowserWindow>();
  const authorize = (event: Event) => {
    if (disposed) throw new Error('council_report_ipc_disposed');
    const sender = options.authorizedSender();
    let local = false;
    try { local = new URL(event.senderFrame?.url ?? '').origin === origin; } catch { /* Fail closed. */ }
    if (!sender || sender.isDestroyed() || sender !== event.sender || sender.mainFrame !== event.senderFrame || !local)
      throw new Error('council_report_sender_not_local');
  };
  options.ipcMain.handle(COUNCIL_REPORT_CHANNEL, async (event, raw) => {
    authorize(event);
    const request = validateCouncilReportRequest(raw);
    if (busy) throw new Error('council_report_export_busy');
    busy = true;
    let printable: BrowserWindow | undefined;
    try {
      const target = await options.showSaveDialog({ title: '导出财务议事报告 PDF', defaultPath: request.filename,
        filters: [{ name: 'PDF', extensions: ['pdf'] }], properties: ['showOverwriteConfirmation'] });
      if (target.canceled || !target.filePath) return { status: 'cancelled' };
      authorize(event);
      printable = options.createWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
        nodeIntegration: false, javascript: false, webSecurity: true, partition: `council-report-${randomUUID()}` } });
      active.add(printable);
      const contents = printable.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', event => event.preventDefault());
      contents.on('will-redirect', event => event.preventDefault());
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const html = request.html.replace(/<head\s*>/i, `<head><meta http-equiv="Content-Security-Policy" content="${CSP}">`);
      const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url }));
      await printable.loadURL(url);
      const bytes = await contents.printToPDF({ printBackground: true, pageSize: 'A4', preferCSSPageSize: true });
      authorize(event);
      await options.writeFile(target.filePath, bytes);
      return { status: 'saved', fileName: path.basename(target.filePath) };
    } catch { throw new Error('council_report_export_failed'); }
    finally {
      if (printable) { active.delete(printable); if (!printable.isDestroyed()) printable.close(); }
      busy = false;
    }
  });
  return { dispose() {
    if (disposed) return;
    disposed = true; options.ipcMain.removeHandler(COUNCIL_REPORT_CHANNEL);
    for (const window of active) if (!window.isDestroyed()) window.close();
    active.clear();
  } };
}
