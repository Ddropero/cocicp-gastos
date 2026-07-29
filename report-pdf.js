// ============================================================
// COCICP Gastos — Generador de Reporte Fiscal PDF (PDF 1.4, sin librerías)
// Offsets del xref calculados por BYTES (UTF-8), multipágina.
// Nota Unicode: las fuentes base Helvetica (WinAnsi) no soportan todo Unicode;
// pdfStr translitera acentos a ASCII. El Unicode completo exigiría embeber una
// fuente TrueType + ToUnicode CMap (fuera de alcance; documentado).
// ============================================================

const NON_DEDUCIBLE_CATS = [
  'Educación hijos', 'Personal', 'Vivienda',
  'Pagos David Duque', 'Impuestos vehículos', 'Misceláneos',
];

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP',
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});

// ── PDF text helpers ────────────────────────────────────────
function pdfStr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita diacríticos (á→a, ñ→n queda 'n')
    .replace(/[^\x20-\x7E]/g, '?');
}
function textCmd(x, y, text, fontSize, fontRef) {
  return `BT /${fontRef} ${fontSize} Tf ${x} ${y} Td (${pdfStr(text)}) Tj ET\n`;
}
function lineCmd(x1, y1, x2, y2, width) { return `${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`; }
function rectFillCmd(x, y, w, h) { return `${x} ${y} ${w} ${h} re f\n`; }

