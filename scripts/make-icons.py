"""Generate launcher icons from the bundled app logo."""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "app-logo.png")

img = Image.open(SRC).convert("RGBA")
img = img.resize((512, 512), Image.LANCZOS)
img.save(os.path.join(ROOT, "build", "icon.png"), "PNG")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(os.path.join(ROOT, "build", "icon.ico"), "ICO", sizes=sizes)
print("OK", img.size, sizes)
