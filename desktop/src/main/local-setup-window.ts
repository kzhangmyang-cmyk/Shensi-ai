import { randomBytes } from 'node:crypto';
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain } from 'electron';
import { parseLocalInitialAccount, type LocalInitialAccount } from './local-initial-account.js';

export function requestLocalInitialAccount(options: {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  ipcMain: IpcMain; preloadPath: string;
}): Promise<LocalInitialAccount | null> {
  const window = options.createWindow({ width: 620, height: 720, minWidth: 360, minHeight: 580,
    title: 'Shensi · 首次设置', backgroundColor: '#f4f7fd',
    webPreferences: { preload: options.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const nonce = randomBytes(24).toString('base64');
  let account: LocalInitialAccount | null = null;
  options.ipcMain.handle('shensi:local:initial-account', (event, input: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || account)
      return { ok: false, message: '此设置请求已失效，请重新打开应用。' };
    try { account = parseLocalInitialAccount(input); }
    catch { return { ok: false, message: '请检查账号格式，并使用至少12位密码。' }; }
    setTimeout(() => { if (!window.isDestroyed()) window.close(); }, 0);
    return { ok: true };
  });
  return new Promise((resolve, reject) => {
    window.once('closed', () => { options.ipcMain.removeHandler('shensi:local:initial-account'); resolve(account); });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(localSetupHtml(nonce))}`).catch(() => {
      options.ipcMain.removeHandler('shensi:local:initial-account'); reject(new Error('local_setup_window_failed')); window.destroy();
    });
  });
}

export function localSetupHtml(nonce: string): string {
  if (!/^[A-Za-z0-9+/=]+$/u.test(nonce)) throw new Error('local_setup_nonce_invalid');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>Shensi · 首次设置</title><style nonce="${nonce}">
:root{color-scheme:light;--bg:#f4f7fd;--panel:#fff;--text:#172d4c;--muted:#526680;--line:#bccce2;--accent:#185bd5;--on:#fff;--error:#b22222}
:root[data-theme=dark]{color-scheme:dark;--bg:#101513;--panel:#19221e;--text:#e9f4ec;--muted:#b4c5ba;--line:#567263;--accent:#99edb0;--on:#112419;--error:#ffb1a8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;padding:28px}main{max-width:450px;margin:auto}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}header strong{font-size:23px;letter-spacing:1px}button,input{font:inherit}
button{cursor:pointer;border-radius:10px;padding:9px 14px;border:1px solid var(--line);background:var(--panel);color:var(--text)}h1{font-size:27px;line-height:1.3;margin:0 0 12px}p{color:var(--muted);margin:0 0 22px}
form{padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:16px}label{display:block;font-weight:600;margin:0 0 7px}input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}input:focus-visible,button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.field{margin-bottom:18px}.hint{font-size:12px;color:var(--muted);margin-top:5px}.submit{width:100%;background:var(--accent);color:var(--on);border-color:var(--accent);font-weight:650}.submit:disabled{opacity:.65;cursor:wait}#error{color:var(--error);min-height:24px;font-size:14px;margin-bottom:10px}.footer{font-size:13px;margin-top:18px}@media(max-width:420px){body{padding:18px}form{padding:18px}h1{font-size:24px}header{margin-bottom:20px}}
</style></head><body><main><header><strong>SHENSI</strong><button id="theme" type="button" aria-label="切换主题">深色外观</button></header>
<h1>设置你的本机账号</h1><p>只需设置一次。账号和业务数据保存在这台电脑。</p>
<form id="setup"><div class="field"><label for="account">账号</label><input id="account" name="account" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z][A-Za-z0-9_.-]{2,31}" autofocus><div class="hint">3–32位，以字母开头，可使用数字、下划线、点和短横线。</div></div>
<div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="128"><div class="hint">至少12位，建议组合使用字母、数字和符号。</div></div>
<div class="field"><label for="confirm">确认密码</label><input id="confirm" type="password" autocomplete="new-password" required minlength="12" maxlength="128"></div>
<div id="error" role="alert" aria-live="polite"></div><button class="submit" id="submit" type="submit">创建账号并继续</button></form>
<p class="footer">进入后可在设置中配置你自己的模型 API。关闭此窗口可取消本次设置。</p></main>
<script nonce="${nonce}">
const theme=document.getElementById('theme');theme.onclick=()=>{const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';theme.textContent=dark?'浅色外观':'深色外观'};
document.getElementById('setup').onsubmit=async event=>{event.preventDefault();const error=document.getElementById('error'),button=document.getElementById('submit');error.textContent='';const password=document.getElementById('password').value;if(password!==document.getElementById('confirm').value){error.textContent='两次输入的密码不一致。';return}button.disabled=true;button.textContent='正在准备…';try{const result=await window.shensiInitialSetup.submit({account:document.getElementById('account').value,password});if(!result.ok)throw new Error(result.message)}catch(e){error.textContent=e.message||'设置未完成，请重试。';button.disabled=false;button.textContent='创建账号并继续'}};
</script></body></html>`;
}
