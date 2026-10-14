import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Validate visible geometry rather than requiring the CSS that caused clipping.
execFileSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../../scripts/test-agent-chat-layout.mts', import.meta.url))], {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)), stdio: 'inherit'
});
