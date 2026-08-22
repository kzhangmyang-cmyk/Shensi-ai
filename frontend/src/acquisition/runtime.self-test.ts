import { strict as assert } from "node:assert";
import { snapshotDisabledStates } from "./runtime";
import {
  importOutcomeFromOperation,
  publicDouyinUrl,
  publicUrlsCsv
} from "./runtime-import";

const initiallyEnabled = { disabled: false };
const initiallyDisabled = { disabled: true };
const restoreDisabledStates = snapshotDisabledStates([
  initiallyEnabled,
  initiallyDisabled,
  null
]);

initiallyEnabled.disabled = true;
initiallyDisabled.disabled = false;

restoreDisabledStates();

assert.equal(
  initiallyEnabled.disabled,
  false,
  "leaving real acquisition mode must restore an initially enabled action"
);
assert.equal(
  initiallyDisabled.disabled,
  true,
  "leaving real acquisition mode must preserve an initially disabled action"
);

assert.deepEqual(
  publicDouyinUrl("https://www.douyin.com/video/7521000000000000010"),
  { ok: true, value: "https://www.douyin.com/video/7521000000000000010" }
);
assert.deepEqual(
  publicDouyinUrl("http://www.douyin.com/video/1"),
  { ok: false, message: "仅支持 HTTPS 公开链接" }
);
assert.deepEqual(
  publicDouyinUrl("https://example.com/video/1"),
  { ok: false, message: "仅支持抖音公开域名链接" }
);

const csvText = new TextDecoder().decode(publicUrlsCsv([
  "https://www.douyin.com/video/1",
  "https://v.douyin.com/abc/"
]));
assert.equal(
  csvText,
  "标题,摘要,平台,链接\r\n用户导入的公开抖音链接,用户提交公开链接，主体待核验,douyin,https://www.douyin.com/video/1\r\n用户导入的公开抖音链接,用户提交公开链接，主体待核验,douyin,https://v.douyin.com/abc/"
);

assert.deepEqual(
  importOutcomeFromOperation({
    acceptedRowCount: 1,
    evidenceCount: 1,
    candidateCount: 1,
    candidateIds: ["candidate-1", ""],
    errorRows: [{
      sheetName: "线索<1>",
      rowNumber: 2,
      code: "invalid_source_url",
      message: "链接不可读<script>"
    }]
  }),
  {
    acceptedRowCount: 1,
    evidenceCount: 1,
    candidateCount: 1,
    candidateIds: ["candidate-1"],
    rowErrors: [{
      sheetName: "线索<1>",
      rowNumber: 2,
      code: "invalid_source_url",
      message: "链接不可读<script>"
    }]
  }
);

console.log("acquisition runtime self-test passed");
