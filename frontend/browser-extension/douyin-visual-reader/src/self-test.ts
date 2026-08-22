const tests = [
  "./manifest.self-test.ts",
  "./protocol.self-test.ts",
  "./visual-pipeline.self-test.ts",
  "./tesseract-ocr.self-test.ts",
  "./visual-capture-guard.self-test.ts",
  "./visual-capture-runtime.self-test.ts",
  "./visual-capture-authorization.self-test.ts",
  "./visual-coordinator-ownership.self-test.ts",
  "./visual-transition-barrier.self-test.ts",
  "./service-worker-popup-confirm.self-test.ts",
  "./visual-evidence-validator.self-test.ts",
  "./offscreen-lifecycle.self-test.ts",
  "./visual-content-fallback.self-test.ts",
  "./webp-redaction-policy.self-test.ts",
  "./douyin-extractor.self-test.ts",
  "./popup-model.self-test.ts",
  "./popup-privacy-copy.self-test.ts",
  "./tab-guard.self-test.ts",
  "./orchestration.self-test.ts",
  "./reader-reliability.self-test.ts",
  "./content-start.self-test.ts",
  "./service-reliability.self-test.ts",
  "./restart-recovery.self-test.ts"
];

for (const test of tests) await import(test);

console.log("douyin visual reader extension self-test passed");

export {};
