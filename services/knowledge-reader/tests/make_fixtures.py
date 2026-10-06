"""Generate synthetic PDF fixtures only into the test's freshly owned directory."""
import io
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter


def make_fixtures(root):
    root = Path(root).resolve()
    if not root.is_dir() or not root.name.startswith("shensi-knowledge-reader-fixtures-"):
        raise ValueError("owned synthetic fixture directory required")
    native = PdfReader(root / "native.pdf")
    for filename, password in [("readable-marker.pdf", ""), ("password.pdf", "synthetic-only")]:
        writer = PdfWriter()
        writer.add_page(native.pages[0])
        writer.encrypt(password)
        with (root / filename).open("xb") as output:
            writer.write(output)
    writer = PdfWriter()
    writer.add_page(native.pages[0])
    writer.add_blank_page(width=400, height=200)
    with (root / "partial.pdf").open("xb") as output:
        writer.write(output)
    image = Image.new("RGB", (800, 300), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 40)
    draw.text((30, 100), "BUDGET CASH FLOW 120", font=font, fill="black")
    value = io.BytesIO()
    image.save(value, format="PDF", resolution=144)
    image.close()
    with (root / "scanned.pdf").open("xb") as output:
        output.write(value.getvalue())


if __name__ == "__main__":
    make_fixtures(sys.argv[1])