// ── Main export ─────────────────────────────────────────────
export function generateReport(registros, desde, hasta, opts = {}) {
  registros = Array.isArray(registros) ? registros : [];
  const entidad = opts.entidad || null;
  const granTotal = registros.reduce((s, r) => s + (r.total || 0), 0);
  const ivaTotal  = registros.reduce((s, r) => s + (r.iva || 0), 0);
  const incTotal  = registros.reduce((s, r) => s + (r.inc || 0), 0);

  const catMap = {};
  for (const r of registros) {
    const cat = r.categoria || 'Miscelaneos';
    (catMap[cat] ||= { count: 0, total: 0 });
    catMap[cat].count++; catMap[cat].total += r.total || 0;
  }
  const catRows = Object.entries(catMap).sort((a, b) => b[1].total - a[1].total)
    .map(([name, d]) => ({ name, count: d.count, total: d.total,
      pct: granTotal !== 0 ? ((d.total / granTotal) * 100).toFixed(1) : '0.0' }));

  let totalDeducible = 0, totalNoDeducible = 0, countDeducible = 0, countNoDeducible = 0;
  for (const r of registros) {
    const cat = r.categoria || 'Miscelaneos';
    if (NON_DEDUCIBLE_CATS.includes(cat)) { totalNoDeducible += r.total || 0; countNoDeducible++; }
    else { totalDeducible += r.total || 0; countDeducible++; }
  }

  const pageW = 612, pageH = 792, marginL = 50, marginR = 562, contentW = marginR - marginL;
  const genDate = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // ── Paginación real ──
  const pages = [];
  let stream = '', y = 0;
  const startPage = () => {
    stream = '';
    stream += '0.05 0.06 0.055 rg\n' + rectFillCmd(0, pageH - 90, pageW, 90);
    stream += '0.722 0.941 0.627 rg\n' + textCmd(marginL, pageH - 35, 'COCICP', 20, 'F2');
    stream += '0.9 0.93 0.9 rg\n' + textCmd(marginL + 95, pageH - 35, '-- Reporte Fiscal' + (entidad ? ' | ' + entidad : ''), 14, 'F1');
    stream += '0.6 0.7 0.6 rg\n' + textCmd(marginL, pageH - 55, `Periodo: ${desde || 'inicio'} a ${hasta || 'actual'}`, 10, 'F1');
    stream += textCmd(marginL, pageH - 70, entidad
      ? `Entidad: ${entidad}`
      : 'NIT: 901277565-7 | Corp. Colombiana Desarrollo Investigacion Cirugia Plastica', 8, 'F1');
    stream += '0 0 0 rg\n';
    y = pageH - 110;
  };
  const endPage = () => {
    stream += '0.7 0.7 0.7 rg\n' + lineCmd(marginL, 45, marginR, 45, 0.3);
    stream += textCmd(marginL, 32, `Generado: ${genDate} UTC | COCICP NIT 901277565-7 | Pagina ${pages.length + 1} | Documento interno`, 7, 'F1');
    stream += '0 0 0 rg\n';
    pages.push(stream);
  };
  const ensure = (needed) => { if (y - needed < 60) { endPage(); startPage(); } };

  startPage();

  // Resumen general
  stream += textCmd(marginL, y, 'RESUMEN GENERAL', 12, 'F2'); y -= 6;
  stream += '0.85 0.85 0.85 rg\n' + lineCmd(marginL, y, marginR, y, 0.5) + '0 0 0 rg\n'; y -= 18;
  for (const [label, value] of [
    ['Total registros:', String(registros.length)],
    ['Gran total:', COP.format(granTotal)],
    ['IVA total:', COP.format(ivaTotal)],
    ['INC total:', COP.format(incTotal)],
  ]) {
    stream += textCmd(marginL + 10, y, label, 10, 'F1') + textCmd(marginL + 160, y, value, 10, 'F2'); y -= 16;
  }
  y -= 10;

  // Desglose por categoría
  ensure(50);
  stream += textCmd(marginL, y, 'DESGLOSE POR CATEGORIA', 12, 'F2'); y -= 6;
  stream += '0.85 0.85 0.85 rg\n' + lineCmd(marginL, y, marginR, y, 0.5) + '0 0 0 rg\n'; y -= 18;
  stream += '0.92 0.94 0.92 rg\n' + rectFillCmd(marginL, y - 3, contentW, 16) + '0.2 0.2 0.2 rg\n';
  const colCat = marginL + 6, colCount = marginL + 260, colTotal = marginL + 320, colPct = marginL + 470;
  stream += textCmd(colCat, y, 'Categoria', 9, 'F2') + textCmd(colCount, y, 'Cant.', 9, 'F2')
    + textCmd(colTotal, y, 'Total', 9, 'F2') + textCmd(colPct, y, '% del Total', 9, 'F2');
  y -= 18; stream += '0 0 0 rg\n';

  let rowIdx = 0;
  for (const row of catRows) {
    ensure(15);
    if (rowIdx % 2 === 1) { stream += '0.96 0.97 0.96 rg\n' + rectFillCmd(marginL, y - 3, contentW, 15) + '0 0 0 rg\n'; }
    const name = row.name.length > 30 ? row.name.substring(0, 28) + '..' : row.name;
    stream += textCmd(colCat, y, name, 9, 'F1') + textCmd(colCount, y, String(row.count), 9, 'F1')
      + textCmd(colTotal, y, COP.format(row.total), 9, 'F1') + textCmd(colPct, y, row.pct + '%', 9, 'F1');
    y -= 15; rowIdx++;
  }
  y -= 3; ensure(15);
  stream += '0.85 0.85 0.85 rg\n' + lineCmd(marginL, y + 12, marginR, y + 12, 0.5) + '0 0 0 rg\n';
  stream += textCmd(colCat, y, 'TOTAL', 9, 'F2') + textCmd(colCount, y, String(registros.length), 9, 'F2')
    + textCmd(colTotal, y, COP.format(granTotal), 9, 'F2') + textCmd(colPct, y, '100%', 9, 'F2');
  y -= 30;

  // Deducibilidad
  ensure(120);
  stream += textCmd(marginL, y, 'ANALISIS DE DEDUCIBILIDAD', 12, 'F2'); y -= 6;
  stream += '0.85 0.85 0.85 rg\n' + lineCmd(marginL, y, marginR, y, 0.5) + '0 0 0 rg\n'; y -= 20;
  const barW = 200;
  const dedPct = granTotal !== 0 ? (totalDeducible / granTotal) : 0;
  stream += '0.722 0.941 0.627 rg\n' + rectFillCmd(marginL + 10, y - 2, Math.max(barW * dedPct, 2), 14) + '0 0 0 rg\n';
  stream += textCmd(marginL + barW + 20, y, `Deducible: ${COP.format(totalDeducible)} (${countDeducible} reg.)`, 10, 'F2'); y -= 22;
  const noDedPct = granTotal !== 0 ? (totalNoDeducible / granTotal) : 0;
  stream += '0.941 0.69 0.627 rg\n' + rectFillCmd(marginL + 10, y - 2, Math.max(barW * noDedPct, 2), 14) + '0 0 0 rg\n';
  stream += textCmd(marginL + barW + 20, y, `No deducible: ${COP.format(totalNoDeducible)} (${countNoDeducible} reg.)`, 10, 'F2'); y -= 20;
  stream += '0.4 0.4 0.4 rg\n' + textCmd(marginL + 10, y, 'Categorias no deducibles: ' + NON_DEDUCIBLE_CATS.join(', '), 7, 'F1') + '0 0 0 rg\n';

  endPage();
  return buildPdf(pages, pageW, pageH);
}

// ── Low-level PDF 1.4 builder — OFFSETS POR BYTES, multipágina ──
function buildPdf(pageStreams, pageW, pageH) {
  const enc = new TextEncoder();
  const objects = [];               // { content: string }
  const add = (content) => { objects.push({ content }); return objects.length; };

  const catalogNum = add('');       // 1: Catalog (rellenar luego con Pages ref)
  const pagesNum = add('');         // 2: Pages
  const font1Num = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');       // 3
  const font2Num = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');  // 4

  const kids = [];
  for (const s of pageStreams) {
    const sb = enc.encode(s);
    const contentNum = add(`<< /Length ${sb.length} >>\nstream\n${s}endstream`);
    const pageNum = add(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Contents ${contentNum} 0 R /Resources << /Font << /F1 ${font1Num} 0 R /F2 ${font2Num} 0 R >> >> >>`
    );
    kids.push(`${pageNum} 0 R`);
  }
  objects[catalogNum - 1].content = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
  objects[pagesNum - 1].content = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  // Ensamblar por BYTES
  const chunks = []; let length = 0;
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); length += b.length; };

  // Cabecera: comentario binario como BYTES crudos (no como string UTF-16)
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    push(`${i + 1} 0 obj\n${objects[i].content}\nendobj\n`);
  }

  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}
