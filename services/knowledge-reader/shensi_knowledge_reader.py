"""Bounded local reference extraction. No model, database, URL or credentials."""
import csv
import gc
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import resource
import sys
import zipfile
from xml.etree import ElementTree as ET

MAX_BYTES = 50 * 1024 * 1024
MAX_TEXT_BYTES = 32 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
MAX_CHUNKS = 50_000
VERSION = "shensi-reference-reader.v1-pdfium5.14.0-vision-ocrmac1.0.1"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class ReaderError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code="knowledge_artifact_invalid"):
    raise ReaderError(code)


class Chunks:
    def __init__(self):
        self.items = []
        self.bytes = 0

    def add(self, text, locator, warnings=()):
        text = text.strip()
        if not text:
            return
        self.bytes += len(text.encode("utf-8"))
        if self.bytes > MAX_TEXT_BYTES:
            fail("knowledge_reader_limit")
        # 1800 Python codepoints also fit 4000 UTF-16 units for non-BMP text.
        for start in range(0, len(text), 1800):
            if len(self.items) >= MAX_CHUNKS:
                fail("knowledge_reader_limit")
            part = text[start:start + 1800]
            positions = dict(locator)
            if len(text) > 1800:
                base = locator.get("startOffset", 0)
                positions.update(startOffset=base + start, endOffset=base + start + len(part))
            self.items.append({"order": len(self.items), "text": part,
                               "locator": positions, "warnings": sorted(set(warnings))})


def checked_xml(data):
    if len(data) > 16 * 1024 * 1024:
        fail("knowledge_reader_limit")
    try:
        text = data.decode("utf-8-sig", errors="strict")
        if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            fail()
        return ET.fromstring(text)
    except (UnicodeError, ET.ParseError):
        fail()


def checked_zip(path):
    try:
        archive = zipfile.ZipFile(path)
        entries = archive.infolist()
        if not entries or len(entries) > 2000:
            fail("knowledge_reader_limit")
        names = set()
        total = 0
        for entry in entries:
            name = entry.filename
            parts = PurePosixPath(name).parts
            if name in names or "\\" in name or name.startswith("/") or ".." in parts or ":" in name or "\x00" in name:
                fail()
            if entry.flag_bits & 1:
                fail("knowledge_password_required")
            names.add(name)
            total += entry.file_size
            if total > 25 * 1024 * 1024 or entry.file_size > 16 * 1024 * 1024 or entry.file_size > max(1, entry.compress_size) * 100:
                fail("knowledge_reader_limit")
            if name.endswith("vbaProject.bin"):
                fail("knowledge_macro_unsupported")
            if name.endswith((".xml", ".rels")):
                checked_xml(archive.read(entry))
        return archive
    except ReaderError:
        if "archive" in locals():
            archive.close()
        raise
    except (zipfile.BadZipFile, OSError, RuntimeError, EOFError):
        if "archive" in locals():
            archive.close()
        fail()


def paragraph_text(element):
    return "".join(node.text or "" if node.tag == W + "t" else "\n" if node.tag == W + "br" else "\t"
                   for node in element.iter() if node.tag in (W + "t", W + "br", W + "tab"))


def read_docx(path, chunks):
    with checked_zip(path) as archive:
        try:
            types = checked_xml(archive.read("[Content_Types].xml"))
            if not any(node.get("PartName") == "/word/document.xml" and node.get("ContentType") ==
                       "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" for node in types):
                fail()
            root = checked_xml(archive.read("word/document.xml"))
        except KeyError:
            fail()
    body = root.find(W + "body")
    if body is None:
        fail()
    paragraph, table, chapter = 0, 0, None
    for block in body:
        if block.tag == W + "p":
            paragraph += 1
            text = paragraph_text(block)
            style = block.find(W + "pPr/" + W + "pStyle")
            if style is not None and (style.get(W + "val") or "").lower().startswith("heading"):
                chapter = text[:300]
            locator = {"paragraph": paragraph}
            if chapter:
                locator["chapter"] = chapter
            chunks.add(text, locator, ["document_layout_unverified"])
        elif block.tag == W + "tbl":
            table += 1
            for row, tr in enumerate(block.findall(W + "tr"), 1):
                for column, tc in enumerate(tr.findall(W + "tc"), 1):
                    chunks.add("\n".join(paragraph_text(p) for p in tc.findall(W + "p")),
                               {"table": table, "row": row, "column": column}, ["table_unverified"])


