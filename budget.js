'use strict';

const ExcelJS = require('exceljs');

// ── Helpers ───────────────────────────────────────────────────────────────────

function _normalize(str) {
  return String(str || '')
    .replace(/[ְ-ׇ]/g, '')   // strip Hebrew nikud
    .toLowerCase()
    .replace(/['"״׳"]/g, '')  // strip quote chars including Hebrew punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function _cellText(cell) {
  if (!cell || cell.value == null) return '';
  const v = cell.value;
  if (typeof v === 'object' && v.richText)  return v.richText.map(r => r.text).join('');
  if (typeof v === 'object' && v.text)      return String(v.text);
  if (typeof v === 'object' && v.result != null) {
    // formula error result (e.g. { error: '#REF!' }) → return empty string, not "[object Object]"
    if (typeof v.result === 'object') return '';
    return String(v.result);
  }
  if (typeof v === 'object' && 'formula' in v) return '';   // formula with no cached result
  if (typeof v === 'object') return '';                      // Date, hyperlink, other unknown types
  return String(v);
}

function _cellNumber(cell) {
  if (!cell || cell.value == null) return null;
  const v = cell.value;
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'object' && typeof v.result === 'number') n = v.result;
  else if (typeof v === 'object' && 'formula' in v) return null;  // formula, no numeric result
  else {
    const parsed = parseFloat(String(v).replace(/[,\s₪]/g, ''));
    n = isNaN(parsed) ? null : parsed;
  }
  if (n === null) return null;
  // Round to avoid floating-point artifacts (e.g. 2399.9999999999995 → 2400)
  return Math.round(n * 1000) / 1000;
}

function _colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(((n - 1) % 26) + 65) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ── Header scoring (shared between single-row and two-row detection) ──────────

function _scoreTexts(texts) {
  const col = {};
  let score = 0;

  for (let ci = 0; ci < texts.length; ci++) {
    const t = texts[ci];
    if (!t) continue;

    if (col.itemCost == null && (t === 'עלות פריט' || t === 'עלות')) {
      col.itemCost = ci; score += 5; continue;
    }
    if (col.contractTotal == null && (t.includes('סהכ מחיר') || t.includes('סך מחיר'))) {
      col.contractTotal = ci; score += 4; continue;
    }
    if (col.contractUnitPrice == null && (t.includes('מחיר יח') || t.includes('מחיר יחידה'))) {
      col.contractUnitPrice = ci; score += 3; continue;
    }
    if (col.description == null && (
      t.includes('פריט נדרש') || t.includes('מרכיבי משנה') ||
      t === 'פריט' || t === 'תיאור'
    )) { col.description = ci; score += 3; continue; }
    if (col.itemNumber == null && (t === 'מסד' || t === "מס'" || t === 'מס' || t.startsWith("מס'"))) {
      col.itemNumber = ci; score += 2; continue;
    }
    if (col.unit == null && (t.includes('מידה') || t === "יח'" || t === 'יח' || t === 'יחידה')) {
      col.unit = ci; score += 2; continue;
    }
    if (col.quantity == null && t.includes('כמות') && !t.includes('מחיר')) {
      col.quantity = ci; score += 2; continue;
    }
    if (col.manufacturer == null && (t.includes('יצרן') || t.includes('קבלן משנה'))) {
      col.manufacturer = ci; score += 1; continue;
    }
    if (col.model == null && (t.includes('דגם') || t.includes('תיאור עבודה'))) {
      col.model = ci; score += 1; continue;
    }
    if (col.sku == null && (t.includes('מקט') || t === 'sku')) {
      col.sku = ci; score += 1; continue;
    }
    if (col.notes == null && t === 'הערות') {
      col.notes = ci; score += 1; continue;
    }
  }

  // totalCost = first bare "סה"כ" after itemCost column
  if (col.itemCost != null) {
    for (let ci = col.itemCost + 1; ci < texts.length; ci++) {
      const t = texts[ci];
      if (t === 'סהכ' || t === 'total') { col.totalCost = ci; score += 2; break; }
    }
  }

  return { score, col };
}

// ── Header detection ──────────────────────────────────────────────────────────
//
// Handles two layouts:
//   A) Single-row header (בקרה 2, 3, 4) — all column labels in one row
//   B) Two-row merged header (בקרה 1) — right-side labels (עלות פריט, etc.)
//      in row N, left-side labels (מס"ד, פריט נדרש, ...) in row N+1

function detectBudgetHeaderRow(rows) {
  const rowTexts = (r) => r.map(c => _normalize(_cellText(c)));

  // A) Single row
  for (let ri = 0; ri < Math.min(rows.length, 12); ri++) {
    const texts = rowTexts(rows[ri]);
    const { score, col } = _scoreTexts(texts);
    if (score >= 8 && col.description != null && col.itemCost != null) {
      return { headerRowIndex: ri, colMap: col };
    }
  }

  // B) Two-row merged (בקרה 1 style: right-side cols in row ri, left-side in row ri+1)
  for (let ri = 0; ri < Math.min(rows.length - 1, 8); ri++) {
    const t1 = rowTexts(rows[ri]);
    const t2 = rowTexts(rows[ri + 1]);
    const maxLen = Math.max(t1.length, t2.length);
    const merged = [];
    for (let i = 0; i < maxLen; i++) {
      const a = t1[i] || '';
      const b = t2[i] || '';
      if      (!a && b)                    merged.push(b);
      else if (a && !b)                    merged.push(a);
      else if (!a && !b)                   merged.push('');
      // Long value in first row is a title cell → prefer shorter header from second row
      else if (a.length > 15 && b.length <= 15) merged.push(b);
      else                                 merged.push(a);
    }
    const { score, col } = _scoreTexts(merged);
    if (score >= 8 && col.description != null && col.itemCost != null) {
      // Data starts after the SECOND header row
      return { headerRowIndex: ri + 1, colMap: col };
    }
  }

  return null;
}

// ── Excel parser ───────────────────────────────────────────────────────────────

async function parseBudgetXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { items: [], warnings: ['No sheets found'] };

  // Resolve merged cells
  const mergeValues = {};
  if (sheet.model && sheet.model.merges) {
    for (const ref of sheet.model.merges) {
      const [tlRef, brRef] = ref.split(':');
      const master = sheet.getCell(tlRef).value;
      const tl = sheet.getCell(tlRef);
      const br = sheet.getCell(brRef);
      for (let r = tl.row; r <= br.row; r++)
        for (let c = tl.col; c <= br.col; c++) {
          const addr = `${_colLetter(c)}${r}`;
          if (addr !== tlRef) mergeValues[addr] = master;
        }
    }
  }

  const rawRows = [];
  sheet.eachRow({ includeEmpty: false }, row => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, cell => {
      const merged = mergeValues[cell.address];
      cells.push(merged !== undefined ? { value: merged, font: cell.font, address: cell.address } : cell);
    });
    rawRows.push(cells);
  });

  const detection = detectBudgetHeaderRow(rawRows);
  if (!detection) {
    return { items: [], warnings: ['לא זוהתה שורת כותרת של בקרה תקציבית. ודא שהקובץ מכיל עמודת "עלות פריט".'] };
  }

  const { headerRowIndex, colMap: cm } = detection;
  const warnings = [];
  const items    = [];

  for (let ri = headerRowIndex + 1; ri < rawRows.length; ri++) {
    const row = rawRows[ri];
    const get = (idx) => (idx != null ? row[idx] : null);

    const desc = _cellText(get(cm.description)).trim();
    if (!desc) continue;

    const itemNum       = _cellText(get(cm.itemNumber)).trim();
    const unit          = _cellText(get(cm.unit)).trim();
    const qty           = _cellNumber(get(cm.quantity))        ?? 0;
    const contractUnitP = _cellNumber(get(cm.contractUnitPrice));
    const contractTotal = _cellNumber(get(cm.contractTotal))   ?? 0;
    const itemCost      = _cellNumber(get(cm.itemCost))        ?? 0;
    const totalCost     = _cellNumber(get(cm.totalCost))       ?? 0;
    const manufacturer  = _cellText(get(cm.manufacturer)).trim();
    const model         = _cellText(get(cm.model)).trim();
    const sku           = _cellText(get(cm.sku)).trim();
    const notes         = _cellText(get(cm.notes)).trim();

    // Skip pure subtotal rows (no item number, description starts with סה"כ / סיכום)
    const dn = _normalize(desc);
    if (!itemNum && (dn.startsWith('סהכ') || dn.startsWith('סיכום') || dn === 'total')) continue;

    // Section header: bold description, no financial data, no item number
    const descCell = get(cm.description);
    const isBold   = descCell && descCell.font && descCell.font.bold;
    const hasData  = contractTotal !== 0 || itemCost !== 0 || qty !== 0;
    const isSection = isBold && !hasData && !itemNum;

    items.push({
      itemNumber:        itemNum  || null,
      description:       desc,
      unit:              unit     || null,
      quantity:          qty,
      contractUnitPrice: contractUnitP,
      contractTotal,
      itemCost,
      totalCost,
      manufacturer:      manufacturer || null,
      model:             model        || null,
      sku:               sku          || null,
      notes:             notes        || null,
      isSection,
    });
  }

  if (!items.length) warnings.push('הקובץ זוהה אך לא נמצאו שורות נתונים');
  return { items, warnings };
}

