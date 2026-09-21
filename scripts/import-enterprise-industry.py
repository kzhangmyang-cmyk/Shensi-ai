"""Extract only public classification codes/names, never explanatory notes.

Usage: python3 scripts/import-enterprise-industry.py official.xlsx
Source and reuse assessment: docs/modules/enterprise-industry-data.md
"""
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(sys.argv[1]) as book:
    strings = ["".join(x.itertext()) for x in ET.fromstring(book.read("xl/sharedStrings.xml")).findall("s:si", NS)]
    sheet = ET.fromstring(book.read("xl/worksheets/sheet1.xml"))
    records = []
    section = ""
    for row in sheet.findall("s:sheetData/s:row", NS):
        cells = {}
        for cell in row.findall("s:c", NS):
            value = cell.find("s:v", NS)
            text = value.text if value is not None else ""
            if cell.get("t") == "s":
                text = strings[int(text)]
            cells[re.sub(r"\d", "", cell.get("r"))] = (text or "").strip()
        for column in ("A", "B"):
            code = cells.get(column, "")
            if not re.fullmatch(r"[A-T]|\d{2,4}", code):
                continue
            if len(code) == 1:
                section = code
            parent = "" if len(code) == 1 else section if len(code) == 2 else code[:-1]
            records.append([code, cells["D"].strip(), parent])
assert [sum(len(r[0]) == n for r in records) for n in (1, 2, 3, 4)] == [20, 97, 473, 1382]
assert len({r[0] for r in records}) == len(records)
assert all(r[1] and (not r[2] or r[2] in {x[0] for x in records}) for r in records)
target = Path(__file__).resolve().parents[1] / "frontend/src/enterprise-query/industry-data.ts"
target.write_text("// Generated from NBS GB/T 4754-2017, 2019 amendment. See docs/modules/enterprise-industry-data.md.\nexport const industryData: readonly (readonly [string, string, string])[] = " + json.dumps(records, ensure_ascii=False, separators=(",", ":")) + ";\n")
print(f"Extracted {len(records)} classification nodes to {target}")