def read_xlsx(path, chunks):
    with checked_zip(path) as archive:
        if "xl/workbook.xml" not in archive.namelist():
            fail()
    from openpyxl import load_workbook
    try:
        formulas = load_workbook(path, read_only=True, data_only=False, keep_links=False)
        cached = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    except Exception:
        fail()
    try:
        if not formulas.worksheets or len(formulas.worksheets) > 100:
            fail("knowledge_reader_limit")
        for sheet, cached_sheet in zip(formulas.worksheets, cached.worksheets):
            if len(sheet.title) > 200 or (sheet.max_row or 0) > 100_000 or (sheet.max_column or 0) > 1000:
                fail("knowledge_reader_limit")
            for row, cached_row in zip(sheet.iter_rows(), cached_sheet.iter_rows()):
                for cell, cached_cell in zip(row, cached_row):
                    if cell.value is None:
                        continue
                    warnings = ["table_unverified"]
                    if cell.data_type == "f":
                        warning = "formula_cached_unverified" if cached_cell.value is not None else "formula_cache_missing"
                        warnings.append(warning)
                        text = str(cell.value) + (" [cached: " + str(cached_cell.value) + "]" if cached_cell.value is not None else "")
                    else:
                        text = str(cell.value)
                    chunks.add(text, {"sheet": sheet.title, "row": cell.row, "column": cell.column}, warnings)
    finally:
        formulas.close()
        cached.close()


def read_text(path, fmt, chunks):
    try:
        text = path.read_text(encoding="utf-8-sig", errors="strict")
        if "\x00" in text:
            fail()
        if fmt == "csv":
            csv.field_size_limit(50_000)
            for row, values in enumerate(csv.reader(io.StringIO(text, newline=""), strict=True), 1):
                if row > 100_000 or len(values) > 1000:
                    fail("knowledge_reader_limit")
                for column, value in enumerate(values, 1):
                    chunks.add(value, {"sheet": "CSV", "row": row, "column": column}, ["table_unverified"])
            return
        chapter, offset = None, 0
        for line, value in enumerate(text.splitlines(keepends=True), 1):
            if fmt == "md" and value.startswith("#") and len(value.split(" ", 1)) == 2:
                chapter = value.lstrip("# ").strip()[:300]
            locator = {"startLine": line, "endLine": line, "startOffset": offset, "endOffset": offset + len(value)}
            if chapter:
                locator["chapter"] = chapter
            chunks.add(value, locator)
            offset += len(value)
    except (UnicodeError, csv.Error):
        fail()


def ocr_page(page):
    if sys.platform != "darwin":
        fail("knowledge_ocr_unavailable")
    width, height = page.get_size()
    scale = 4.0
    if not all(math.isfinite(n) and n > 0 for n in (width, height)) or width * height * scale * scale > 40_000_000 or max(width, height) * scale > 16_384:
        fail("knowledge_reader_limit")
    bitmap = page.render(scale=scale)
    image = bitmap.to_pil()
    try:
        # ocrmac's optional visualization backend is not part of text OCR.
        # Disable it in this isolated child, without editing installed packages.
        sys.modules.setdefault("matplotlib", None)
        from ocrmac.ocrmac import text_from_image
        values = text_from_image(image, recognition_level="accurate", language_preference=["zh-Hans", "en-US"], confidence_threshold=0.0)
        values.sort(key=lambda value: (-round(value[2][1], 2), value[2][0]))
        return "\n".join(value[0] for value in values), any(value[1] < 0.9 for value in values)
    except (ImportError, RuntimeError, ValueError):
        fail("knowledge_ocr_unavailable")
    finally:
        image.close()
        bitmap.close()


