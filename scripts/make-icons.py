"""Генерує іконки клієнта (PNG 512x512 + багаторозмірний ICO) з аватара Discord."""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Temp", "opencode", "uploads", "185222b6-86e7-416a-baab-80e7eb892b5c", "image.png",
)

img = Image.open(SRC).convert("RGBA")
img = img.resize((512, 512), Image.LANCZOS)
img.save(os.path.join(ROOT, "build", "icon.png"), "PNG")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(os.path.join(ROOT, "build", "icon.ico"), "ICO", sizes=sizes)
print("OK", img.size, sizes)
