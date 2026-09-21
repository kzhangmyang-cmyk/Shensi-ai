import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const projectRoot = resolve(import.meta.dirname, "..");
const extensionDir = resolve(projectRoot, "dist-visual-reader/douyin-visual-reader");
const profileDir = await mkdtemp(resolve(tmpdir(), "goodjob-visual-reader-smoke-"));

try {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`
    ]
  });
  try {
    const serviceWorker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
    const page = await context.newPage();
    const screenshotDataUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 260;
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("smoke canvas unavailable");
      drawing.fillStyle = "#f5f5f2";
      drawing.fillRect(0, 0, canvas.width, canvas.height);
      drawing.fillStyle = "#111111";
      drawing.font = "bold 52px 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
      drawing.fillText("中文报价 128.50 元", 90, 140);
      return canvas.toDataURL("image/png");
    });
    await page.close();

    const response = await serviceWorker.evaluate(async (dataUrl) => {
      const scope = globalThis as typeof globalThis & { chrome: any };
      if (!(await scope.chrome.offscreen.hasDocument())) {
        await scope.chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["WORKERS"],
          justification: "Synthetic local OCR production smoke"
        });
      }
      const runtimeEpoch = "smoke-worker-epoch-0001";
      const synchronized = await scope.chrome.runtime.sendMessage({
        kind: "visual_ocr_sync_generation",
        runtimeEpoch,
        runtimeGeneration: 0
      });
      if (synchronized?.accepted !== true) throw new Error("offscreen epoch synchronization failed");
      return Promise.race([
        scope.chrome.runtime.sendMessage({
          kind: "visual_process_capture",
          runtimeEpoch,
          runtimeGeneration: 0,
          sessionId: "synthetic-smoke",
          domTextState: "missing",
          viewport: { width: 900, height: 260, deviceScaleFactor: 1 },
          cardBounds: { x: 0, y: 0, width: 900, height: 260 },
          avatarBounds: { x: 15, y: 15, width: 48, height: 48 },
          regions: [{
            kind: "body",
            bounds: { x: 80, y: 70, width: 720, height: 100 }
          }],
          screenshotDataUrl: dataUrl
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("offscreen OCR smoke timeout")), 60_000))
      ]);
    }, screenshotDataUrl) as {
      accepted?: unknown;
      evidence?: {
        mediaType?: unknown;
        contentBase64?: unknown;
        ocrResult?: { text?: unknown; words?: unknown };
      };
    };
    if (response?.accepted !== true || response.evidence?.mediaType !== "image/webp"
      || typeof response.evidence.contentBase64 !== "string"
      || response.evidence.contentBase64.length === 0
      || typeof response.evidence.ocrResult?.text !== "string"
      || !Array.isArray(response.evidence.ocrResult.words)
      || response.evidence.ocrResult.words.length === 0) {
      throw new Error(`unpacked-extension offscreen OCR smoke failed: ${JSON.stringify(response)}`);
    }
    const semantic = (value: string) => value.normalize("NFC").replace(/\s/gu, "").replace(/,/gu, ".");
    const words = response.evidence.ocrResult.words as Array<{ text?: unknown }>;
    if (words.some((word) => typeof word?.text !== "string")
      || semantic(response.evidence.ocrResult.text) !== "中文报价128.50元"
      || semantic(words.map((word) => word.text as string).join("")) !== "中文报价128.50元"
      || JSON.stringify(response.evidence.ocrResult.text.match(/[0-9]+(?:[.,][0-9]+)*/gu))
        !== JSON.stringify(["128.50"])) {
      throw new Error(`unpacked-extension OCR text was duplicated or changed: ${JSON.stringify(response)}`);
    }
    const ended = await serviceWorker.evaluate(() => {
      const scope = globalThis as typeof globalThis & { chrome: any };
      return scope.chrome.runtime.sendMessage({
        kind: "visual_ocr_end_session",
        runtimeEpoch: "smoke-worker-epoch-0001",
        runtimeGeneration: 0
      });
    }) as { accepted?: unknown };
    if (ended?.accepted !== true) throw new Error("production OCR worker did not terminate");
  } finally {
    await context.close();
  }
} finally {
  await rm(profileDir, { recursive: true, force: true });
}

console.log("douyin visual reader unpacked-extension offscreen OCR smoke passed");