def read_pdf(path, chunks):
    import pypdfium2 as pdfium
    try:
        document = pdfium.PdfDocument(path)
    except pdfium.PdfiumError as error:
        if getattr(error, "err_code", None) == 4:
            fail("knowledge_password_required")
        fail()
    try:
        total, missing, warnings = len(document), [], {"pdf_visual_content_unverified"}
        if total < 1 or total > 1000:
            fail("knowledge_reader_limit")
        # Independent <=25 physical-page batches; no whole-book OCR conversion.
        for start in range(0, total, 25):
            for index in range(start, min(start + 25, total)):
                page = document[index]
                try:
                    text_page = page.get_textpage()
                    try:
                        text = text_page.get_text_range()
                    finally:
                        text_page.close()
                    flags = ["pdf_text_layout_unverified"]
                    if not text.strip():
                        try:
                            text, low_confidence = ocr_page(page)
                            flags = ["ocr_unverified", "tables_formulas_unverified"]
                            if low_confidence:
                                flags.append("ocr_low_confidence")
                        except ReaderError as error:
                            if error.code != "knowledge_ocr_unavailable":
                                raise
                            warnings.add(error.code)
                    if text.strip():
                        chunks.add(text, {"page": index + 1}, flags)
                    else:
                        missing.append(index + 1)
                finally:
                    page.close()
            gc.collect()
        if missing:
            warnings.add("pages_without_reliable_text")
        return {"totalPages": total, "extractedPages": total - len(missing), "missingPages": missing}, sorted(warnings)
    finally:
        document.close()


def read_document(path, fmt, size):
    path = Path(path)
    if not path.is_absolute() or not path.is_file() or path.is_symlink() or not isinstance(size, int) or isinstance(size, bool) or size < 1 or size > MAX_BYTES or path.stat().st_size != size:
        fail()
    chunks = Chunks()
    coverage, warnings = {"totalPages": None, "extractedPages": None, "missingPages": []}, []
    try:
        if fmt == "pdf":
            coverage, warnings = read_pdf(path, chunks)
        elif fmt == "docx":
            read_docx(path, chunks)
        elif fmt == "xlsx":
            read_xlsx(path, chunks)
        elif fmt in ("csv", "txt", "md"):
            read_text(path, fmt, chunks)
        else:
            fail()
    except ReaderError:
        raise
    except (MemoryError, OverflowError):
        fail("knowledge_reader_limit")
    except Exception:
        fail()
    if not chunks.items:
        fail("knowledge_text_unavailable")
    return {"parserVersion": VERSION, "coverage": coverage, "warnings": warnings, "chunks": chunks.items}


def main():
    os.umask(0o077)
    # Only one process, bounded CPU/files, native RSS watched by trusted parent.
    resource.setrlimit(resource.RLIMIT_CPU, (3600, 3600))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    request = sys.stdin.buffer.read(16_385)
    try:
        if len(request) > 16_384:
            fail()
        value = json.loads(request)
        if set(value) != {"inputPath", "format", "bytes"}:
            fail()
        result = read_document(value["inputPath"], value["format"], value["bytes"])
        response = json.dumps({"ok": True, "result": result}, ensure_ascii=False, separators=(",", ":"))
        if len(response.encode()) > MAX_OUTPUT:
            fail("knowledge_reader_limit")
    except ReaderError as error:
        response = json.dumps({"ok": False, "code": error.code})
    except Exception:
        response = json.dumps({"ok": False, "code": "knowledge_artifact_invalid"})
    sys.stdout.write(response)


if __name__ == "__main__":
    main()
