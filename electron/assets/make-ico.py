"""Generate a multi-size Windows .ico from the source PNG.

Usage: python electron/assets/make-ico.py [src.png] [out.ico]

Keeps the asset pipeline in Python (like make-profile-icon.py) so the Windows
build has a real .ico without pulling extra npm tooling into the repo.
The generated electron/assets/icon.ico is committed: electron-builder and
electron-packager both need it at packaging time.
"""
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "icon.png"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "icon.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]

img = Image.open(SRC).convert("RGBA")
# Square canvas with transparent padding if the source is not square: Windows
# draws the icon edge to edge, a stretched aspect would look cropped.
side = max(img.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
frames = [canvas.resize((s, s), Image.LANCZOS) for s in SIZES]
try:
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
except TypeError:  # older Pillow: let it resample from the 256px frame
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES])
print(f"wrote {OUT} ({OUT.stat().st_size} bytes, sizes {SIZES})")