// ── Rollup ─────────────────────────────────────────────────────────────────────

function rollupBudget(items) {
  let totalContract = 0, totalCost = 0;
  const bySection   = [];
  let sec = null, sC = 0, sT = 0;

  for (const item of items) {
    if (item.is_section) {
      if (sec) bySection.push({ description: sec, contractTotal: sC, costTotal: sT });
      sec = item.description; sC = 0; sT = 0;
      continue;
    }
    const ct = item.contract_total || 0;
    const cc = item.total_cost     || 0;
    totalContract += ct; totalCost += cc;
    sC += ct; sT += cc;
  }
  if (sec) bySection.push({ description: sec, contractTotal: sC, costTotal: sT });

  const margin    = totalContract - totalCost;
  const marginPct = totalContract > 0 ? (margin / totalContract) * 100 : 0;
  return { totalContract, totalCost, margin, marginPct, bySection };
}

// ── Excel export ───────────────────────────────────────────────────────────────

async function exportBudgetXlsx(project, items) {
  const wb = new ExcelJS.Workbook();
  wb.views = [{ rightToLeft: true }];

  const ws = wb.addWorksheet('בקרה תקציבית', { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: "מס'",       key: 'num',  width: 8  },
    { header: 'תיאור',     key: 'desc', width: 42 },
    { header: "יח'",       key: 'unit', width: 8  },
    { header: 'כמות',      key: 'qty',  width: 9  },
    { header: 'מ"ח חוזה',  key: 'cup',  width: 13 },
    { header: 'סה"כ חוזה', key: 'ct',   width: 14 },
    { header: 'עלות פריט', key: 'ic',   width: 13 },
    { header: 'סה"כ עלות', key: 'tc',   width: 14 },
    { header: 'רווח ₪',    key: 'mg',   width: 14 },
    { header: 'רווח %',    key: 'mgp',  width: 9  },
    { header: 'יצרן',      key: 'mfr',  width: 20 },
    { header: 'דגם',       key: 'mdl',  width: 20 },
    { header: 'מק"ט',      key: 'sku',  width: 14 },
    { header: 'הערות',     key: 'ntx',  width: 26 },
  ];

  const hRow = ws.getRow(1);
  hRow.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  hRow.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  hRow.alignment = { horizontal: 'center' };

  let grandC = 0, grandT = 0;

  for (const item of items) {
    if (item.is_section) {
      const r = ws.addRow([item.item_number || '', item.description, '', '', '', '', '', '', '', '', '', '', '', '']);
      r.font = { bold: true };
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
      ws.mergeCells(`B${r.number}:N${r.number}`);
      continue;
    }

    const ct  = item.contract_total || 0;
    const tc  = item.total_cost     || 0;
    const mg  = ct - tc;
    const pct = ct > 0 ? mg / ct * 100 : 0;
    grandC += ct; grandT += tc;

    const r = ws.addRow([
      item.item_number || '',
      item.description,
      item.unit        || '',
      item.quantity    || '',
      item.contract_unit_price || '',
      ct || '',
      item.item_cost   || '',
      tc || '',
      Math.round(mg),
      ct > 0 ? +pct.toFixed(1) : '',
      item.manufacturer || '',
      item.model        || '',
      item.sku          || '',
      item.notes        || '',
    ]);

    if (ct > 0) {
      if      (pct >= 20) r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F4EA' } };
      else if (pct <  0)  r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE8E6' } };
    }
  }

  const grandMg  = grandC - grandT;
  const grandPct = grandC > 0 ? grandMg / grandC * 100 : 0;
  const tot = ws.addRow(['', 'סה"כ פרויקט', '', '', '', Math.round(grandC), '', Math.round(grandT), Math.round(grandMg), +grandPct.toFixed(1), '', '', '', '']);
  tot.font = { bold: true, size: 12 };
  tot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };

  ['ct','tc','mg'].forEach(k => { ws.getColumn(k).numFmt = '#,##0'; });
  ws.getColumn('cup').numFmt = '#,##0.00';

  // Summary sheet
  const ws2 = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true }] });
  ws2.addRow(['פרויקט:', project.name]);
  ws2.addRow(['אתר:', project.site || '']);
  ws2.addRow([]);
  ws2.addRow(['סעיף', 'סה"כ חוזה', 'סה"כ עלות', 'רווח ₪', 'רווח %']).font = { bold: true };

  const rollup = rollupBudget(items);
  for (const s of rollup.bySection) {
    const mg  = s.contractTotal - s.costTotal;
    const pct = s.contractTotal > 0 ? mg / s.contractTotal * 100 : 0;
    ws2.addRow([s.description, Math.round(s.contractTotal), Math.round(s.costTotal), Math.round(mg), +pct.toFixed(1)]);
  }
  ws2.addRow([]);
  ws2.addRow(['סה"כ', Math.round(rollup.totalContract), Math.round(rollup.totalCost), Math.round(rollup.margin), +rollup.marginPct.toFixed(1)]).font = { bold: true };
  ws2.columns.forEach((c, i) => { c.width = [40, 16, 16, 16, 10][i] || 14; });
  [2, 3, 4].forEach(i => { ws2.getColumn(i).numFmt = '#,##0'; });

  return wb.xlsx.writeBuffer();
}

module.exports = { parseBudgetXlsx, rollupBudget, exportBudgetXlsx };
