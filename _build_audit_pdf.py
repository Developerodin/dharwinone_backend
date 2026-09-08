# One-shot: ATS audit markdown → print PDF. Delete after run.
from __future__ import annotations

import re
from pathlib import Path

import markdown
from playwright.sync_api import sync_playwright
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parent
MD_PATH = ROOT / "ATS_PRD_PRODUCT_EVOLUTION_AUDIT.md"
HTML_PATH = ROOT / "_audit_pdf.html"
PDF_PATH = ROOT / "ATS_PRD_PRODUCT_EVOLUTION_AUDIT.pdf"

CSS = r"""
:root {
  --navy: #1B365D;
  --navy-deep: #0F2340;
  --ink: #18181B;
  --muted: #52525B;
  --paper: #FAFAFA;
  --card: #FFFFFF;
  --line: #E4E4E7;
  --gold: #B45309;
  --teal: #0F766E;
  --green: #047857;
  --amber: #B45309;
  --red: #B91C1C;
  --purple: #6D28D9;
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--paper);
  font-family: "Plus Jakarta Sans", "Segoe UI", sans-serif;
  font-size: 10.5pt;
  line-height: 1.55;
  font-weight: 400;
}
.cover {
  min-height: 297mm;
  padding: 22mm 18mm 16mm;
  background:
    linear-gradient(165deg, var(--navy-deep) 0%, var(--navy) 58%, #2A4A73 100%);
  color: #fff;
  page-break-after: always;
  display: flex;
  flex-direction: column;
  position: relative;
}
.cover::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 5px;
  background: #F59E0B;
}
.cover-kicker {
  font-size: 9pt;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-weight: 700;
  color: #FDE68A;
}
.cover h1 {
  font-size: 28pt;
  line-height: 1.15;
  font-weight: 800;
  margin: 18px 0 10px;
  letter-spacing: -0.03em;
  color: #fff;
  border: 0;
  padding: 0;
}
.cover .lede {
  max-width: 150mm;
  color: #E4E4E7;
  font-size: 11.5pt;
  line-height: 1.5;
  margin: 0 0 22px;
}
.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 28px;
  font-size: 9.5pt;
  color: #D4D4D8;
  margin-bottom: 28px;
}
.meta-grid strong { color: #fff; font-weight: 600; display: block; font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 2px; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-top: auto;
}
.stat {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 10px;
  padding: 12px 12px 14px;
}
.stat .v {
  font-size: 18pt;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: #fff;
}
.stat .l {
  font-size: 8pt;
  color: #D4D4D8;
  margin-top: 4px;
  line-height: 1.35;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  margin-top: 18px;
  font-size: 8.5pt;
  color: #E4E4E7;
}
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.dot {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
}
.dot.full { background: #34D399; }
.dot.partial { background: #FBBF24; }
.dot.different { background: #C4B5FD; }
.dot.approx { background: #FB923C; }
.dot.missing { background: #F87171; }
.doc {
  padding: 0 2mm;
}
h1, h2, h3, h4 {
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--navy);
  line-height: 1.25;
}
h1 { font-size: 18pt; margin: 0 0 10px; }
h2 {
  font-size: 14pt;
  margin: 0 0 10px;
  padding-bottom: 6px;
  border-bottom: 2.5px solid var(--navy);
  page-break-before: always;
}
h2:first-of-type { page-break-before: avoid; }
h3 {
  font-size: 11.5pt;
  margin: 16px 0 8px;
  color: var(--navy);
  page-break-after: avoid;
}
h4 {
  font-size: 10.5pt;
  margin: 12px 0 6px;
  color: #1F4E5F;
  page-break-after: avoid;
}
p { margin: 0 0 8px; }
a { color: var(--teal); text-decoration: none; }
hr {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 14px 0;
}
blockquote {
  margin: 10px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--gold);
  background: #FFFBEB;
  color: #44403C;
  font-size: 10pt;
}
code {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 8.5pt;
  background: #F4F4F5;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 4px;
}
pre {
  background: #18181B;
  color: #FAFAFA;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 8pt;
  overflow: hidden;
  white-space: pre-wrap;
}
pre code { background: none; border: 0; color: inherit; padding: 0; }
ul, ol { margin: 0 0 10px; padding-left: 18px; }
li { margin: 0 0 3px; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 8pt;
  line-height: 1.4;
  margin: 0 0 12px;
  background: #fff;
}
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th {
  background: var(--navy);
  color: #fff;
  font-weight: 700;
  text-align: left;
  padding: 5px 7px;
  border: 1px solid var(--navy-deep);
  letter-spacing: 0.02em;
}
td {
  padding: 5px 7px;
  border: 1px solid var(--line);
  vertical-align: top;
}
tbody tr:nth-child(even) td { background: #F8FAFC; }
.toc {
  page-break-after: always;
  padding-top: 4mm;
}
.toc h2 { page-break-before: avoid; }
.toc ol { padding-left: 18px; }
.toc li { margin: 0 0 5px; font-size: 10pt; list-style: none; }
.toc-list { padding-left: 0; counter-reset: toc; }
.toc-list li { padding: 5px 0; border-bottom: 1px solid var(--line); display: flex; }
.toc-list li a { flex: 1; }
.cover h1 {
  font-size: 26pt;
  line-height: 1.18;
  font-weight: 800;
  margin: 18px 0 10px;
  letter-spacing: -0.03em;
  color: #fff;
  border: 0;
  padding: 0;
}
.toc a { color: var(--navy); }
.pill {
  display: inline-block;
  font-size: 7.5pt;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 999px;
  vertical-align: middle;
}
em, i { font-style: italic; }
strong, b { font-weight: 700; }
@page {
  size: A4;
  margin: 16mm 12mm 18mm;
}
@page :first { margin: 0; }
"""

