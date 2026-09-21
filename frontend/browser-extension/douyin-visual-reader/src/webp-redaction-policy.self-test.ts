import { strict as assert } from "node:assert";
import { assertLosslessRedactedWebp } from "./webp-redaction-policy";

const original = new Uint8ClampedArray([
  17, 61, 51, 255,
  250, 250, 250, 255,
  17, 61, 51, 255
]);

assert.doesNotThrow(() => assertLosslessRedactedWebp({
  encodedByteLength: 8_192,
  original,
  decoded: new Uint8ClampedArray(original)
}));

const colorShift = new Uint8ClampedArray(original);
colorShift[0] = 16;
assert.throws(() => assertLosslessRedactedWebp({
  encodedByteLength: 8_192,
  original,
  decoded: colorShift
}), /lossless/u, "even a one-channel mask change is rejected");

assert.throws(() => assertLosslessRedactedWebp({
  encodedByteLength: 262_145,
  original,
  decoded: new Uint8ClampedArray(original)
}), /256 KiB/u);

console.log("WebP redaction policy self-test passed");
