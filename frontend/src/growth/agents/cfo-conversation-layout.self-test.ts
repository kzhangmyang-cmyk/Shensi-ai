import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const styles = readFileSync(
  new URL("../../replica-dashboard.css", import.meta.url),
  "utf8"
);

assert.match(
  styles,
  /\.replica-shell\.is-agents-route \.cfo-conversation\s*\{[\s\S]*?height:\s*100%;[\s\S]*?grid-template-rows:\s*90px 80px 34px auto minmax\(0, 1fr\);/u,
  "the agent conversation must retain a full desktop workspace"
);
assert.match(
  styles,
  /\.replica-shell\.is-agents-route \.cfo-chat-workspace\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto;[\s\S]*?overflow:\s*hidden;/u,
  "the empty-chat workspace must reserve its final row for the composer"
);
assert.doesNotMatch(
  styles,
  /\.cfo-conversation:not\(:has\(\.cfo-turns:not\(:empty\)\)\)[\s\S]*?height:\s*auto;/u,
  "an empty conversation must not collapse out of the desktop workspace"
);
assert.match(styles, /\.replica-shell\.is-agents-route \[data-cfo-operating-memory\]\s*\{\s*grid-column:\s*1;\s*grid-row:\s*4;[\s\S]*?max-height:\s*36vh;[\s\S]*?overflow:\s*auto;/u,
  'shared memory owns a bounded fourth row, never the inspector column');
assert.match(styles, /\.replica-shell\.is-agents-route \.cfo-session-layout\s*\{\s*grid-column:\s*1;\s*grid-row:\s*5;/u,
  'the history/chat wrapper owns the remaining fifth desktop row');
assert.match(styles, /\.cfo-session-layout \.cfo-chat-workspace\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;/u,
  'nested chat must not create an implicit fourth row inside the history layout');
