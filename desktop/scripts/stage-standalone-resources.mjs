import path from 'node:path';
import { stageStandaloneResources } from './standalone-resources.mjs';

const fields = new Map([['--backend', 'backendDirectory'], ['--contracts', 'contractsDirectory'],
  ['--node', 'nodeExecutable'], ['--node-license', 'nodeLicense'], ['--mysql', 'mysqlDirectory'],
  ['--reference', 'referenceDirectory'], ['--output', 'outputDirectory']]);
const args = process.argv.slice(2); const options = {};
for (let index = 0; index < args.length; index += 2) {
  const field = fields.get(args[index]); const value = args[index + 1];
  if (!field || Object.hasOwn(options, field) || !value || !path.isAbsolute(value)) throw new Error('standalone_staging_arguments_invalid');
  options[field] = value;
}
if (Object.keys(options).length !== fields.size) throw new Error('standalone_staging_arguments_invalid');
await stageStandaloneResources(options);
console.log(JSON.stringify({ ok: true, sourceCount: 21, staged: true }));
