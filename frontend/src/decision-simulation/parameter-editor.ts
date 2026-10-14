export function mountParameterEditor(host: HTMLElement, kind: 'receivables' | 'payables' | 'alternatives' | 'options', read: () => string, write: (raw: string) => void) {
  const document = host.ownerDocument;
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const rows = document.createElement('div'); host.append(rows, status);
  const add = document.createElement('button'); add.type = 'button'; add.dataset.parameterAdd = '';
  add.textContent = kind === 'alternatives' ? '添加备选方案' : kind === 'receivables' ? '添加应收' : '添加应付'; host.append(add);
  const fields = kind === 'alternatives' ? [['id', '方案名称'], ['demandMultiplier', '需求倍率'], ['capacityMultiplier', '产能倍率'], ['priceMultiplier', '售价倍率'], ['costMultiplier', '直接成本倍率'], ['extraFixedCostMinor', '每月新增固定费用（元）']]
    : [['dueMonth', '到期月'], ['amountMinor', kind === 'receivables' ? '应收金额（元）' : '应付金额（元）']];
  const fail = (error: unknown) => { status.textContent = error instanceof Error ? error.message : '参数无效，请检查。'; };
  const optionFields: [string, string, number, number, boolean][] = [
    ['seed', '随机种子', 0, 4294967295, true], ['samples', '情景数量', 1, 100, true], ['months', '模拟月数', 1, 24, true],
    ...(['demand', 'procurement', 'delivery', 'collectionDelay'] as const).flatMap(factor => [0, 1].map(index => [
      `assumptions.${factor}.${index}`, `${({ demand: '需求倍率', procurement: '采购成本倍率', delivery: '交付效率倍率', collectionDelay: '额外回款延迟（月）' })[factor]}${index === 0 ? '下限' : '上限'}`, 0, 24, factor === 'collectionDelay'
    ] as [string, string, number, number, boolean])),
    ['assumptions.persistence', '波动持续权重（0–1）', 0, 1, false], ['assumptions.commonWeight', '共同不利扰动权重（0–1）', 0, 1, false]
  ];
  const optionRows = () => {
    const initial = JSON.parse(read());
    if (!initial || typeof initial !== 'object' || Array.isArray(initial)) throw new Error('请先修正高级波动参数。');
    for (const [path, title, min, max, integer] of optionFields) {
      const parts = path.split('.');
      const label = document.createElement('label'); label.textContent = title;
      const input = document.createElement('input'); input.type = 'number'; input.dataset.parameter = path;
      input.min = String(min); input.max = String(max); input.step = integer ? '1' : 'any';
      input.value = String(parts.reduce((value, key) => value?.[key], initial) ?? '');
      input.addEventListener('change', () => { try {
        const value = Number(input.value);
        if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`${title}须在${min}–${max}之间${integer ? '，且为整数' : ''}。`);
        const current = JSON.parse(read()); let owner = current;
        for (const key of parts.slice(0, -1)) { if (!owner[key] || typeof owner[key] !== 'object') throw new Error('请先修正高级参数结构。'); owner = owner[key]; }
        if (parts.length === 3 && ((parts[2] === '0' && value > owner[1]) || (parts[2] === '1' && value < owner[0]))) throw new Error('波动下限不能大于上限。');
        owner[parts.at(-1)!] = value; write(JSON.stringify(current, null, 2)); input.removeAttribute('aria-invalid'); status.textContent = '';
      } catch (error) { input.setAttribute('aria-invalid', 'true'); fail(error); } });
      label.append(input); rows.append(label);
    }
  };
  const sync = () => {
    rows.replaceChildren(); status.textContent = '';
    try {
      if (kind === 'options') { add.hidden = true; optionRows(); return; }
      const entries = JSON.parse(read());
      if (!Array.isArray(entries)) throw new Error('应收应付必须为列表，请先修正高级参数。');
      for (const [index, entry] of entries.entries()) {
        const row = document.createElement('section');
        for (const [key, title] of fields) {
          const isMoney = key.endsWith('Minor'); const isText = key === 'id';
          const label = document.createElement('label'); label.textContent = title;
          const input = document.createElement('input'); input.type = isText ? 'text' : 'number'; input.dataset.parameter = key;
          input.step = isMoney ? '0.01' : key === 'dueMonth' ? '1' : 'any';
          input.value = isText ? String(entry[key] ?? '') : String(entry[key] / (isMoney ? 100 : 1));
          input.addEventListener('change', () => {
            try {
              const raw = input.value.trim();
              if (!/^\d+(?:\.\d{1,2})?$/.test(raw) && isMoney) throw new Error('金额须为非负数，最多两位小数。');
              const value = isText ? raw : isMoney ? Number(raw.split('.')[0]) * 100 + Number((raw.split('.')[1] ?? '').padEnd(2, '0')) : Number(raw);
              if (isText ? !raw || raw.length > 100 : !raw || !Number.isFinite(value) || Number(value) < (key === 'dueMonth' ? 1 : 0)
                || Number(value) > (isMoney ? 1e12 : key === 'dueMonth' ? 48 : 10) || ((isMoney || key === 'dueMonth') && !Number.isSafeInteger(value))) throw new Error('请检查方案名称、金额、到期月份（1–48）或倍率（0–10）。');
              const current = JSON.parse(read()); current[index] = { ...current[index], [key]: value };
              write(JSON.stringify(current, null, 2)); input.removeAttribute('aria-invalid'); status.textContent = '';
            } catch (error) { input.setAttribute('aria-invalid', 'true'); fail(error); }
          });
          label.append(input); row.append(label);
        }
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.parameterRemove = String(index); remove.textContent = '移除';
        remove.onclick = () => { try { const current = JSON.parse(read()); current.splice(index, 1); write(JSON.stringify(current, null, 2)); sync(); } catch (error) { fail(error); } };
        row.append(remove); rows.append(row);
      }
      if (!entries.length) rows.textContent = '暂无项目；请按实际余额补充。';
    } catch (error) { fail(error); }
  };
  add.onclick = () => { try {
    const current = JSON.parse(read());
    if (!Array.isArray(current)) throw new Error('请先修正高级参数。');
    if (current.length >= (kind === 'alternatives' ? 3 : 100)) throw new Error(kind === 'alternatives' ? '最多3个备选方案。' : '最多100条，请整理到期项目。');
    current.push(kind === 'alternatives' ? { id: `备选方案${current.length + 1}`, demandMultiplier: 1, capacityMultiplier: 1, priceMultiplier: 1, costMultiplier: 1, extraFixedCostMinor: 0 } : { dueMonth: 1, amountMinor: 0 }); write(JSON.stringify(current, null, 2)); sync();
  } catch (error) { fail(error); } };
  sync(); return { sync, validate() {
    for (const input of rows.querySelectorAll('input')) input.dispatchEvent(new document.defaultView!.Event('change'));
    const invalid = rows.querySelector<HTMLInputElement>('[aria-invalid=true]');
    if (invalid) { status.textContent = '请修正标记的参数后再生成。'; host.closest('details')?.setAttribute('open',''); invalid.focus(); return false; }
    try { const value = JSON.parse(read()); return kind === 'options' ? Boolean(value && typeof value === 'object' && !Array.isArray(value)) : Array.isArray(value); } catch { return false; }
  } };
}
