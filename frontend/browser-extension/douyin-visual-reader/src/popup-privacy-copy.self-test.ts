import { strict as assert } from "node:assert";
import { popupPrivacyCopy } from "./popup-privacy-copy";

assert.deepEqual(popupPrivacyCopy(true), {
  artifactMode: "遮挡 WebP（可上传）",
  scope: "正文缺失或截断时，原始视口截图仅在扩展内存中短暂存在；扩展在本地裁剪评论卡、遮挡头像与无关区域并运行 OCR，只上传遮挡后的 WebP。不会私信、点赞、评论或关注。",
  lifecycle: "关闭弹窗后读取仍会继续；只有点击“停止”或接管页面才会停止。"
}, "artifact mode discloses temporary local capture, redaction, OCR, and redacted-only upload");

assert.deepEqual(popupPrivacyCopy(false), {
  artifactMode: "纯文字（不截图）",
  scope: "纯文字模式：只读取当前可见 DOM/ARIA 文字、公开时间与计数，不截图、不运行 OCR、不上传图片。不会私信、点赞、评论或关注。",
  lifecycle: "关闭弹窗后读取仍会继续；只有点击“停止”或接管页面才会停止。"
}, "text-only mode says that screenshots, OCR, and image uploads stay disabled");

console.log("popup privacy copy self-test passed");
