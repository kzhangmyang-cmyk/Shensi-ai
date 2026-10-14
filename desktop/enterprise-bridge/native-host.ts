import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CAPTURE_MAX_BYTES, validateEnterpriseCapture } from '../src/shared/enterprise-browser.ts';
const directory = path.join(homedir(), 'Library/Application Support/ShensiEnterpriseBridge');
const reply = (value: unknown) => { const data = Buffer.from(JSON.stringify(value)); const size = Buffer.alloc(4); size.writeUInt32LE(data.length); process.stdout.write(Buffer.concat([size, data])); };
async function main() {
  const config = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
  if (!/^[a-p]{32}$/.test(config.extensionId) || process.argv[2] !== `chrome-extension://${config.extensionId}/`) throw new Error('扩展来源未授权');
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error('桥接目录权限错误');
  let bytes = Buffer.alloc(0);
  const timer = setTimeout(() => process.exit(1), 10000); timer.unref();
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > CAPTURE_MAX_BYTES + 4) throw new Error('消息过大');
    if (bytes.length < 4) continue;
    const length = bytes.readUInt32LE();
    if (!length || length > CAPTURE_MAX_BYTES) throw new Error('消息长度无效');
    if (bytes.length < length + 4) continue;
    if (bytes.length !== length + 4) throw new Error('只接受单条预览消息');
    const capture = validateEnterpriseCapture(JSON.parse(bytes.subarray(4).toString('utf8')));
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(capture), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(directory, 'preview.json'));
    reply({ ok: true, count: capture.items.length }); clearTimeout(timer); return;
  }
  throw new Error('消息不完整');
}
main().catch(() => { reply({ ok: false, message: '本机桥接未就绪或消息无效，请检查安装后重试' }); process.exitCode = 1; });