COVER = """
<section class="cover">
  <div class="cover-kicker">Dharwin Business Solutions · Internal</div>
  <h1>ATS PRD / Product / Git Evolution Audit</h1>
  <p class="lede">Forensic page-by-page comparison of the original Dharwin Business Integrated ATS PRD against the shipped UAT product — requirements, extras, and git evolution.</p>
  <div class="meta-grid">
    <div><strong>Audit date</strong>7 September 2026</div>
    <div><strong>PRD source</strong>Dharwin Business Integrated ATS_Updated.pdf (22 pp)</div>
    <div><strong>Repositories</strong>uat.dharwin.backend · uat.dharwin.frontend</div>
    <div><strong>Method</strong>Read-only · PRD parse · routes · code · git</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="v">155</div><div class="l">PRD requirement IDs across 4 modules</div></div>
    <div class="stat"><div class="v">32.9%</div><div class="l">Strict coverage · 51 of 155 fully met</div></div>
    <div class="stat"><div class="v">59.6%</div><div class="l">Weighted coverage · partials counted</div></div>
    <div class="stat"><div class="v">18+</div><div class="l">Pages not in the original PRD</div></div>
  </div>
  <div class="legend">
    <span><i class="dot full"></i> Full</span>
    <span><i class="dot partial"></i> Partial</span>
    <span><i class="dot different"></i> Different</span>
    <span><i class="dot approx"></i> Approximate</span>
    <span><i class="dot missing"></i> Missing</span>
  </div>
</section>
"""


def slug(text: str) -> str:
    s = re.sub(r"<[^>]+>", "", text)
    s = re.sub(r"[^\w\s-]", "", s).strip().lower()
    return re.sub(r"[\s-]+", "-", s)


def main() -> None:
    raw = MD_PATH.read_text(encoding="utf-8")
    raw = re.sub(r"^<style>[\s\S]*?</style>\s*", "", raw)
    raw = re.sub(r"^# ATS PRD / Product / Git Evolution Audit\s*", "", raw)

    body = markdown.markdown(
        raw,
        extensions=["tables", "fenced_code", "sane_lists", "nl2br"],
        output_format="html5",
    )

    toc_items = []
    def heading(m: re.Match[str]) -> str:
        level, text = m.group(1), m.group(2)
        sid = slug(text)
        if level in ("2", "3"):
            toc_items.append((int(level), text, sid))
        return f'<h{level} id="{sid}">{text}</h{level}>'

    body = re.sub(r"<h([1-6])>(.*?)</h\1>", heading, body, flags=re.S)

    toc_html = ['<nav class="toc"><h2>Contents</h2><ul class="toc-list">']
    for level, text, sid in toc_items:
        if level == 2:
            toc_html.append(f'<li><a href="#{sid}">{text}</a></li>')
    toc_html.append("</ul></nav>")

    head = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>ATS PRD / Product / Git Evolution Audit</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap"/>
<style>{CSS}</style>
</head>"""
    cover_html = f"""{head}
<body>{COVER}</body></html>"""
    body_html = f"""{head}
<body>
{''.join(toc_html)}
<article class="doc">
{body}
</article>
</body>
</html>
"""
    HTML_PATH.write_text(body_html, encoding="utf-8")
    cover_path = ROOT / "_audit_pdf_cover.html"
    cover_pdf = ROOT / "_audit_cover.pdf"
    body_pdf = ROOT / "_audit_body.pdf"
    cover_path.write_text(cover_html, encoding="utf-8")

    header = """
      <div style="font-size:8px;font-family:'Plus Jakarta Sans',sans-serif;color:#71717A;width:100%;padding:0 14mm;display:flex;justify-content:space-between;">
        <span>Dharwin · ATS PRD Evolution Audit</span>
        <span>Internal · 7 September 2026</span>
      </div>"""
    footer = """
      <div style="font-size:8px;font-family:'Plus Jakarta Sans',sans-serif;color:#71717A;width:100%;padding:0 14mm;display:flex;justify-content:space-between;">
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        <span>uat.dharwin.backend · uat.dharwin.frontend</span>
      </div>"""

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_default_timeout(180_000)
        page.goto(cover_path.as_uri(), wait_until="networkidle", timeout=120_000)
        page.emulate_media(media="print")
        page.pdf(
            path=str(cover_pdf),
            format="A4",
            print_background=True,
            display_header_footer=False,
            margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
        )
        page.goto(HTML_PATH.as_uri(), wait_until="networkidle", timeout=120_000)
        page.emulate_media(media="print")
        page.pdf(
            path=str(body_pdf),
            format="A4",
            print_background=True,
            display_header_footer=True,
            header_template=header,
            footer_template=footer,
            margin={"top": "16mm", "bottom": "16mm", "left": "12mm", "right": "12mm"},
        )
        browser.close()

    writer = PdfWriter()
    for src in (cover_pdf, body_pdf):
        reader = PdfReader(str(src))
        for pg in reader.pages:
            writer.add_page(pg)
    writer.add_metadata({
        "/Title": "ATS PRD / Product / Git Evolution Audit",
        "/Author": "Dharwin Business Solutions",
        "/Subject": "Page-by-page PRD vs shipped UAT product audit",
    })
    writer.write(str(PDF_PATH))
    writer.close()
    for tmp in (cover_path, cover_pdf, body_pdf):
        tmp.unlink(missing_ok=True)

    print(f"WROTE {PDF_PATH} ({PDF_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
