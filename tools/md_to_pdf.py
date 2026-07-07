from pathlib import Path
import os
import re
import sys
import textwrap
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted, Image


FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]
FONT_PATH = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
FONT_NAME = "Helvetica"
if FONT_PATH:
    pdfmetrics.registerFont(TTFont("CJK", FONT_PATH))
    FONT_NAME = "CJK"

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="CNTitle", fontName=FONT_NAME, fontSize=24, leading=32, alignment=TA_CENTER, textColor=colors.HexColor("#17171f"), spaceAfter=10 * mm))
styles.add(ParagraphStyle(name="CNSub", fontName=FONT_NAME, fontSize=11, leading=18, alignment=TA_CENTER, textColor=colors.HexColor("#6f7480"), spaceAfter=14 * mm))
styles.add(ParagraphStyle(name="CNH1", fontName=FONT_NAME, fontSize=18, leading=25, textColor=colors.HexColor("#b7192b"), spaceBefore=9 * mm, spaceAfter=4 * mm))
styles.add(ParagraphStyle(name="CNH2", fontName=FONT_NAME, fontSize=14, leading=22, textColor=colors.HexColor("#252a36"), spaceBefore=6 * mm, spaceAfter=3 * mm))
styles.add(ParagraphStyle(name="CNH3", fontName=FONT_NAME, fontSize=12, leading=20, textColor=colors.HexColor("#3b4150"), spaceBefore=4 * mm, spaceAfter=2 * mm))
styles.add(ParagraphStyle(name="CNBody", fontName=FONT_NAME, fontSize=10.5, leading=18, firstLineIndent=7 * mm, alignment=TA_LEFT, textColor=colors.HexColor("#262b36"), spaceAfter=2.8 * mm))
styles.add(ParagraphStyle(name="CNBullet", fontName=FONT_NAME, fontSize=10.3, leading=17, leftIndent=7 * mm, firstLineIndent=-4 * mm, textColor=colors.HexColor("#303643"), spaceAfter=2 * mm))
styles.add(ParagraphStyle(name="CNQuote", fontName=FONT_NAME, fontSize=10.5, leading=18, leftIndent=7 * mm, rightIndent=5 * mm, textColor=colors.HexColor("#5c6472"), backColor=colors.HexColor("#f5f6fa"), borderPadding=6, spaceAfter=3 * mm))
styles.add(ParagraphStyle(name="CNPre", fontName=FONT_NAME, fontSize=8.2, leading=12, leftIndent=2 * mm, textColor=colors.HexColor("#1e2533"), backColor=colors.HexColor("#f3f5f9"), borderPadding=5, spaceAfter=3 * mm))

EMOJI_RE = re.compile("[\U00010000-\U0010ffff]", flags=re.UNICODE)


def clean(text):
    return EMOJI_RE.sub("", text).replace("—", "-").replace("–", "-").replace("‑", "-").strip()


def paragraphify(text):
    text = escape(clean(text))
    text = re.sub(r"`([^`]+)`", r'<font color="#b7192b">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text


def add_para(story, buf):
    if buf:
        story.append(Paragraph(paragraphify(" ".join(buf)), styles["CNBody"]))
        buf.clear()


def code_block(text):
    lines = []
    for line in clean(text).splitlines():
        lines.extend(textwrap.wrap(line, 86, replace_whitespace=False, drop_whitespace=False) or [""])
    return "\n".join(lines)


def story_from_markdown(md_text, title, cover_image=None):
    story = [
        Spacer(1, 22 * mm),
        Paragraph(escape(clean(title)), styles["CNTitle"]),
        Paragraph("Fate Weather Station - digital art interactive prototype", styles["CNSub"]),
    ]
    if cover_image and Path(cover_image).exists():
        story.append(Image(str(cover_image), width=132 * mm, height=88 * mm))
        story.append(Spacer(1, 8 * mm))
    story.append(PageBreak())

    in_code = False
    code_lines = []
    buf = []
    for raw in md_text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith("```"):
            if not in_code:
                add_para(story, buf)
                in_code = True
                code_lines = []
            else:
                story.append(Preformatted(code_block("\n".join(code_lines)), styles["CNPre"]))
                in_code = False
            continue
        if in_code:
            code_lines.append(line)
            continue
        if not stripped:
            add_para(story, buf)
            continue
        if stripped.startswith("#"):
            add_para(story, buf)
            level = len(stripped) - len(stripped.lstrip("#"))
            text = stripped[level:].strip()
            style = "CNH1" if level == 1 else "CNH2" if level == 2 else "CNH3"
            story.append(Paragraph(paragraphify(text), styles[style]))
        elif stripped.startswith(">"):
            add_para(story, buf)
            story.append(Paragraph(paragraphify(stripped.lstrip(">").strip()), styles["CNQuote"]))
        elif stripped.startswith(("-", "*")) or re.match(r"^\d+\.\s+", stripped):
            add_para(story, buf)
            story.append(Paragraph(paragraphify(re.sub(r"^([-*]|\d+\.)\s+", "- ", stripped)), styles["CNBullet"]))
        elif stripped.startswith("|"):
            add_para(story, buf)
            story.append(Preformatted(code_block(stripped), styles["CNPre"]))
        else:
            buf.append(stripped)
    add_para(story, buf)
    if in_code and code_lines:
        story.append(Preformatted(code_block("\n".join(code_lines)), styles["CNPre"]))
    return story


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT_NAME, 8)
    canvas.setFillColor(colors.HexColor("#8a90a0"))
    canvas.drawString(18 * mm, 10 * mm, "Fate Weather Station")
    canvas.drawRightString(192 * mm, 10 * mm, str(doc.page))
    canvas.restoreState()


def md_to_pdf(md_path, out_pdf, cover_image=None):
    md_path = Path(md_path)
    out_pdf = Path(out_pdf)
    out_pdf.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(out_pdf), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=17 * mm, bottomMargin=16 * mm)
    story = story_from_markdown(md_path.read_text(encoding="utf-8-sig", errors="ignore"), md_path.stem, cover_image)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python md_to_pdf.py input.md output.pdf [cover_image]")
        raise SystemExit(2)
    md_to_pdf(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
