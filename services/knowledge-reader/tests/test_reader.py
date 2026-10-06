"""Synthetic document tests only; never reads customer/book paths."""
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from shensi_knowledge_reader import read_document, ReaderError


class ReaderTests(unittest.TestCase):
    def parse(self, data, fmt):
        with tempfile.TemporaryDirectory(prefix="shensi-reader-test-") as root:
            path = Path(root) / ("original." + fmt)
            path.write_bytes(data)
            return read_document(path, fmt, len(data))

    def test_text_and_markdown_offsets(self):
        result = self.parse("# 预算目标\n回款与现金流".encode(), "md")
        self.assertEqual(result["coverage"]["totalPages"], None)
        self.assertEqual(result["chunks"][0]["locator"]["startLine"], 1)
        self.assertEqual(result["chunks"][-1]["locator"]["chapter"], "预算目标")

    def test_csv_coordinates_and_nonempty(self):
        result = self.parse("项目,预算\n回款,120".encode(), "csv")
        self.assertEqual(result["chunks"][-1]["locator"], {"sheet": "CSV", "row": 2, "column": 2})
        with self.assertRaises(ReaderError):
            self.parse(b"\n", "txt")

    def test_zip_traversal_and_doctype_are_rejected(self):
        for name, content in [("../word/document.xml", "bad"), ("word/document.xml", '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x/>')]:
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w") as archive:
                archive.writestr(name, content)
            with self.assertRaises(ReaderError):
                self.parse(output.getvalue(), "docx")

    def test_declared_size_and_unicode_chunks_are_bounded(self):
        result = self.parse(("预算现金流🙂" * 1000).encode(), "txt")
        self.assertTrue(all(len(chunk["text"].encode("utf-16-le")) // 2 <= 4000 for chunk in result["chunks"]))
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "text.txt"
            path.write_bytes(b"test")
            with self.assertRaises(ReaderError):
                read_document(path, "txt", 3)

    def test_pdf_normal_encrypted_marker_does_not_mean_password_is_required(self):
        from pypdf import PdfWriter
        for password in ("", "synthetic-password"):
            writer = PdfWriter()
            writer.add_blank_page(width=400, height=200)
            writer.encrypt(password)
            buffer = io.BytesIO()
            writer.write(buffer)
            # A blank readable page fails for no text, not its encryption flag.
            with self.assertRaises(ReaderError) as caught:
                self.parse(buffer.getvalue(), "pdf")
            self.assertEqual(caught.exception.code, "knowledge_password_required" if password else "knowledge_text_unavailable")

    def test_actual_local_vision_scanned_pdf_marks_ocr_unverified(self):
        if sys.platform != "darwin":
            self.skipTest("macOS Vision only")
        from PIL import Image, ImageDraw, ImageFont
        image = Image.new("RGB", (800, 300), "white")
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 40)
        draw.text((30, 100), "BUDGET CASH FLOW 120", font=font, fill="black")
        output = io.BytesIO()
        image.save(output, format="PDF", resolution=144)
        image.close()
        result = self.parse(output.getvalue(), "pdf")
        self.assertEqual(result["coverage"], {"totalPages": 1, "extractedPages": 1, "missingPages": []})
        self.assertIn("BUDGET", result["chunks"][0]["text"])
        self.assertIn("ocr_unverified", result["chunks"][0]["warnings"])


if __name__ == "__main__":
    unittest.main()
