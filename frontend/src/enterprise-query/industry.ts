import { industryData } from './industry-data';
export const industryNodes = industryData.map(([code, name, parent]) => ({ code, name, parent }));
const byCode = new Map(industryNodes.map(node => [node.code, node]));
export function industryPath(code: string): typeof industryNodes {
  const path = [];
  let node = byCode.get(code);
  while (node) { path.unshift(node); node = byCode.get(node.parent); }
  return path;
}
export function searchIndustries(query: string): typeof industryNodes {
  const term = query.trim().toLocaleLowerCase();
  return industryNodes.filter(node => node.code.toLowerCase().includes(term) || node.name.includes(term));
}
export function matchesIndustry(value: string, code: string): boolean {
  if (!code) return true;
  const normalized = value.trim();
  const nodes = byCode.has(normalized) ? [byCode.get(normalized)!] : industryNodes.filter(node => node.name === normalized);
  return nodes.some(node => industryPath(node.code).some(parent => parent.code === code));
}
