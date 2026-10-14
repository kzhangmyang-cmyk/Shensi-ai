import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IpcMain, WebContents } from 'electron';
import { CAPTURE_MAX_BYTES, ENTERPRISE_CAPTURE_CHANNEL, ENTERPRISE_OPEN_CHANNEL, ENTERPRISE_LOCAL_CAPTURE_CHANNEL, ENTERPRISE_QUERY_CHANNEL, ENTERPRISE_SEARCH_CHANNEL, validateEnterpriseCapture } from '../shared/enterprise-browser.ts';
import type { createEnterpriseLocalBrowser } from './enterprise-local-browser.ts';
import {ENTERPRISE_NEXT_CHANNEL} from '../shared/enterprise-browser.ts';

export function registerEnterpriseBrowserIpc(options: { ipcMain: IpcMain; localOrigin: string; sender(): WebContents | undefined; local?: ReturnType<typeof createEnterpriseLocalBrowser> }) {
  function authorize(event: Electron.IpcMainInvokeEvent) {
    const sender = options.sender();
    if (!sender || event.sender !== sender || event.senderFrame !== sender.mainFrame
      || new URL(event.senderFrame.url).origin !== options.localOrigin) throw new Error('企业预览调用来源无效');
  }
  options.ipcMain.handle(ENTERPRISE_OPEN_CHANNEL, async (event, keyword:unknown) => { authorize(event); if (!options.local) throw new Error('内置浏览器不可用'); await options.local.open(keyword); });
  options.ipcMain.handle(ENTERPRISE_LOCAL_CAPTURE_CHANNEL, async event => { authorize(event); if (!options.local) throw new Error('内置浏览器不可用'); return options.local.capture(); });
  options.ipcMain.handle(ENTERPRISE_QUERY_CHANNEL, async(event, query:unknown)=>{authorize(event);if(!options.local)throw new Error('内置浏览器不可用');return options.local.query(query);});
  options.ipcMain.handle(ENTERPRISE_SEARCH_CHANNEL, async(event, keyword:unknown)=>{authorize(event);if(!options.local)throw new Error('内置浏览器不可用');return options.local.search(keyword);});
  options.ipcMain.handle(ENTERPRISE_NEXT_CHANNEL, async(event,batchId:unknown)=>{authorize(event);if(!options.local)throw new Error('内置浏览器不可用');return options.local.next(batchId);});
  options.ipcMain.handle(ENTERPRISE_CAPTURE_CHANNEL, async event => {
    authorize(event);
    const filename = path.join(homedir(), 'Library/Application Support/ShensiEnterpriseBridge/preview.json');
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new Error('尚无浏览器预览，请先点击Chrome扩展发送当前页'); });
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > CAPTURE_MAX_BYTES) throw new Error('企业预览文件权限或大小无效');
      return validateEnterpriseCapture(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  });
  return { dispose: () => { for (const channel of [ENTERPRISE_CAPTURE_CHANNEL, ENTERPRISE_OPEN_CHANNEL, ENTERPRISE_LOCAL_CAPTURE_CHANNEL, ENTERPRISE_QUERY_CHANNEL, ENTERPRISE_SEARCH_CHANNEL,ENTERPRISE_NEXT_CHANNEL]) options.ipcMain.removeHandler(channel); options.local?.dispose(); } };
}
