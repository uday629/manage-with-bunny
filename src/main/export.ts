// Excel (.xlsx) and PDF export without third-party libraries.
// XLSX: a minimal Office Open XML package (inline strings only, so no cell can ever become a formula).
// PDF: escaped HTML rendered by a hidden window with JavaScript disabled, then printToPDF.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export type Cell = string | number | boolean | null;
export interface Table { title: string; subtitle?: string; columns: string[]; rows: Cell[][] }

export function validateTable(t: any): Table {
  if (!t || typeof t !== 'object') throw new Error('Nothing to export.');
  const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/g, '').slice(0, max);
  if (!Array.isArray(t.columns) || !t.columns.length || t.columns.length > 60) throw new Error('Invalid columns.');
  if (!Array.isArray(t.rows) || t.rows.length > 50000) throw new Error('Too many rows to export (max 50,000).');
  return {
    title: clean(t.title, 120) || 'Export',
    subtitle: clean(t.subtitle, 200),
    columns: t.columns.map((c: unknown) => clean(c, 80)),
    rows: t.rows.map((r: unknown) => (Array.isArray(r) ? r : []).slice(0, t.columns.length).map((v): Cell => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? v : v === null || v === undefined ? null : clean(v, 8000)))),
  };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data, { level: 6 });
    const crc = zlib.crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

export function toXlsx(t: Table): Buffer {
  const sheetName = (t.title.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet1').slice(0, 31);
  const widths = t.columns.map((c, i) => Math.min(60, Math.max(8, c.length + 2, ...t.rows.slice(0, 500).map((r) => String(r[i] ?? '').length + 2))));
  const cell = (v: Cell, ref: string, style: number) => {
    if (v === null || v === '') return '';
    if (typeof v === 'number') return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" s="${style}" t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  const rowsXml: string[] = [];
  const titleRow = 1, headerRow = t.subtitle ? 3 : 2;
  rowsXml.push(`<row r="${titleRow}">${cell(t.title, 'A1', 3)}</row>`);
  if (t.subtitle) rowsXml.push(`<row r="2">${cell(t.subtitle, 'A2', 4)}</row>`);
  rowsXml.push(`<row r="${headerRow}">${t.columns.map((c, i) => cell(c, colName(i) + headerRow, 1)).join('')}</row>`);
  t.rows.forEach((r, ri) => { const n = headerRow + 1 + ri; rowsXml.push(`<row r="${n}">${r.map((v, i) => cell(v, colName(i) + n, 2)).join('')}</row>`); });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
<autoFilter ref="A${headerRow}:${colName(t.columns.length - 1)}${headerRow + Math.max(1, t.rows.length)}"/>
</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF1F6BFF"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF6A2BFF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><bottom style="thin"><color rgb="FFDDDDDD"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(t.title)}</dc:title><dc:creator>Manage with Bunny</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

export async function toPdf(t: Table, logoPath: string): Promise<Buffer> {
  const h = (s: Cell) => (s === null ? '' : typeof s === 'boolean' ? (s ? 'Yes' : 'No') : xml(String(s)).replace(/\n/g, '<br>'));
  let logo = '';
  try { logo = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64'); } catch { /* optional */ }
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
@page { margin: 14mm 12mm 16mm; }
body { font-family: 'Segoe UI', -apple-system, 'Nirmala UI', 'Kohinoor Bangla', Arial, sans-serif; color: #111; font-size: 10.5px; margin: 0; }
.head { display: flex; align-items: center; gap: 12px; padding-bottom: 10px; border-bottom: 3px solid; border-image: linear-gradient(90deg,#1F6BFF,#6A2BFF,#FF1F56,#FF8A00) 1; margin-bottom: 12px; }
.head img { width: 42px; height: 42px; }
h1 { font-size: 18px; margin: 0; letter-spacing: -.02em; }
.sub { color: #666; font-size: 10px; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; }
th { background: #6A2BFF; color: #fff; text-align: left; padding: 6px 7px; font-weight: 600; }
td { padding: 5px 7px; border-bottom: 1px solid #e6e6e6; vertical-align: top; word-break: break-word; }
tr:nth-child(even) td { background: #f7f7fb; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
.foot { margin-top: 12px; color: #888; font-size: 9px; }
</style></head><body>
<div class="head">${logo ? `<img src="${logo}">` : ''}<div><h1>${xml(t.title)}</h1><div class="sub">${t.subtitle ? xml(t.subtitle) + ' &middot; ' : ''}Generated ${xml(new Date().toLocaleString())} &middot; Manage with Bunny</div></div></div>
<table><thead><tr>${t.columns.map((c) => `<th>${xml(c)}</th>`).join('')}</tr></thead><tbody>
${t.rows.map((r) => `<tr>${t.columns.map((_, i) => `<td>${h(r[i] ?? null)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table>
<div class="foot">${t.rows.length} rows &middot; Made by Bunnys Framelab &middot; framelabmedia.odoo.com</div>
</body></html>`;
  const tmp = path.join(app.getPath('temp'), `mwb-export-${crypto.randomBytes(8).toString('hex')}.html`);
  fs.writeFileSync(tmp, html, { mode: 0o600 });
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  try {
    await w.loadFile(tmp);
    return await w.webContents.printToPDF({ pageSize: 'A4', landscape: t.columns.length > 6, printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8px;color:#999;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  } finally {
    w.destroy();
    fs.rmSync(tmp, { force: true });
  }
}
