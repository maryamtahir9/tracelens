"""Renders media/icon.svg's geometry to icon.png (256x256) with Pillow. Run: python3 scripts/generate-icon.py"""
from PIL import Image, ImageDraw

S = 8                      # supersampling factor
SIZE = 128 * S


def sc(v):
    return v * S


img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=sc(24), fill=(16, 28, 44, 255))
teal, white = (79, 209, 197, 255), (255, 255, 255, 255)


def thick_line(points, width, color):
    d.line([(sc(x), sc(y)) for x, y in points], fill=color, width=sc(width), joint="curve")
    r = sc(width) / 2
    for x, y in (points[0], points[-1]):
        d.ellipse([sc(x) - r, sc(y) - r, sc(x) + r, sc(y) + r], fill=color)


cx, cy, r, w = 56, 56, 31, 9
d.ellipse([sc(cx - r - w / 2), sc(cy - r - w / 2), sc(cx + r + w / 2), sc(cy + r + w / 2)], fill=teal)
d.ellipse([sc(cx - r + w / 2), sc(cy - r + w / 2), sc(cx + r - w / 2), sc(cy + r - w / 2)], fill=(16, 28, 44, 255))
thick_line([(79, 79), (106, 106)], 12, teal)
thick_line([(33, 58), (45, 58), (51, 41), (60, 75), (66, 50), (71, 58), (79, 58)], 5, white)
img.resize((256, 256), Image.LANCZOS).save("icon.png")
print("icon.png written")
