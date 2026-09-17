from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs' / 'version-update.pdf'
FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'
PAGE_W, PAGE_H = A4

pdfmetrics.registerFont(TTFont('VoltaSans', FONT, subfontIndex=0))

BLUE = colors.HexColor('#245ca9')
NAVY = colors.HexColor('#172b4d')
MUTED = colors.HexColor('#64748b')
PALE = colors.HexColor('#eaf1fc')
GREEN = colors.HexColor('#2f7666')

styles = getSampleStyleSheet()
body = ParagraphStyle('body', parent=styles['BodyText'], fontName='VoltaSans', fontSize=14,
                      leading=25, textColor=NAVY, alignment=TA_LEFT, spaceAfter=8)
small = ParagraphStyle('small', parent=body, fontSize=10, leading=17, textColor=MUTED)
title = ParagraphStyle('title', parent=body, fontSize=34, leading=47, textColor=NAVY,
                       spaceAfter=12)
heading = ParagraphStyle('heading', parent=body, fontSize=21, leading=31, textColor=BLUE,
                         spaceBefore=10, spaceAfter=12)

def para(c, text, x, y, style=body, width=150*mm):
    p = Paragraph(text, style)
    _, h = p.wrap(width, PAGE_H)
    p.drawOn(c, x, y - h)
    return y - h

def frame(c, page, section):
    c.setFillColor(PALE)
    c.rect(0, PAGE_H - 42*mm, PAGE_W, 42*mm, fill=1, stroke=0)
    c.setFillColor(BLUE)
    c.rect(0, 0, 7*mm, PAGE_H, fill=1, stroke=0)
    c.setFont('VoltaSans', 9)
    c.setFillColor(MUTED)
    c.drawString(20*mm, 14*mm, 'VOLTA / 本地曲谱阅读器')
    c.drawRightString(PAGE_W - 18*mm, 14*mm, f'{section}  ·  {page}/3')

def page_one(c):
    frame(c, 1, '版本说明')
    y = PAGE_H - 68*mm
    c.setFillColor(BLUE)
    c.setFont('VoltaSans', 11)
    c.drawString(22*mm, y, 'VERSION UPDATE')
    y -= 14*mm
    y = para(c, 'Volta<br/><font color="#245ca9">本地曲谱优先</font>', 22*mm, y, title, 155*mm)
    y -= 8*mm
    y = para(c, '这个版本把曲谱看作你自己的本地资料库。应用本身只负责阅读、批注和导航，不把你的 PDF 上传到服务器。', 22*mm, y, body, 150*mm)
    y -= 12*mm
    c.setFillColor(colors.white)
    c.roundRect(22*mm, y - 39*mm, 150*mm, 39*mm, 5*mm, fill=1, stroke=0)
    c.setFillColor(BLUE)
    c.setFont('VoltaSans', 11)
    c.drawString(30*mm, y - 14*mm, '当前版本时间')
    c.setFillColor(NAVY)
    c.setFont('VoltaSans', 18)
    c.drawString(30*mm, y - 28*mm, '2026-09-17 08:46 (+02:00)')
    y -= 55*mm
    para(c, '启动后看到这一页是正常的。向左侧呼出谱架，选择“本地曲谱文件夹”，指定包含“曲谱库数据”的数据库根目录，之后即可打开你的曲谱。', 22*mm, y, small, 150*mm)

def page_two(c):
    frame(c, 2, '本次更新')
    y = PAGE_H - 68*mm
    c.setFillColor(BLUE)
    c.setFont('VoltaSans', 11)
    c.drawString(22*mm, y, 'WHAT CHANGED')
    y -= 16*mm
    y = para(c, '更可靠的本地历史记录', 22*mm, y, title, 155*mm)
    y -= 4*mm
    for head, text in [
        ('相对路径', '历史记录保存曲谱相对于本地数据库根目录的路径，例如“原神/璃月/作品/总谱.pdf”。不再依赖 Safari 重启后失效的临时链接。'),
        ('内容校验', '同时保存曲谱内容 ID。路径用于定位，ID 用于确认文件仍是同一份曲谱。'),
        ('本地优先', '曲谱库打开时优先使用当前选定的本地文件；书签和批注统一保存在这台设备的本机数据库。只有尚未指定数据库时，才停留在这份版本说明页。'),
    ]:
        c.setFillColor(PALE)
        c.roundRect(22*mm, y - 22*mm, 8*mm, 8*mm, 2*mm, fill=1, stroke=0)
        c.setFillColor(BLUE)
        c.setFont('VoltaSans', 13)
        c.drawCentredString(26*mm, y - 16*mm, '·')
        y = para(c, f'<b>{head}</b><br/>{text}', 36*mm, y - 1*mm, body, 136*mm)
        y -= 9*mm

def page_three(c):
    frame(c, 3, 'iPad 使用')
    y = PAGE_H - 68*mm
    c.setFillColor(BLUE)
    c.setFont('VoltaSans', 11)
    c.drawString(22*mm, y, 'LOCAL LIBRARY')
    y -= 16*mm
    y = para(c, '第一次使用，只需指定数据库', 22*mm, y, title, 155*mm)
    y -= 3*mm
    for number, text in [
        ('1', '从左侧谱架选择“本地曲谱文件夹”，选最外层的数据库根目录，不要只选“曲谱库数据”。'),
        ('2', '确认目录中有“曲谱库数据/catalog.json”和“曲谱库数据/manifest.json”，以及各个曲谱文件夹。'),
        ('3', '打开曲谱后，历史记录会记住相对路径。今后同一数据库中的曲谱会按本地文件读取。'),
    ]:
        c.setFillColor(BLUE)
        c.circle(28*mm, y - 8*mm, 5*mm, fill=1, stroke=0)
        c.setFillColor(colors.white)
        c.setFont('VoltaSans', 11)
        c.drawCentredString(28*mm, y - 12*mm, number)
        y = para(c, text, 40*mm, y, body, 132*mm)
        y -= 7*mm
    c.setFillColor(PALE)
    c.roundRect(22*mm, y - 43*mm, 150*mm, 43*mm, 5*mm, fill=1, stroke=0)
    y -= 12*mm
    y = para(c, '<b>提示</b><br/>iPad Safari 不允许网页永久保存《文件》App 的文件夹授权。若系统要求重新选择数据库，这是 Safari 的权限限制；选择同一个根目录即可恢复。历史记录不会因此变成失效链接，书签和批注仍保存在这台设备。', 30*mm, y, small, 134*mm)
    para(c, '版本说明结束 · 现在可以打开谱架', 22*mm, 42*mm, small, 150*mm)

def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=A4)
    c.setTitle('Volta 版本说明')
    c.setAuthor('Volta')
    for page in (page_one, page_two, page_three):
        page(c)
        c.showPage()
    c.save()
    print(OUTPUT)

if __name__ == '__main__':
    main()
