"""Check rendered report pagination; requires pypdf. Accepts PDF paths as arguments."""
import sys
import unicodedata
from pypdf import PdfReader

labels = {"资料记载", "分析判断", "建议与复核", "判断与关注点", "建议先做", "原始资料索引"}
for path in sys.argv[1:]:
    reader = PdfReader(path)
    for number, page in enumerate(reader.pages, 1):
        lines = [unicodedata.normalize("NFKC", line).strip() for line in page.extract_text().splitlines() if line.strip()]
        # Chromium prints margin counters before body text; also tolerate trailing counters.
        while lines and (lines[-1].replace(" ", "") == f"{number}/{len(reader.pages)}" or lines[-1].startswith("SHENSI  /")):
            lines.pop()
        assert lines, f"{path}: blank page {number}"
        assert lines[-1] not in labels, f"{path}: orphan heading on page {number}: {lines[-1]}"
    print(f"{path}: {len(reader.pages)} pages, no empty pages or orphan block labels")
