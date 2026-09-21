export const ENTERPRISE_CAPTURE_CHANNEL = 'shensi:enterprise:read-preview';
export const ENTERPRISE_OPEN_CHANNEL = 'shensi:enterprise:open-local';
export const ENTERPRISE_LOCAL_CAPTURE_CHANNEL = 'shensi:enterprise:capture-local';
export const ENTERPRISE_QUERY_CHANNEL = 'shensi:enterprise:query-local';
export const ENTERPRISE_SEARCH_CHANNEL = 'shensi:enterprise:search-local';
export const ENTERPRISE_NEXT_CHANNEL = 'shensi:enterprise:next-local';
export interface EnterprisePagination {batchId:string;page:number;hasNext:boolean;notice:string}
export type EnterpriseSearchCapture = EnterpriseCapture & {pagination?:EnterprisePagination};
export function mergeEnterpriseCards(previous:EnterpriseCard[],incoming:EnterpriseCard[]):EnterpriseCard[]{
  const result=[...previous];
  const key=(item:EnterpriseCard)=>/\/company_detail_\d+$/.test(item.sourceUrl)?item.sourceUrl:item.company.normalize('NFKC').replace(/\s+/g,'');
  const seen=new Set(previous.map(key));
  for(const item of incoming){if(!seen.has(key(item))){seen.add(key(item));result.push(item);}}
  return result;
}
export interface EnterpriseQuery { keyword: string; region: string[]; industry: string[] }
export function validateEnterpriseQuery(raw: unknown): EnterpriseQuery {
  const value = record(raw); keys(value, ['keyword','region','industry']);
  if (typeof value.keyword !== 'string' || value.keyword.length > 200 || /[\u0000-\u001f]/.test(value.keyword)) throw new Error('查询关键词无效');
  if (!Array.isArray(value.region) || value.region.length > 2) throw new Error('地区仅支持省、市两级');
  if (!Array.isArray(value.industry) || value.industry.length > 2) throw new Error('爱企查高级搜索仅支持门类和二级行业，请选择上级行业；不会自动放宽条件');
  const result = { keyword:value.keyword.trim(), region:value.region.map(item=>text(item,60)), industry:value.industry.map(item=>text(item,100)) };
  if (!result.keyword && !result.region.length && !result.industry.length) throw new Error('请至少选择一个查询条件');
  return result;
}
export const CAPTURE_MAX_BYTES = 128 * 1024;
export interface EnterpriseCard {
  company: string; sourceUrl: string; legalPerson?: string; capital?: string;
  founded?: string; address?: string; contactInfo?: string;
  creditCode?: string; email?: string; businessScope?: string; companyType?: string; industry?: string; insuredEmployees?: string;
}
export interface EnterpriseCapture { version: 1; sourceUrl: string; capturedAt: string; items: EnterpriseCard[] }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('企业消息格式错误');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('企业消息包含未允许字段');
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008]/.test(value)) throw new Error('企业字段无效');
  return value.trim();
}
function source(value: unknown, detail: boolean): string {
  const url = new URL(text(value, 2048));
  if (url.origin !== 'https://aiqicha.baidu.com' || url.username || url.password || url.hash
    || !(detail ? url.pathname === '/s' || url.pathname === '/advancesearch/list' || /^\/company_detail_\d+$/.test(url.pathname) : url.pathname === '/s' || url.pathname === '/advancesearch/list')) throw new Error('仅允许爱企查企业搜索及详情页面');
  // Do not retain arbitrary URL parameters or tracking tokens.
  return `${url.origin}${url.pathname}`;
}
export function validateEnterpriseCapture(raw: unknown): EnterpriseCapture {
  const value = record(raw); keys(value, ['version', 'sourceUrl', 'capturedAt', 'items']);
  if (value.version !== 1 || !Array.isArray(value.items) || !value.items.length || value.items.length > 40) throw new Error('仅允许当前页1至40条企业');
  const capturedAt = text(value.capturedAt, 40); const age = Date.now() - Date.parse(capturedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 30 * 60 * 1000) throw new Error('预览已过期，请重新读取当前页');
  const items = new Map<string, EnterpriseCard>();
  for (const rawCard of value.items) {
    const card = record(rawCard);
    keys(card, ['company', 'sourceUrl', 'legalPerson', 'capital', 'founded', 'address', 'contactInfo', 'creditCode', 'email', 'businessScope', 'companyType', 'industry', 'insuredEmployees']);
    const item: EnterpriseCard = { company: text(card.company, 200), sourceUrl: source(card.sourceUrl, true) };
    for (const key of ['legalPerson', 'capital', 'founded', 'address', 'contactInfo', 'creditCode', 'email', 'businessScope', 'companyType', 'industry', 'insuredEmployees'] as const)
      if (card[key] !== undefined && card[key] !== '') item[key] = text(card[key], 500);
    items.set(item.sourceUrl + '\u0000' + item.company, item);
  }
  return { version: 1, sourceUrl: source(value.sourceUrl, true), capturedAt, items: [...items.values()] };
}
