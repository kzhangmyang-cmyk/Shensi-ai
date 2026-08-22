# Third-party notices

## linkedom 0.18.13

- Repository: <https://github.com/WebReflection/linkedom>
- License: ISC
- Usage: development and test only, for parsing fixed HTML fixtures used by the Douyin visible-comment extractor self-tests
- Distribution: not included in the production browser-extension bundle
- Modifications: none

## tesseract.js 7.0.0

- Repository: <https://github.com/naptha/tesseract.js>
- License: Apache-2.0
- Usage: local OCR controller and dedicated extension worker for redacted comment-card WebP bytes
- Distribution: the worker is built from the pinned package source and shipped as `ocr/worker.min.js`; no CDN artifact is used
- Modifications: the extension build removes the upstream regenerator-runtime import because the target is native ES2022, removes the browser worker and language-data CDN fallbacks, requires a `chrome-extension://` or `moz-extension://` language path, and restricts the browser image loader and worker decoder to caller-supplied redacted WebP `Uint8Array` bytes. BMP support and its `bmp-js`/Node `Buffer` branch are omitted. The integration supplies a local core loader, rejects compressed runtime language data, and uses a no-op cache adapter, so OCR does not use IndexedDB or another persistent cache.

## tesseract.js-core 7.0.0

- Repository: <https://github.com/naptha/tesseract.js-core>
- License: Apache-2.0
- Usage: local LSTM-only Tesseract WASM runtime selected according to relaxed-SIMD, SIMD, or baseline browser support
- Distribution: the three LSTM JavaScript loaders and their matching WASM binaries are copied from the pinned package into `ocr/core/`
- Modifications: none; copied core JavaScript and WASM assets are byte-for-byte package files and are recorded in `ocr-assets.json`

## @tesseract.js-data/chi_sim 1.0.0

- Repository: <https://github.com/naptha/tessdata>
- License: MIT
- Usage: Simplified Chinese OCR language data
- Distribution: the pinned `4.0.0_best_int/chi_sim.traineddata.gz` is decompressed at build time and shipped as `ocr/lang/chi_sim.traineddata`
- Modifications: compression is removed without changing the traineddata payload; the shipped bytes are recorded in `ocr-assets.json`. Runtime decompression is deliberately disabled so the browser worker does not include a Node `Buffer` compatibility path.

The unpacked extension includes this notice plus full Apache-2.0 texts for
`tesseract.js` and `tesseract.js-core`, and the MIT text declared by both pinned
language-data packages, under `ocr/licenses/`. Those license files are also
covered by the byte-length and SHA-256 inventory in `ocr-assets.json`.

## @tesseract.js-data/eng 1.0.0

- Repository: <https://github.com/naptha/tessdata>
- License: MIT
- Usage: English, Latin-letter, and numeric OCR language data used alongside Simplified Chinese
- Distribution: the pinned `4.0.0_best_int/eng.traineddata.gz` is decompressed at build time and shipped as `ocr/lang/eng.traineddata`
- Modifications: compression is removed without changing the traineddata payload; the shipped bytes are recorded in `ocr-assets.json`. Runtime decompression is deliberately disabled so the browser worker does not include a Node `Buffer` compatibility path.
