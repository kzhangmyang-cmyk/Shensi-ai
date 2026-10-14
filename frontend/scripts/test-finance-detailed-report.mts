import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from '@playwright/test';
import {parseHTML} from 'linkedom';
import {enterpriseReportHtml} from '../src/growth/finance/enterprise-analysis';
import {detailedReportBody,detailedReportStyle} from '../src/growth/finance/detailed-report';
import type {FinanceDocumentInspection} from '../src/growth/finance/api';
import {validateCouncilReportRequest} from '../../desktop/src/shared/council-report';

// Isolated synthetic fixture, never attaches to the running user's browser/app.
const root=fileURLToPath(new URL('../',import.meta.url));
const index=parseHTML(await readFile(`${root}index.html`,'utf8')).document;
const css=(await Promise.all([...index.querySelectorAll('link[rel=stylesheet]')].map(link=>readFile(`${root}${link.getAttribute('href')!.replace(/^\//,'')}`,'utf8')))).join('\n') + await readFile(`${root}src/growth/styles.css`,'utf8');
const observations=[{text:'合成资料中收入与回款属于不同口径，需要结合收款记录核实；缺失费用不能按零处理。'.repeat(4),sourceRefs:['cell:1:1:1']}];
const fixture:FinanceDocumentInspection={documentId:'synthetic-report',fileName:'合成财务资料.csv',expiresAt:'2026-10-01T00:00:00Z',selectedForConversation:true,fileHash:`sha256:${'a'.repeat(64)}`,classification:'unknown',regions:[],missingStatements:[],uncertain:[],modelStatus:'completed',observations:[],
  cells:Array.from({length:120},(_,i)=>({sourceRef:`cell:1:${i+1}:1`,sheetName:'合成来源',row:i+1,column:1,text:`SOURCE-${String(i+1).padStart(3,'0')}：仅供分页检查的合成项目，收入、成本、期间与现金确认口径均需要分别核对。`.repeat(3)})),
  detailedReport:{version:'finance-detailed.v1',publicResearchStatus:'unavailable',sections:(['overview','income','cost','profit','cashflow','comparison','actions'] as const).map(id=>({id,coverage:'partial',evidence:observations,interpretation:observations,action:observations}))}};
const output='/tmp/shensi-finance-report-qa';await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
try {
  for(const theme of ['light','dark'])for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.abort());
    await page.setContent(`<html data-theme="${theme}"><head><style>${css}\n${detailedReportStyle}</style></head><body class="is-authenticated"><div class="replica-shell is-growth-route" style="display:block"><main id="growthWorkspace" style="max-width:960px;margin:auto"><section class="growth-panel enterprise-analysis">${detailedReportBody(fixture)}</section></main></div></body></html>`);
    assert.equal(await page.locator('.report-chapter').count(),7);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${theme}/${width} horizontal overflow`);
    const textColor=await page.locator('.enterprise-report p').first().evaluate(el=>getComputedStyle(el).color);
    assert.notEqual(textColor,theme==='dark'?'rgb(0, 0, 0)':'rgb(255, 255, 255)',`${theme} readable inherited text`);
    await page.screenshot({path:`${output}/${theme}-${width}-start.png`});
    await page.getByText('公开检索未完成',{exact:false}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${output}/${theme}-${width}-sources.png`});
    assert.deepEqual(errors,[]);await page.close();
  }
  const html=enterpriseReportHtml(fixture,'财务经营');validateCouncilReportRequest({html,filename:'synthetic-finance.pdf'});
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent(html);
  const bytes=await page.pdf({path:`${output}/synthetic-finance.pdf`,format:'A4',printBackground:true,preferCSSPageSize:true});
  const require=createRequire(new URL('../../backend/package.json',import.meta.url));
  const {getDocument}=await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const loading=getDocument({data:new Uint8Array(bytes),useSystemFonts:true});
  const pdf=await loading.promise;
  let text='';for(let i=1;i<=pdf.numPages;i++){const content=await(await pdf.getPage(i)).getTextContent();text+=content.items.map((item:{str?:string})=>item.str??'').join('');}
  // macOS CJK subset fonts may expose radical code points in ToUnicode.
  text=text.normalize('NFKC').replace(/⻛/gu,'风');
  assert.ok(pdf.numPages>3);assert.match(text,/SOURCE-001/);assert.match(text,/SOURCE-120/);
  for(const title of ['收入质量与业务驱动','现金流与资金约束','风险排序与行动计划'])assert.ok(text.includes(title),title);
  execFileSync('pdftoppm',['-f','1','-singlefile','-scale-to','1400','-png',`${output}/synthetic-finance.pdf`,`${output}/pdf-first`]);
  execFileSync('pdftoppm',['-f',String(pdf.numPages),'-singlefile','-scale-to','1400','-png',`${output}/synthetic-finance.pdf`,`${output}/pdf-last`]);
  console.log(JSON.stringify({pages:pdf.numPages,chapters:7,sources:120,themes:2,widths:[1440,390],output}));
  await loading.destroy();
}finally{await browser.close();}
