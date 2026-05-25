"""
build_template.py — Builds templates/cctv.docx from scratch using python-docx.

The template uses docxtemplater placeholder syntax:
  {field_name}              — simple text substitution
  {#loop_name}...{/loop_name} — array iteration
  {%image_tag}              — image embedding (image-module-free)

This is a STARTER template — Hebrew RTL is enabled per paragraph, fonts default
to Arial. The user can refine fonts/colors/cover by editing the resulting docx
in Word (placeholders survive normal Word editing as long as they stay in one
text-run).
"""

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


def set_rtl(paragraph):
    """Enable RTL on a paragraph."""
    pPr = paragraph._p.get_or_add_pPr()
    bidi = OxmlElement('w:bidi')
    bidi.set(qn('w:val'), '1')
    pPr.append(bidi)


def set_table_rtl(table):
    """Enable RTL on a table."""
    tblPr = table._tbl.tblPr
    bidiVisual = OxmlElement('w:bidiVisual')
    bidiVisual.set(qn('w:val'), '1')
    tblPr.append(bidiVisual)


def set_section_rtl(section):
    """Enable RTL at the section level so it cascades to all content,
    including paragraphs that docxtemplater creates dynamically inside
    {#loops} or where it inserts images."""
    sectPr = section._sectPr
    bidi = OxmlElement('w:bidi')
    bidi.set(qn('w:val'), '1')
    # Insert as the first child so Word reads it before page setup
    sectPr.insert(0, bidi)


def set_style_rtl(style):
    """Enable RTL on a style's paragraph-properties so any paragraph
    using this style (including ones created at render time) inherits
    bidi without us having to set it per-paragraph."""
    pPr = style.element.get_or_add_pPr()
    # Avoid duplicating <w:bidi/> if already present
    existing = pPr.findall(qn('w:bidi'))
    for e in existing:
        pPr.remove(e)
    bidi = OxmlElement('w:bidi')
    bidi.set(qn('w:val'), '1')
    pPr.append(bidi)
    # Also pin right alignment on the style itself (jc=right is RTL's "natural left")
    jc = pPr.find(qn('w:jc'))
    if jc is None:
        jc = OxmlElement('w:jc')
        pPr.append(jc)
    jc.set(qn('w:val'), 'right')


def shade_cell(cell, color_hex):
    """Apply background shading to a cell."""
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color_hex)
    tcPr.append(shd)


def add_heading_rtl(doc, text, level=1):
    h = doc.add_heading(text, level=level)
    set_rtl(h)
    h.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    return h


def add_para_rtl(doc, text='', bold=False, size=None, align=WD_ALIGN_PARAGRAPH.RIGHT):
    p = doc.add_paragraph()
    set_rtl(p)
    p.alignment = align
    if text:
        run = p.add_run(text)
        if bold:
            run.bold = True
        if size:
            run.font.size = Pt(size)
        run.font.name = 'Arial'
    return p


def add_bullet_rtl(doc, text):
    p = doc.add_paragraph(style='List Bullet')
    set_rtl(p)
    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    if text:
        run = p.add_run(text)
        run.font.name = 'Arial'
    return p


