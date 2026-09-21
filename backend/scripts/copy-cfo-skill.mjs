import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2] ? pathToFileURL(`${resolve(process.argv[2])}/`) : new URL('../dist/', import.meta.url);
for (const skill of ['cfo-operating-advisor', 'finance-statement-analyst', 'profit-contribution-analyst',
  'cost-driver-analyst', 'cashflow-liquidity-analyst', 'tax-evidence-reviewer']) {
  const target = new URL(`skills/${skill}/`, root);
  await mkdir(target, { recursive: true });
  await copyFile(new URL(`../src/skills/${skill}/SKILL.md`, import.meta.url), new URL('SKILL.md', target));
}
