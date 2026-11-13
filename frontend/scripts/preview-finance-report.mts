import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { enterpriseReportHtml } from '../src/growth/finance/enterprise-analysis';
import { financeReportFixture } from '../src/growth/finance/report-fixture';
import { validateCouncilReportRequest } from '../../desktop/src/shared/council-report';

const folder = '/tmp/shensi-finance-report-qa';
await mkdir(folder, {recursive: true});
const name = process.argv[2] ?? 'shensi-finance-synthetic';
const fixture = financeReportFixture(name.includes('usd') ? 'USD' : 'CNY');
if (name.includes('empty')) { fixture.cells=[];fixture.detailedReport!.sections=[]; }
if (name.includes('long')) {
  fixture.detailedReport!.sections[0].interpretation[0].text = '合成长文本用于检查跨页排版，所有判断仍需要原始资料支持。'.repeat(150);
  fixture.cells.push({sourceRef:'docx:p:1',paragraph:1,text:'这是用于检查附录长段落分页的合成原文。'.repeat(100)});
}
const html = enterpriseReportHtml(fixture, '财务经营');
validateCouncilReportRequest({html,filename: `${name}.pdf`});
await writeFile(`${folder}/${name}.html`, html);
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({path:`${folder}/${name}.pdf`,format:'A4',printBackground:true,preferCSSPageSize:true});
  console.log(JSON.stringify({html:`${folder}/${name}.html`,pdf:`${folder}/${name}.pdf`,synthetic:true}));
} finally {await browser.close();}