def build():
    doc = Document()

    # ── RTL EVERYWHERE ──
    # 1. Section-level bidi: cascades to anything Word can't otherwise
    #    figure out (e.g. paragraphs docxtemplater fabricates inside loops
    #    or where it inlines images). Without this, any paragraph that
    #    inherits from "Normal" w/o its own <w:bidi/> renders LTR.
    for sec in doc.sections:
        set_section_rtl(sec)

    # 2. Style-level bidi on the styles we actually use, so dynamically
    #    created paragraphs that pick up these styles also default RTL.
    for style_name in ('Normal', 'Heading 1', 'Heading 2', 'Heading 3', 'List Bullet'):
        try:
            set_style_rtl(doc.styles[style_name])
        except KeyError:
            pass  # style not present in this build

    # Default font: Arial 11
    style = doc.styles['Normal']
    style.font.name = 'Arial'
    style.font.size = Pt(11)

    # ═════════════════ COVER ═════════════════
    p = add_para_rtl(doc, '', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.add_run('\n\n\n').font.size = Pt(20)
    p = add_para_rtl(doc, 'תיק תיעוד AS-MADE', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.runs[0].font.size = Pt(36)
    p.runs[0].bold = True
    p.runs[0].font.color.rgb = RGBColor(0x1a, 0x2a, 0x4a)

    p = add_para_rtl(doc, '{site_name}', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.runs[0].font.size = Pt(28)
    p.runs[0].bold = True

    p = add_para_rtl(doc, '{site_address}', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.runs[0].font.size = Pt(16)

    p = add_para_rtl(doc, '{site_subtitle}', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.runs[0].font.size = Pt(12)
    p.runs[0].italic = True

    # ── Cover-page project info table ──
    add_para_rtl(doc, '\n')
    info_table = doc.add_table(rows=7, cols=4)
    info_table.style = 'Light Grid Accent 1'
    set_table_rtl(info_table)

    rows_data = [
        ('מגיש',  'גורם מבצע',         '{contractor_org}', '{contractor_person}'),
        ('מגיש',  'גורם מוביל',         '{pm_org}',         '{pm_person}'),
        ('מקבל',  'לקוח סופי',           '{customer_org}',   '{customer_person}'),
        ('בודק',  'יועץ טכנולוגי',       '{consultant_org}', '{consultant_person}'),
        ('מאשר',  'מהנדס טכנולוגי',     '{engineer_org}',   '{engineer_person}'),
        ('תאריך', 'תאריך הגשה',          '{submit_date}',    ''),
        ('תאריך', 'תאריך עדכון',         '{update_date}',    ''),
    ]
    for i, (role, key, org, person) in enumerate(rows_data):
        cells = info_table.rows[i].cells
        for cell, txt in zip(cells, [role, key, org, person]):
            cell.text = ''
            p = cell.paragraphs[0]
            set_rtl(p)
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            run = p.add_run(txt)
            run.font.name = 'Arial'
            run.font.size = Pt(11)
        shade_cell(cells[0], 'E8EEF7')
        shade_cell(cells[1], 'F4F6FA')

    doc.add_page_break()

    # ═════════════════ 1. הקדמה ═════════════════
    add_heading_rtl(doc, '1. הקדמה', level=1)
    add_para_rtl(doc, '{intro_text}')
    add_para_rtl(doc, '')

    # ═════════════════ 2. תכולת הפרויקט ═════════════════
    add_heading_rtl(doc, '2. תכולת הפרויקט', level=1)
    # Loop over scope_items
    p = add_bullet_rtl(doc, '{#scope_items}{text}{/scope_items}')
    add_para_rtl(doc, '')

    # ═════════════════ 3. ארכיטקטורת רשת ═════════════════
    add_heading_rtl(doc, '3. ארכיטקטורת רשת התקשורת', level=1)
    add_para_rtl(doc, '{network_arch_text}')
    add_para_rtl(doc, '')
    # Network diagram image
    add_para_rtl(doc, 'דיאגרמת רשת:', bold=True)
    p = add_para_rtl(doc, '{%network_diagram_img}', align=WD_ALIGN_PARAGRAPH.CENTER)
    add_para_rtl(doc, '')

    # ═════════════════ 4. שרטוט AS-MADE ═════════════════
    add_heading_rtl(doc, '4. שרטוט AS-MADE', level=1)
    add_para_rtl(doc, 'תכנית האתר:', bold=True)
    add_para_rtl(doc, '{%site_plan_img}', align=WD_ALIGN_PARAGRAPH.CENTER)
    add_para_rtl(doc, '')

    add_para_rtl(doc, 'תמונות מהשטח:', bold=True)
    # Photos loop
    add_para_rtl(doc, '{#photos}', align=WD_ALIGN_PARAGRAPH.CENTER)
    add_para_rtl(doc, '{%img}', align=WD_ALIGN_PARAGRAPH.CENTER)
    p = add_para_rtl(doc, '{caption}', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.runs[0].italic = True
    p.runs[0].font.size = Pt(10)
    add_para_rtl(doc, '{/photos}')

    doc.add_page_break()

    # ═════════════════ 5. רשימת ציוד וכתובות IP ═════════════════
    add_heading_rtl(doc, '5. רשימת ציוד וכתובות IP', level=1)

    # ── 5.1 Cameras ──
    add_heading_rtl(doc, '5.1 רשימת מצלמות', level=2)
    cam_table = doc.add_table(rows=2, cols=7)
    cam_table.style = 'Light Grid Accent 1'
    set_table_rtl(cam_table)
    cam_headers = ['מס"ד', 'ארון תקשורת', 'שם המצלמה', 'סוג מצלמה', 'פורט בפנל', 'כתובת IP', 'מיקום בתכנית']
    for cell, h in zip(cam_table.rows[0].cells, cam_headers):
        cell.text = ''
        p = cell.paragraphs[0]
        set_rtl(p); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(h); r.bold = True; r.font.name = 'Arial'; r.font.size = Pt(10)
        shade_cell(cell, '1A2A4A')
        for run in p.runs:
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    # Data row with loop placeholders
    cam_data_cells = cam_table.rows[1].cells
    cam_loop_fields = [
        '{#cameras}{idx}', '{cabinet}', '{name}', '{model}', '{port}', '{ip}', '{location}{/cameras}',
    ]
    for cell, txt in zip(cam_data_cells, cam_loop_fields):
        cell.text = ''
        p = cell.paragraphs[0]
        set_rtl(p); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(txt); r.font.name = 'Arial'; r.font.size = Pt(10)
    add_para_rtl(doc, '')

    # ── 5.2 Backhauls ──
    add_heading_rtl(doc, '5.2 רשימת עורקים', level=2)
    bh_table = doc.add_table(rows=2, cols=6)
    bh_table.style = 'Light Grid Accent 1'
    set_table_rtl(bh_table)
    bh_headers = ['מס"ד', 'סוג עורק', 'מק"ט', 'יצרן', 'מיקום', 'כתובת IP']
    for cell, h in zip(bh_table.rows[0].cells, bh_headers):
        cell.text = ''
        p = cell.paragraphs[0]
        set_rtl(p); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(h); r.bold = True; r.font.name = 'Arial'; r.font.size = Pt(10)
        shade_cell(cell, '1A2A4A')
        for run in p.runs:
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    bh_data_cells = bh_table.rows[1].cells
    bh_loop_fields = [
        '{#backhauls}{idx}', '{type}', '{mpn}', '{vendor}', '{location}', '{ip}{/backhauls}',
    ]
    for cell, txt in zip(bh_data_cells, bh_loop_fields):
        cell.text = ''
        p = cell.paragraphs[0]
        set_rtl(p); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(txt); r.font.name = 'Arial'; r.font.size = Pt(10)
    add_para_rtl(doc, '')

    # ── 5.3 Switches ──
    add_heading_rtl(doc, '5.3 רשימת מתגים', level=2)
    sw_table = doc.add_table(rows=2, cols=5)
    sw_table.style = 'Light Grid Accent 1'
    set_table_rtl(sw_table)
    sw_headers = ['מס"ד', 'מתגים', 'מק"ט', 'יצרן', 'כתובת IP']
    for cell, h in zip(sw_table.rows[0].cells, sw_headers):
        cell.text = ''
        p = cell.paragraphs[0]
        set_rtl(p); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(h); r.bold = True; r.font.name = 'Arial'; r.font.size = Pt(10)
        shade_cell(cell, '1A2A4A')
        for run in p.runs:
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    sw_data_cells = sw_table.rows[1].cells
    sw_loop_fields = [
        '{#switches}{idx}', '{name}', '{mpn}', '{vendor}', '{ip}{/switches}',
    ]
    for cell, txt in zip(sw_data_cells, sw_loop_fields):
        cell.text = ''
        p = cell.paragraphs[0]
        set_rtl(p); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(txt); r.font.name = 'Arial'; r.font.size = Pt(10)

    # ── Footer ──
    add_para_rtl(doc, '')
    add_para_rtl(doc, '')
    p = add_para_rtl(doc, 'תיק תיעוד זה הופק אוטומטית ממערכת אפקון.', align=WD_ALIGN_PARAGRAPH.CENTER)
    p.runs[0].italic = True
    p.runs[0].font.size = Pt(9)
    p.runs[0].font.color.rgb = RGBColor(0x60, 0x70, 0x80)

    # Save
    import os
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates', 'cctv.docx')
    doc.save(out)
    print(f'Wrote {out}')


if __name__ == '__main__':
    build()
