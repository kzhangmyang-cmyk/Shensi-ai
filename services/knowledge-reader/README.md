# Local reference reader

This module extracts reference data, never agent instructions or verified company
facts. The backend owns authorization, encrypted originals, persisted jobs and
publication. The reader receives one authenticated temporary file path, format
and declared size; it holds no model, account, search or database credentials.

## Runtime

Use an explicitly configured, trusted Python 3.12 runtime with the exact package
pins in `pyproject.toml`. `SHENSI_KNOWLEDGE_READER_PYTHON` and
`SHENSI_KNOWLEDGE_READER_SCRIPT` are Main/local-launcher configuration, not
Renderer inputs. No temporary preflight path is hardcoded in product code. The
backend verifies installed versions before use. Runtime packaging/configuration
and client installer distribution have not been completed by this stage.

macOS production calls use `sandbox-exec`: no network or child processes; private
content reads are limited to the one canonical input, reader script and trusted
runtime libraries. System loader paths and `/` itself are readable for dyld's
openat bootstrap, not the entire filesystem. Path metadata remains readable.
Only the owned temporary directory is writable. Standard output has a64MiB
ceiling, native RSS a1536MiB watchdog, CPU/total processing at most60minutes,
and files at most50MiB. Cancellation waits for process exit before plaintext
cleanup. Non-macOS extraction is unavailable, not an unsandboxed fallback.

## Formats and reference precision

- Text PDF: local PDFium, at most1000 physical pages, processed in batches of at
  most25 pages. Physical page numbers are never renumbered to printed page labels.
- Scanned pages: local macOS Vision through ocrmac, Chinese/English accurate
  recognition at scale4, with bounded raster dimensions/pixels. Optional plotting
  is disabled in the isolated child. No Docling model download/cache is needed.
- Readable PDF encryption flags are not a failure; actual password-required
  errors are rejected. No password cracking or decryption workflow.
- DOCX: bounded ZIP and XML validation; retain paragraph/heading and table cell
  coordinates. No document macros, external entities, URL parsing or execution.
- XLSX: bounded archive validation and openpyxl read-only parsing; original cells
  and cached formula values only. Missing formula caches are explicit; formulas
  are never calculated.
- CSV/TXT/MD: strict UTF-8, original logical rows or lines and chapter headings.
  Text offsets use Unicode codepoint positions. Each reference chunk is at most
 1800 codepoints, fitting the shared4000 UTF-16 character ceiling.

Maximum32MiB extracted text and50000 chunks; exceeding a budget fails explicitly,
not a hidden truncation. Blank/unreadable pages remain in `missingPages`; no text
is a failure. OCR, layout, tables and formulas retain uncertainty markers. Current
tax/legal applicability requires separate authoritative verification downstream.
Extraction success alone is not a ready/searchable version: the worker publishes
only after a real index callback and fresh account/membership authorization.
Automatic polling stays off before that callback exists, avoiding repeated OCR.

## Dependencies and licensing

Reuse the installed runtime, without copying its large environment or installing
a second one. `uv.lock` is to be resolved and checked in this stage; until it is
present and validated, dependency locking is not complete. `uv lock` resolves
public package metadata, not private documents; it does not install packages.

Exact runtime pins: PDFium wrapper pypdfium2 5.14.0 (BSD/Apache dual; PDFium and
bundled dependencies carry additional notices), Pillow12.3.0 (MIT-CMU),
openpyxl3.1.5 (MIT), ocrmac1.0.1 (MIT; macOS system Vision is not redistributed).
PyObjC transitive packages retain their own notices. Synthetic encryption tests
reuse the already installed pypdf6.19.0 (BSD-3-Clause), not a production decoder.
Use upstream implementations; any future distribution must preserve complete
package/native dependency notices. No OCR model cache or user book belongs in
the customer App/DMG, GitHub or a public search request.

## Tests

With an existing trusted runtime selected (no new dependency synchronization):

```bash
# VIRTUAL_ENV is the existing installed runtime selected by the developer.
uv run --frozen --no-sync --active --project services/knowledge-reader \
  python -m unittest discover -s services/knowledge-reader/tests -v
# Explicit SHENSI_TEST_KNOWLEDGE_PYTHON enables actual synthetic format/OCR tests.
pnpm --dir backend test:knowledge
pnpm --dir backend test:finance-documents
```

Tests use stdlib unittest instead of adding pytest to an already working runtime.
Fixtures are freshly generated synthetic PDFs/archives, never the user's books.
The original21-PDF extraction is preserved and not repeated here.
