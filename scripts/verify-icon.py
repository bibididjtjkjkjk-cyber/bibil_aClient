"""Порівнює іконку, витягнуту з exe, з вихідною авою."""
import os
from PIL import Image, ImageChops, ImageStat

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, "build", "discord-logo-1024.png")
extracted = os.path.join(os.environ.get("TEMP", ""), "bibil-exe-icon.png")

a = Image.open(src).convert("RGBA").resize((32, 32), Image.LANCZOS)
b = Image.open(extracted).convert("RGBA")
diff = ImageStat.Stat(ImageChops.difference(a, b)).mean
print("Source 32x32 vs EXE icon — mean channel difference:", [round(x, 2) for x in diff])
print("MATCH" if max(diff) < 12 else "DIFFERENT")
