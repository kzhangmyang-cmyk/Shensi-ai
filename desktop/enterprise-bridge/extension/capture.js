// Reads rendered DOM only. No network, cookies, hidden application state or pagination.
(() => {
  const detail = /^\/company_detail_\d+$/.test(location.pathname);
  const advanced = location.pathname === '/advancesearch/list';
  if (location.origin !== 'https://aiqicha.baidu.com' || !(location.pathname === '/s' || advanced || detail)) return { ok: false, message: '非爱企查搜索或详情页' };
  const rendered = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  if (detail) {
    const heading = document.querySelector('h1');
    const table = [...document.querySelectorAll('table')].find(t => rendered(t) && t.innerText.includes('统一社会信用代码') && t.innerText.includes('注册资本'));
    if (!heading || !rendered(heading) || !table) return { ok: false, message: '详情工商信息尚未显示' };
    const fields = new Map();
    for (const row of table.querySelectorAll('tr')) {
      const cells = [...row.querySelectorAll('td')].filter(rendered);
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const label = cells[i].innerText.replace(/[^\u4e00-\u9fff]/g, '');
        const value = cells[i+1].innerText.replace(/\s+/g,' ').trim();
        if (value && !/[＊*]/.test(value) && value !== '-') fields.set(label,value.slice(0,500));
      }
    }
    let top = heading.parentElement;
    for (let i = 0; i < 5 && top?.parentElement && !top.innerText.includes('电话：'); i++) top = top.parentElement;
    const text = (top?.innerText || '').replace(/\s+/g,' ').slice(0,10000);
    const item = { company: heading.innerText.trim(), sourceUrl: location.origin + location.pathname,
      creditCode: fields.get('统一社会信用代码') || '', capital: fields.get('注册资本') || '',
      legalPerson: (fields.get('法定代表人') || text.match(/法定代表人[：:]\s*(.*?)\s*履历/)?.[1] || '').replace(/\s+/g,' ').replace(/\s*(?:履历|TA有).*$/,'').replace(/^(\S)\s+(?=\1)/,'').trim(),
      founded: (fields.get('成立日期') || fields.get('成立时间') || text.match(/注册时间[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '').slice(0,10),
      address: (fields.get('注册地址') || '').replace(/\s*查看地图.*$/,'').trim(),
      contactInfo: text.match(/电话[：:]\s*[^\d]{0,5}([\d\- ]{7,25})/)?.[1]?.trim() || '',
      email: text.match(/邮箱[：:]\s*([^\s]+@[^\s]+)/)?.[1] || '',
      businessScope: fields.get('经营范围') || '', companyType: fields.get('企业类型') || '',
      industry: fields.get('所属行业') || '', insuredEmployees: fields.get('参保人数') || '' };
    return { ok: true, capture: { version: 1, sourceUrl: item.sourceUrl, capturedAt: new Date().toISOString(), items: [item] } };
  }
  const items = new Map();
  for (const link of document.querySelectorAll(advanced ? '.advancedsearch-result h3' : 'h3')) {
    if (!rendered(link)) continue;
    const href = link.querySelector('a')?.getAttribute('href');
    let url; try { url = new URL(href || location.pathname, location.href); } catch { continue; }
    if (url.origin !== location.origin || !(url.pathname === '/s' || /^\/company_detail_\d+$/.test(url.pathname))) continue;
    const company = (link.querySelector('a') || link).innerText.trim().replace(/\s+/g, ' ');
    if (!company || company.length > 200) continue;
    const card = link.closest('.items');
    if (!card) continue;
    const body = card.innerText.replace(/\s+/g, ' ');
    if (!body.includes('注册资本') || !body.includes('成立时间') || body.length > 4000) continue;
    const field = (start, end) => body.match(new RegExp(`${start}[：:]\\s*(.*?)\\s*(?=${end}|$)`))?.[1]?.trim().slice(0,500) || '';
    const item = { company, sourceUrl: `${url.origin}${url.pathname}`,
      legalPerson: field('法定代表人', '注册资本'), capital: field('注册资本', '成立时间'),
      founded: body.match(/成立时间[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '',
      address: field('地址', '经营范围[：:]|品牌项目[：:]|网站名称[：:]|商标名称[：:]|股东信息|财产线索|变更记录|[]|\\d+\\+?\\s*条(?:自身|关联)风险'),
      contactInfo: field('电话', '更多|邮箱[：:]|地址[：:]') };
    if(advanced) item.businessScope=field('经营范围','匹配原因[：:]');
    const identity = item.sourceUrl + '\u0000' + item.company;
    if (!items.has(identity)) items.set(identity, item);
  }
  if (!items.size) {
    return { ok: false, message: '未识别已展示企业卡片，请确认页面已加载且没有登录或验证提示' };
  }
  if (items.size > 40) return { ok: false, message: '当前页超过40条，不支持批量采集' };
  return { ok: true, capture: { version: 1, sourceUrl: location.origin + location.pathname,
    capturedAt: new Date().toISOString(), items: [...items.values()] } };
})();
