from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math
import os
import random

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets"
OUT.mkdir(parents=True, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]
FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)


def font(size):
    if FONT_PATH:
        return ImageFont.truetype(FONT_PATH, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return int(a + (b - a) * t)


def blend(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def radial_gradient(size, inner, outer, center=(0.5, 0.38), radius=0.75):
    w, h = size
    img = Image.new("RGB", size, outer)
    pix = img.load()
    cx, cy = w * center[0], h * center[1]
    maxd = math.sqrt((w * radius) ** 2 + (h * radius) ** 2)
    for y in range(h):
        for x in range(w):
            t = max(0, min(1, math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxd))
            pix[x, y] = blend(inner, outer, t)
    return img


def draw_cloud(draw, cx, cy, scale, alpha=58):
    color = (218, 226, 240, alpha)
    draw.ellipse((cx - 70 * scale, cy - 28 * scale, cx + 70 * scale, cy + 34 * scale), fill=color)
    draw.ellipse((cx - 48 * scale, cy - 58 * scale, cx + 16 * scale, cy + 24 * scale), fill=color)
    draw.ellipse((cx - 8 * scale, cy - 70 * scale, cx + 70 * scale, cy + 26 * scale), fill=color)


def draw_orb(name, title, subtitle, palette, lightning=False, clouds=False, sun=False):
    width, height = 1200, 800
    bg = radial_gradient((width, height), palette["bg1"], palette["bg2"], center=(0.5, 0.15), radius=0.9).convert("RGBA")
    draw = ImageDraw.Draw(bg, "RGBA")

    for x in range(0, width, 60):
        draw.line((x, 560, x + 220, 800), fill=(255, 255, 255, 18), width=1)
    for y in range(580, 800, 42):
        draw.line((0, y, width, y), fill=(255, 255, 255, 16), width=1)

    if sun:
        for r, a in [(170, 30), (120, 45), (72, 70)]:
            draw.ellipse((95 - r, 105 - r, 95 + r, 105 + r), fill=(*palette["accent"], a))
        draw.ellipse((58, 68, 132, 142), fill=(255, 236, 148, 220))

    if clouds:
        for cx, cy, scale in [(190, 145, 1.2), (950, 130, 1.0), (850, 240, 0.75)]:
            draw_cloud(draw, cx, cy, scale)

    if lightning:
        for seed in range(7):
            random.seed(seed)
            x = random.randint(120, 1080)
            y = random.randint(60, 360)
            pts = [(x, y), (x - 24, y + 78), (x + 18, y + 70), (x - 26, y + 170), (x + 50, y + 54), (x + 8, y + 62)]
            draw.polygon(pts, fill=(180, 215, 255, 80))

    draw.ellipse((350, 622, 850, 705), fill=(0, 0, 0, 85))
    draw.rounded_rectangle((430, 595, 770, 720), radius=30, fill=(18, 20, 30, 255), outline=(255, 255, 255, 38), width=2)
    draw.ellipse((405, 570, 795, 645), fill=(70, 76, 92, 255), outline=(255, 255, 255, 50), width=2)
    draw.ellipse((460, 588, 740, 632), fill=(14, 16, 24, 220))

    orb_center = (600, 355)
    radius = 205
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow, "RGBA")
    for i in range(10, 0, -1):
        rr = radius + i * 24
        alpha = int((11 - i) * palette["glow"] / 12)
        glow_draw.ellipse((orb_center[0] - rr, orb_center[1] - rr, orb_center[0] + rr, orb_center[1] + rr), outline=(*palette["orb2"], alpha), width=28)
    bg.alpha_composite(glow.filter(ImageFilter.GaussianBlur(15)))

    orb = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    orb_draw = ImageDraw.Draw(orb, "RGBA")
    for r in range(radius, 0, -2):
        t = r / radius
        c = blend(palette["orb1"], palette["orb2"], t * 0.72)
        c = blend(c, palette["orb3"], max(0, t - 0.55) * 0.85)
        orb_draw.ellipse((orb_center[0] - r, orb_center[1] - r, orb_center[0] + r, orb_center[1] + r), fill=(*c, 255))

    for i in range(16):
        random.seed(i + 12)
        a = random.randint(18, 45)
        box = (
            orb_center[0] - radius + random.randint(-25, 25),
            orb_center[1] - radius + random.randint(-25, 25),
            orb_center[0] + radius + random.randint(-25, 25),
            orb_center[1] + radius + random.randint(-25, 25),
        )
        orb_draw.arc(box, start=random.randint(0, 260), end=random.randint(90, 350), fill=(255, 255, 255, a), width=random.randint(1, 3))

    if lightning:
        orb_draw.line([(535, 300), (610, 340), (575, 360), (655, 432), (625, 365), (690, 374)], fill=(235, 247, 255, 150), width=7, joint="curve")

    orb_draw.ellipse((500, 220, 610, 270), fill=(255, 255, 255, 92))
    orb_draw.ellipse((632, 185, 690, 210), fill=(255, 255, 255, 42))
    bg.alpha_composite(orb)

    draw = ImageDraw.Draw(bg, "RGBA")
    draw.rounded_rectangle((64, 620, 392, 714), radius=26, fill=(12, 15, 25, 178), outline=(255, 255, 255, 52), width=1)
    draw.text((92, 640), title, font=font(34), fill=(255, 255, 255, 240))
    draw.text((92, 686), subtitle, font=font(19), fill=(255, 255, 255, 176))
    draw.text((856, 642), "FATE WEATHER STATION", font=font(22), fill=(255, 255, 255, 180))
    draw.text((856, 678), "赔率盈亏 -> 色相 / 亮度 / 光晕", font=font(20), fill=(255, 255, 255, 136))
    bg.convert("RGB").save(OUT / name, quality=95)


PALETTES = {
    "sun": dict(bg1=(80, 48, 38), bg2=(12, 16, 28), accent=(255, 191, 73), orb1=(255, 250, 190), orb2=(255, 176, 58), orb3=(150, 64, 90), glow=42),
    "cloud": dict(bg1=(55, 72, 92), bg2=(10, 16, 28), accent=(158, 190, 210), orb1=(218, 232, 232), orb2=(98, 128, 154), orb3=(49, 56, 91), glow=28),
    "storm": dict(bg1=(42, 32, 84), bg2=(5, 8, 22), accent=(160, 190, 255), orb1=(184, 210, 255), orb2=(92, 82, 222), orb3=(32, 20, 75), glow=65),
}


if __name__ == "__main__":
    draw_orb("orb-concept-sun.png", "琥珀晴天", "短期返还偏高 / 幸运幻觉", PALETTES["sun"], sun=True)
    draw_orb("orb-concept-cloud.png", "铅灰阴霾", "返还率回落 / 概率冷却", PALETTES["cloud"], clouds=True)
    draw_orb("orb-concept-storm.png", "紫电风暴", "长期净亏损 / 命运收敛", PALETTES["storm"], lightning=True, clouds=True)
    Image.open(OUT / "orb-concept-storm.png").resize((900, 600)).save(OUT / "wx-share-thumb.jpg", quality=92)
    print(f"created assets in {OUT}")

