import { createHash,randomUUID } from 'node:crypto';
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { CAPTURE_MAX_BYTES, validateEnterpriseCapture, validateEnterpriseQuery } from '../shared/enterprise-browser.ts';
import { enterpriseQueryPage } from './enterprise-query-page.ts';
import {enterprisePaginationPage} from './enterprise-pagination-page.ts';

export function allowedEnterpriseNavigation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['aiqicha.baidu.com', 'passport.baidu.com', 'wappass.baidu.com'].includes(url.hostname);
  } catch { return false; }
}

/** Owns only the isolated enterprise window; never reuses Chrome or the app session. */
export function createEnterpriseLocalBrowser(options: {
  authorize(): Promise<string>;
  captureScript: string;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
}) {
  let window: BrowserWindow | undefined;
  let owner = '';
  let epoch = 0;
  let checking = false;
  let querying = false;
  let batch:{id:string;actor:string;epoch:number;keyword:string;page:number;signature:string;pending:boolean}|undefined;
  async function pager(current:BrowserWindow,action:'inspect'|'next',page?:number){
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([current.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${enterprisePaginationPage.toString()})(${JSON.stringify(action)},${JSON.stringify(page??null)})`}]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('分页读取超时，已有结果保留，请重试读取本页')),10000);})]) as ReturnType<typeof enterprisePaginationPage>;}
    finally{if(timer)clearTimeout(timer);}
  }
  function close() { const old = window; window = undefined; owner = ''; epoch++; if (old && !old.isDestroyed()) old.close(); }
  async function identity() {
    try { const actor = await options.authorize(); if (!actor) throw new Error(); return actor; }
    catch { close(); throw new Error('请先登录 Shensi 账号'); }
  }
  const guard = setInterval(async () => {
    if (!window || checking) return;
    checking = true;
    try { const actor = await identity(); if (window && owner !== actor) close(); } catch {} finally { checking = false; }
  }, 5000);
  guard.unref();
  return {
    async search(keyword:unknown) {
      if(typeof keyword!=='string'||keyword.trim().length<2||keyword.length>200||/[\u0000-\u001f]/.test(keyword))throw new Error('普通搜索请输入2–200字关键词，地区和行业不会自动拼入关键词');
      if(querying)throw new Error('已有企业查询正在执行，请等待本次结果');
      querying=true;let timer:ReturnType<typeof setTimeout>|undefined;
      batch=undefined;
      try{
        await Promise.race([this.open(keyword),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('普通搜索页面加载超时，请查看内置浏览器')),15000);})]);
        if(timer)clearTimeout(timer);
        const current=window!;const start=epoch;const actor=owner;
        for(let n=0;n<30;n++){
          if(start!==epoch||current!==window||current.isDestroyed()||actor!==await identity())throw new Error('账号或窗口已变化，本次搜索已停止');
          const state=await current.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${enterpriseQueryPage.toString()})(${JSON.stringify({keyword,region:[],industry:[]})},"ordinary-result")`}]);
          if(state?.status==='blocked')throw new Error(state.message);
          if(state?.status==='results'){
            const result=await current.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:options.captureScript}]);
            if(start!==epoch||current!==window||actor!==await identity())throw new Error('账号或窗口已变化，本次搜索已停止');
            if(result?.ok){
              if(Buffer.byteLength(JSON.stringify(result.capture),'utf8')>CAPTURE_MAX_BYTES)throw new Error('当前页资料过大');
              const capture=validateEnterpriseCapture(result.capture);
              const state=await pager(current,'inspect');
              if(start!==epoch||current!==window||actor!==await identity())throw new Error('账号或窗口已变化');
              if(state.status==='ready')batch={id:randomUUID(),actor,epoch:start,keyword:keyword.trim(),page:state.page,signature:state.signature,pending:false};
              return {...capture,pagination:batch?{batchId:batch.id,page:state.page,hasNext:state.hasNext,notice:state.notice}:undefined};
            }
          }
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        throw new Error('普通搜索尚无可读取企业，请检查网站登录、验证或无结果提示，再使用“读取当前页”。');
      }finally{querying=false;if(timer)clearTimeout(timer);}
    },
    async next(batchId:unknown){
      if(querying)throw new Error('正在读取企业，请等待本次结果');
      const active=batch;const current=window;
      if(!active||batchId!==active.id||!current)throw new Error('本次搜索已失效，请重新普通搜索');
      const verify=async()=>{if(active!==batch||active.epoch!==epoch||current!==window||current.isDestroyed()||active.actor!==await identity())throw new Error('账号、查询或窗口已变化，请重新搜索');};
      querying=true;
      try{
        await verify();
        let state=await pager(current,'inspect');await verify();
        const stopped=(notice:string)=>({pagination:{batchId:active.id,page:active.page,hasNext:false,notice}});
        if(state.status==='blocked')return stopped(state.notice);
        if(state.keyword!==active.keyword)throw new Error('网站搜索词已变化，请重新搜索');
        if(!active.pending){
          if(state.page!==active.page||state.signature!==active.signature)throw new Error('网站结果已变化，请重新搜索，避免混入其他结果');
          if(!state.hasNext)return stopped(state.notice||'网站已无可用下一页');
          active.pending=true;
          state=await pager(current,'next',active.page);await verify();
          if(state.status!=='clicked'){active.pending=false;return stopped(state.notice||'网站未允许翻页');}
        }
        for(let n=0;n<30;n++){
          state=await pager(current,'inspect');await verify();
          if(state.status==='blocked')return stopped(state.notice);
          if(state.keyword!==active.keyword||state.page>active.page+1)throw new Error('网站查询或页码已变化，请重新搜索');
          if(state.page===active.page+1&&state.signature!==active.signature){
            const capture=await this.capture();await verify();
            active.page=state.page;active.signature=state.signature;active.pending=false;
            return {capture,pagination:{batchId:active.id,page:active.page,hasNext:state.hasNext,notice:state.notice}};
          }
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        throw new Error('下一页尚未就绪，已有结果保留；重试将读取待完成页，不再重复翻页。');
      }finally{querying=false;}
    },
    async query(raw: unknown) {
      const query=validateEnterpriseQuery(raw);
      if(querying) throw new Error('已有企业查询正在执行，请等待本次结果');
      querying=true;
      batch=undefined;
      try {
        await this.open();
        const current=window!;const start=epoch;const actor=owner;
        const verify=async()=>{if(start!==epoch || current!==window || current.isDestroyed() || actor!==await identity()) throw new Error('账号或窗口已变化，本次查询已停止');};
        const bounded=async<T>(promise:Promise<T>):Promise<T>=>{
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('网站操作超时，请检查内置浏览器后重试')),15000);})]);}
          finally{if(timer)clearTimeout(timer);}
        };
        await bounded(current.loadURL('https://aiqicha.baidu.com/advancesearch'));await verify();
        const operation=async(phase:'prepare'|'submit'|'result')=>{
          await verify();
          const result=await bounded(current.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:`(${enterpriseQueryPage.toString()})(${JSON.stringify(query)},${JSON.stringify(phase)})`} ]));
          await verify();
          if(result?.status==='blocked' || result?.status==='unsupported') throw new Error(result.message || '网站条件不可用');
          return result;
        };
        if((await operation('prepare'))?.status!=='ready') throw new Error('网站尚未确认查询条件');
        let submitted=false;
        for(let n=0;n<15;n++) {
          if((await operation('submit'))?.status==='submitted'){submitted=true;break;}
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        if(!submitted) throw new Error('网站未允许提交查询，请查看内置浏览器');
        for(let n=0;n<35;n++) {
          const state=await operation('result');
          if(state?.status==='results') {
            // Navigation may have committed before company cards render. Readiness is checked by the fixed capture script.
            const result=await bounded(current.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:options.captureScript}]));
            await verify();
            if(result?.ok) {
              if(Buffer.byteLength(JSON.stringify(result.capture),'utf8')>CAPTURE_MAX_BYTES) throw new Error('当前页资料过大');
              return validateEnterpriseCapture(result.capture);
            }
          }
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        throw new Error('网站未返回可读取企业；请查看登录、权限、查询次数或无结果提示。本次未导入资料。');
      } finally {querying=false;}
    },
    async open(keyword?: unknown) {
      if (keyword !== undefined && (typeof keyword !== 'string' || keyword.trim().length < 2 || keyword.length > 200 || /[\u0000-\u001f]/.test(keyword))) throw new Error('企业查询关键词需为2–200字');
      const url = typeof keyword === 'string' ? `https://aiqicha.baidu.com/s?q=${encodeURIComponent(keyword.trim())}` : 'https://aiqicha.baidu.com/';
      const actor = await identity();
      if (window && owner !== actor) close();
      if (window && !window.isDestroyed()) { window.show(); window.focus(); if (keyword !== undefined) await window.loadURL(url); return; }
      const created = options.createWindow({ width: 1200, height: 820, title: 'Shensi · 爱企查', show: true,
        webPreferences: { partition: `persist:enterprise-${createHash('sha256').update(actor).digest('hex')}`,
          nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
          webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false } });
      window = created; owner = actor;
      const contents = created.webContents;
      contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.on('will-download', event => event.preventDefault());
      const navigate = (event: { preventDefault(): void }, url: string) => { if (!allowedEnterpriseNavigation(url)) event.preventDefault(); };
      contents.on('will-navigate', navigate);
      contents.on('will-redirect', navigate);
      contents.setWindowOpenHandler(({ url }) => {
        if (allowedEnterpriseNavigation(url)) void created.loadURL(url).catch(() => {});
        return { action: 'deny' };
      });
      created.on('closed', () => { if (window === created) { window = undefined; owner = ''; epoch++; } });
      try { await created.loadURL(url); }
      catch { throw new Error('爱企查页面加载失败，请关闭窗口后重试'); }
    },
    async capture() {
      const actor = await identity();
      if (window && owner !== actor) close();
      const current = window; const start = epoch;
      if (!current || current.isDestroyed()) throw new Error('请重新打开内置浏览器并查询企业');
      const url = new URL(current.webContents.getURL());
      if (url.origin !== 'https://aiqicha.baidu.com' || !(url.pathname === '/s' || url.pathname === '/advancesearch/list' || /^\/company_detail_\d+$/.test(url.pathname))) throw new Error('请先在内置浏览器搜索企业或打开企业详情，再读取当前页');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          current.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: options.captureScript }]),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('读取超时，请确认网站可正常操作后重试')), 10000); })
        ]);
        if (start !== epoch || current !== window || actor !== await identity()) throw new Error('账号或窗口已变化，请重新读取');
        if (!result?.ok) throw new Error('当前页没有可读取企业，请完成登录、搜索或网站验证');
        if (Buffer.byteLength(JSON.stringify(result.capture), 'utf8') > CAPTURE_MAX_BYTES) throw new Error('当前页资料过大');
        return validateEnterpriseCapture(result.capture);
      } finally { if (timeout) clearTimeout(timeout); }
    },
    dispose() { clearInterval(guard); close(); }
  };
}
