export function assertLosslessRedactedWebp(input: {
  encodedByteLength: number;
  original: Uint8ClampedArray;
  decoded: Uint8ClampedArray;
}): void {
  if (!Number.isSafeInteger(input.encodedByteLength)
    || input.encodedByteLength < 1 || input.encodedByteLength > 262_144) {
    throw new Error("redacted WebP exceeds 256 KiB");
  }
  if (!(input.original instanceof Uint8ClampedArray)
    || !(input.decoded instanceof Uint8ClampedArray)
    || input.original.length !== input.decoded.length) {
    throw new Error("redacted WebP lossless verification failed");
  }
  for (let index = 0; index < input.original.length; index += 1) {
    if (input.original[index] !== input.decoded[index]) {
      throw new Error("redacted WebP lossless verification failed");
    }
  }
}
