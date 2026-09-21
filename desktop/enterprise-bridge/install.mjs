// Explicit user-run installer. Does not read Chrome profiles or start Chrome.
import { mkdir, writeFile, copyFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const id = process.argv[2];
if (process.platform !== 'darwin' || !/^[a-p]{32}$/.test(id || '')) throw new Error('用法：node install.mjs <Chrome扩展ID>（macOS）');
const directory = path.join(homedir(), 'Library/Application Support/ShensiEnterpriseBridge');
await mkdir(directory, { recursive: true, mode: 0o700 });
const stat = await lstat(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('本机桥接目录权限不安全');
await copyFile(path.join(import.meta.dirname, 'native-host.cjs'), path.join(directory, 'native-host.cjs'));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(path.join(directory, 'host'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(directory, 'native-host.cjs'))} "$@"\n`, { mode: 0o700 });
await writeFile(path.join(directory, 'config.json'), JSON.stringify({ extensionId: id }), { mode: 0o600 });
const registry = path.join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts');
await mkdir(registry, { recursive: true });
await writeFile(path.join(registry, 'com.shensi.enterprise_preview.json'), JSON.stringify({ name: 'com.shensi.enterprise_preview', description: 'Shensi local enterprise preview', type: 'stdio', path: path.join(directory, 'host'), allowed_origins: [`chrome-extension://${id}/`] }, null, 2), { mode: 0o600 });
console.log('本机桥已注册。返回爱企查搜索页，点击扩展发送当前页预览。');
