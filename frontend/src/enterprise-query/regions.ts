import {regionData} from './region-data';
export const regionNodes = regionData.map(([code,name,parent,kind])=>({code,name,parent,kind}));
const byCode = new Map(regionNodes.map(n=>[n.code,n]));
export function regionChildren(parent: string) { return regionNodes.filter(n=>n.parent===parent); }
export function regionPath(code: string): typeof regionNodes {
  const node=byCode.get(code);
  if(!node) return [];
  return node.parent ? [byCode.get(node.parent)!,node] : [node];
}
export function searchRegions(query: string) {
  const term=query.trim();
  return regionNodes.filter(n=>n.name.includes(term) || n.code.startsWith(term));
}
export function matchesRegion(value: string, code: string): boolean {
  if(!code) return true;
  const selected=byCode.get(code);
  if(!selected) return false;
  const text=value.trim().replace(/\s+/g,'');
  const candidates=selected.parent ? [selected] : [selected,...regionChildren(code)];
  return candidates.some(n=>{
    const parent=byCode.get(n.parent);
    return text===n.code || text===n.code.padEnd(6,'0') || text===n.name || text===n.name.replace(/[省市]$/,'')
      || Boolean(parent && (text===parent.name+n.name || text===`${parent.name}/${n.name}`));
  });
}
