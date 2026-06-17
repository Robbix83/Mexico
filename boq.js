'use strict';

const ExcelJS = require('exceljs');
const db = require('./db');

// ExcelJS bug: Excel files with drawings/comments crash in reconcile() when model is undefined.
// Patch both drawing-xform and vml-notes-xform to guard against this.
['exceljs/lib/xlsx/xform/drawing/drawing-xform.js',
 'exceljs/lib/xlsx/xform/comment/vml-notes-xform.js'].forEach(p => {
  try {
    const Xform = require(p);
    const _orig = Xform.prototype.reconcile;
    Xform.prototype.reconcile = function(model, options) {
      if (!model || !model.anchors) return;
      return _orig.call(this, model, options);
    };
  } catch (_) {}
});

// ── System templates (seeded once on first run) ────────────────────────────────

const SYSTEM_TEMPLATES = [
  {
    name: 'מצלמה קבועה',
    keywords: ['מצלמה', 'camera', 'cctv', 'ip camera', 'מצלמת רשת', 'ממ"ד', 'dome', 'bullet', 'turret'],
    components: [
      { key: 'unit_supply',   label: 'אספקת מצלמה',       unitPrice: 0, currency: 'USD', quantity: 1,  formula: null,          sort: 0 },
      { key: 'labor_install', label: 'התקנה וחיווט',       unitPrice: 0, currency: 'ILS', quantity: 1,  formula: null,          sort: 1 },
      { key: 'cable_cat6',    label: 'כבל CAT6 (למ"א)',    unitPrice: 0, currency: 'ILS', quantity: 65, formula: 'item_qty*65', sort: 2 },
      { key: 'final_connect', label: 'חיבור סופי ובדיקה', unitPrice: 0, currency: 'ILS', quantity: 1,  formula: null,          sort: 3 },
    ],
  },
  {
    name: 'NVR / DVR',
    keywords: ['nvr', 'dvr', 'מקליט', 'מערכת הקלטה', 'הקלטה', 'recorder'],
    components: [
      { key: 'unit_supply',   label: 'אספקת מקליט',     unitPrice: 0, currency: 'USD', quantity: 1, formula: null, sort: 0 },
      { key: 'hdd_supply',    label: 'כוננים (HDD)',     unitPrice: 0, currency: 'USD', quantity: 1, formula: null, sort: 1 },
      { key: 'labor_install', label: 'התקנה ותצורה',    unitPrice: 0, currency: 'ILS', quantity: 1, formula: null, sort: 2 },
      { key: 'rack_mount',    label: 'מתלה / ארון',      unitPrice: 0, currency: 'ILS', quantity: 1, formula: null, sort: 3 },
    ],
  },
  {
    name: 'מתג רשת',
    keywords: ['switch', 'מתג', 'poe', 'network switch', 'מתג רשת'],
    components: [
      { key: 'unit_supply',   label: 'אספקת מתג',      unitPrice: 0, currency: 'USD', quantity: 1, formula: null, sort: 0 },
      { key: 'labor_install', label: 'התקנה',           unitPrice: 0, currency: 'ILS', quantity: 1, formula: null, sort: 1 },
      { key: 'patch_cables',  label: 'כבלי פאץ׳ ×4',   unitPrice: 0, currency: 'ILS', quantity: 4, formula: null, sort: 2 },
    ],
  },
  {
    name: 'הנחת כבל',
    keywords: ['כבל', 'cable', 'מ"א', 'מטר', 'hdmi', 'fiber', 'סיב', 'cat5', 'cat6', 'utp'],
    components: [
      { key: 'cable_supply', label: 'כבל (למ"א)', unitPrice: 0, currency: 'ILS', quantity: 1, formula: null, sort: 0 },
      { key: 'labor_pull',   label: 'הנחה והשחלה', unitPrice: 0, currency: 'ILS', quantity: 1, formula: null, sort: 1 },
    ],
  },
  {
    name: 'בקר גישה / כרטיסן',
    keywords: ['גישה', 'access', 'כרטיסן', 'reader', 'בקר', 'controller', 'access control'],
    components: [
      { key: 'unit_supply',   label: 'אספקת כרטיסן',  unitPrice: 0, currency: 'USD', quantity: 1,  formula: null, sort: 0 },
      { key: 'labor_install', label: 'התקנה',           unitPrice: 0, currency: 'ILS', quantity: 1,  formula: null, sort: 1 },
      { key: 'cable_cat6',    label: 'כבל CAT6',        unitPrice: 0, currency: 'ILS', quantity: 10, formula: null, sort: 2 },
    ],
  },
  {
    name: 'פריט RFQ (מחיר ממספק)',
    keywords: ['מסך', 'monitor', 'ריהוט', 'furniture', 'שולחן', 'desk', 'כיסא', 'מחשב', 'ups', 'גנרטור'],
    components: [
      { key: 'rfq_item', label: 'פריט RFQ — מחיר בהצעה', unitPrice: 0, currency: 'ILS', quantity: 1, formula: null, sort: 0 },
    ],
  },
];

function seedSystemTemplates() {
  let created = 0, updated = 0;
  for (const t of SYSTEM_TEMPLATES) {
    const comps = t.components.map(c => ({
      key: c.key, label: c.label, unitPrice: c.unitPrice,
      currency: c.currency, quantity: c.quantity, formula: c.formula, sort: c.sort,
    }));
    const existing = db.getBoqTemplateByName(t.name);
    if (existing) {
      // Refresh system-template components from code (keeps user edits to keywords)
      db.updateBoqTemplate(existing.id, {
        name: t.name,
        keywordsJson: JSON.stringify(t.keywords),
        componentsJson: JSON.stringify(comps),
      });
      updated++;
    } else {
      db.createBoqTemplate({
        name: t.name,
        keywordsJson: JSON.stringify(t.keywords),
        componentsJson: JSON.stringify(comps),
        isSystem: true,
      });
      created++;
    }
  }
  // One-time patch: update any boq_components rows that still reference the old cable formula
  try {
    db.db.prepare(
      `UPDATE boq_components SET quantity_formula = 'item_qty*65'
       WHERE component_key = 'cable_cat6' AND (quantity_formula = 'item_qty*15' OR quantity_formula IS NULL)`
    ).run();
  } catch { /* ignore if column missing */ }
  if (created || updated) console.log(`[boq] system templates — created: ${created}, updated: ${updated}`);
}

// ── Template matching ──────────────────────────────────────────────────────────

function _normalize(str) {
  return String(str || '')
    .replace(/[ְ-ׇ]/g, '')  // strip Hebrew nikud
    .toLowerCase()
    .replace(/['"״׳]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchTemplate(description) {
  const norm = _normalize(description);
  // Split into tokens for whole-word matching (works with Hebrew)
  const tokens = norm.split(/[\s\-\/,;.()]+/).filter(Boolean);
  const templates = db.listBoqTemplates();
  let best = null, bestScore = 0;
  for (const tmpl of templates) {
    let keywords;
    try { keywords = JSON.parse(tmpl.keywords_json || '[]'); } catch { keywords = []; }
    let score = 0;
    for (const kw of keywords) {
      const nkw = _normalize(kw);
      if (!nkw) continue;
      // Exact token match (whole word) → +3
      if (tokens.includes(nkw)) { score += 3; continue; }
      // Multi-word keyword: check if all words appear in description → +2
      const kwTokens = nkw.split(/\s+/);
      if (kwTokens.length > 1 && kwTokens.every(t => norm.includes(t))) { score += 2; continue; }
      // Substring match → +1
      if (norm.includes(nkw)) { score += 1; }
    }
    if (score > bestScore && score >= 1) { best = tmpl; bestScore = score; }
  }
  return best ? { template: best, score: bestScore } : null;
}

// ── Excel / CSV parsing ────────────────────────────────────────────────────────

const HEADER_KEYWORDS = {
  itemNumber:   { words: ['סעיף', 'מס', 'item', 'no', '#', 'מספר', 'number', 'מסד'],                    score: 3 },
  description:  { words: ['תיאור', 'תאור', 'פריט נדרש', 'פריט', 'פרט', 'description', 'item name', 'עבודה', 'מרכיבי משנה', 'מרכיב'], score: 3 },
  unit:         { words: ['יחידה', 'יח', 'unit', 'מידה'],                                                score: 2 },
  quantity:     { words: ['כמות', 'qty', 'quantity', 'כמ'],                                              score: 2 },
  // NOTE: "עלות" intentionally removed — too broad, collides with "עלות פריט" (budget cost column).
  // 'לאחר הנחה' added for Netanya format ("מחיר ללקוח לאחר הנחה לפני מעמ").
  unitPrice:    { words: ['מחיר יחידה', 'מחיר יח', 'מחיר ליח', 'לאחר הנחה', 'מחיר', 'price', 'cost', 'תעריף'], score: 2 },
  // 'סהכ מחיר' / 'סה"כ מחיר' added BEFORE 'מחיר' so the longer keyword wins (prevents
  // the total-price column from being mis-claimed by the unitPrice 'מחיר' keyword).
  total:        { words: ['עלות פריט', 'עלות כוללת', 'סהכ עלות', 'סה"כ עלות', 'סהכ עלויות',
                           'סה"כ מחיר', 'סהכ מחיר', 'סה"כ', 'סהכ', 'total', 'סכום', 'amount', 'סך מחיר'], score: 1 },
  // Extended fields — Netanya + similar formats
  manufacturer: { words: ['יצרן', 'קבלן משנה', 'manufacturer', 'ספק', 'vendor'],                        score: 1 },
  model:        { words: ['תיאור עבודה', 'דגם', 'model', 'mpn', 'part number'],                         score: 1 },
  notes:        { words: ['הערות', 'notes', 'remarks', 'comment'],                                       score: 1 },
};

function _cellText(cell) {
  if (!cell || cell.value == null) return '';
  const v = cell.value;
  if (typeof v === 'object' && v.richText) return v.richText.map(r => r.text).join('');
  if (typeof v === 'object' && v.text) return String(v.text);
  if (typeof v === 'object' && v.result != null) {
    // formula error (e.g. #REF!) → treat as empty string, not "[object Object]"
    if (typeof v.result === 'object') return '';
    return String(v.result);
  }
  return String(v);
}

// Returns true if a cell contains a formula (even a broken one with #REF! etc.)
function _cellHasFormula(cell) {
  if (!cell || cell.value == null) return false;
  const v = cell.value;
  return typeof v === 'object' && (v.formula != null || v.sharedFormula != null);
}

function _cellNumber(cell) {
  if (!cell || cell.value == null) return null;
  const v = cell.value;
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'object' && typeof v.result === 'number') n = v.result;
  else {
    const parsed = parseFloat(String(v).replace(/[,\s]/g, ''));
    n = isNaN(parsed) ? null : parsed;
  }
  if (n === null) return null;
  // Round to avoid floating-point artifacts (e.g. 2399.9999999999995 → 2400)
  return Math.round(n * 1000) / 1000;
}

function detectHeaderRow(rows) {
  for (let ri = 0; ri < Math.min(rows.length, 25); ri++) {
    const row = rows[ri];

    // Pass 1: for every column find its single best field — the one whose keyword
    // has the longest normalized match in the header text.  This prevents a column
    // like "מחיר יחידה מעודכן" from being claimed by BOTH unitPrice ("מחיר יחידה",
    // len=10) AND unit ("יחידה", len=5) — it belongs to unitPrice (longer keyword).
    const colPrimary = {}; // ci → { field, kwLen }
    for (let ci = 0; ci < row.length; ci++) {
      const text = _normalize(_cellText(row[ci]));
      if (!text) continue;
      let bestField = null, bestLen = 0;
      for (const [field, cfg] of Object.entries(HEADER_KEYWORDS)) {
        for (const kw of cfg.words) {
          const nkw = _normalize(kw);
          if (nkw && text.includes(nkw) && nkw.length > bestLen) {
            bestLen = nkw.length;
            bestField = field;
          }
        }
      }
      if (bestField) colPrimary[ci] = { field: bestField, kwLen: bestLen };
    }

    // Pass 2: for each field, collect all columns whose primary field is this one,
    // then pick the last (rightmost) — prefers the most-recently-updated price column.
    const colMap = {};
    let totalScore = 0;
    for (const [ci, { field }] of Object.entries(colPrimary)) {
      if (!colMap[field]) totalScore += HEADER_KEYWORDS[field].score;
      colMap[field] = parseInt(ci); // last wins
    }

    if (totalScore >= 5 && colMap.description != null) {
      return { headerRowIndex: ri, colMap };
    }
  }
  return null;
}

// ── Format detection ──────────────────────────────────────────────────────────
// Identifies the municipality / template by scanning title rows for known names,
// falling back to column-structure fingerprint.

const FORMAT_SIGNATURES = [
  { name: 'netanya',  label: 'עיריית נתניה',  titleTokens: ['נתניה'] },
  { name: 'bat-yam',  label: 'עיריית בת ים',  titleTokens: ['בת ים', 'בת-ים', 'בתים'] },
  { name: 'holon',    label: 'עיריית חולון',  titleTokens: ['חולון'] },
  { name: 'raanana',  label: "עיריית רעננה",  titleTokens: ['רעננה'] },
  { name: 'petah-tikva', label: 'עיריית פתח תקווה', titleTokens: ['פתח תקווה', 'פ"ת'] },
  // Vendor pricing sheets: sections have item-number codes but no unit/qty (e.g. "02.18.01")
  { name: 'olio',     label: 'OLIO / תמחור ספק', titleTokens: ['OLIO', 'אוליו'] },
];

function detectFormat(rawRows, headerRowIndex, colMap) {
  // 1. Scan title rows (above the header) for municipality names
  const titleText = rawRows
    .slice(0, Math.min(headerRowIndex, 6))
    .map(r => r.map(c => _cellText(c)).join(' '))
    .join(' ');
  for (const sig of FORMAT_SIGNATURES) {
    if (sig.titleTokens.some(t => titleText.includes(t))) {
      return { name: sig.name, label: sig.label };
    }
  }
  // 2. Fallback: detect by column fingerprint
  if (colMap.notes != null && colMap.manufacturer != null && colMap.model != null) {
    return { name: 'extended', label: 'פורמט מורחב (יצרן + דגם + הערות)' };
  }
  if (colMap.manufacturer != null || colMap.model != null) {
    return { name: 'extended-partial', label: 'פורמט מורחב חלקי' };
  }
  return { name: 'generic', label: 'פורמט סטנדרטי' };
}

const ITEM_NUMBER_PATTERNS = [
  /^\d+$/,
  /^\d+\.\d+(\.\d+)*$/,
  /^[א-ת]\d*$/,
  /^\d+[a-z]$/i,
  /^[א-ת][א-ת\s\-]*\d+$/,  // e.g. "חריג 1", "תוספת 2"
];

function detectItemNumber(val) {
  const s = String(val || '').trim();
  if (!s) return null;
  for (const re of ITEM_NUMBER_PATTERNS) {
    if (re.test(s)) {
      const dots = (s.match(/\./g) || []).length;
      const level = dots + 1;
      const parentNumber = dots > 0 ? s.substring(0, s.lastIndexOf('.')) : null;
      return { itemNumber: s, level, parentNumber };
    }
  }
  return null;
}

// Build raw rows from a single sheet, resolving merged cells
function _buildRawRows(sheet) {
  const mergeValues = {};
  if (sheet.model && sheet.model.merges) {
    for (const mergeRef of sheet.model.merges) {
      const [tlRef, brRef] = mergeRef.split(':');
      const masterVal = sheet.getCell(tlRef).value;
      const tlCell = sheet.getCell(tlRef);
      const brCell = sheet.getCell(brRef);
      for (let r = tlCell.row; r <= brCell.row; r++) {
        for (let c = tlCell.col; c <= brCell.col; c++) {
          const addr = `${_colLetter(c)}${r}`;
          if (addr !== tlRef) mergeValues[addr] = masterVal;
        }
      }
    }
  }
  const rawRows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const merged = mergeValues[cell.address];
      const effective = merged !== undefined ? { value: merged, font: cell.font, address: cell.address } : cell;
      cells.push(effective);
    });
    cells._hidden = !!row.hidden;
    rawRows.push(cells);
  });
  return rawRows;
}

// Score a detection result: more mapped fields + having description = better sheet
function _detectionScore(detection) {
  if (!detection) return -1;
  const cm = detection.colMap;
  let s = 0;
  if (cm.description != null) s += 10; // must-have
  if (cm.quantity    != null) s += 4;
  if (cm.unitPrice   != null) s += 3;
  if (cm.itemNumber  != null) s += 2;
  if (cm.unit        != null) s += 1;
  return s;
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (!workbook.worksheets.length) return { items: [], warnings: ['No sheets found in file'] };

  // ── Pick the best sheet: scan all sheets, choose the one whose header detection
  //    has the highest score (most relevant columns found, especially description+qty).
  //    This handles workbooks where sheet 0 is a cover/summary and the BOQ is on sheet 2.
  let bestSheet = workbook.worksheets[0];
  let bestRawRows = _buildRawRows(bestSheet);
  let bestDetection = detectHeaderRow(bestRawRows);
  let bestScore = _detectionScore(bestDetection);

  for (let si = 1; si < workbook.worksheets.length; si++) {
    const ws = workbook.worksheets[si];
    const rr = _buildRawRows(ws);
    const det = detectHeaderRow(rr);
    const sc = _detectionScore(det);
    if (sc > bestScore) {
      bestScore = sc; bestDetection = det; bestRawRows = rr; bestSheet = ws;
    }
  }

  const rawRows = bestRawRows;
  const detection = bestDetection;
  const warnings = [];
  if (workbook.worksheets.length > 1) {
    warnings.push(`גיליון שנבחר: "${bestSheet.name}" (מתוך ${workbook.worksheets.length} גיליונות)`);
  }
  let colMap, startRow;

  // ── OLIO / vendor-pricing format detection ───────────────────────────────────
  // These files have "OLIO" in row 1-2, followed by a 3-row header block.
  // Their BOQ columns are B=סעיף, C=תאור, D=יח'מידה, E=כמות, P=מחיר ליח', Q=סה"כ.
  // The file also contains 30+ extra comparison columns to the right with duplicate
  // keyword labels that confuse the auto-detector — so we pin the col map directly.
  const titleSnippet = rawRows.slice(0, 3).map(r => r.map(c => _cellText(c)).join(' ')).join(' ');
  const isOlioFormat = /OLIO|אוליו/i.test(titleSnippet);

  if (detection) {
    colMap = detection.colMap;
    startRow = detection.headerRowIndex + 1;
  } else {
    // Fallback: assume first row is header, map by position
    warnings.push('לא זוהתה שורת כותרת אוטומטית — מניח שורה ראשונה כותרת');
    colMap = { itemNumber: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4 };
    startRow = 1;
  }

  if (isOlioFormat) {
    // Override col map: indices are 0-based positions in the ExcelJS row cells array.
    // Row layout (A=0): A=empty, B=סעיף, C=תאור, D=יח'מידה, E=כמות, …, P=מחיר ליח', Q=סה"כ, R=יצרן
    colMap = { itemNumber: 1, description: 2, unit: 3, quantity: 4, unitPrice: 15, total: 16, manufacturer: 17 };
    startRow = 3; // skip rows 0-2 (title + rate row + header labels)
    warnings.push('זוהה פורמט OLIO — מיפוי עמודות קבוע (B/C/D/E/P/Q)');
  }

  const items = [];
  let skippedCount = 0;
  for (let ri = startRow; ri < rawRows.length; ri++) {
    const row = rawRows[ri];
    const descCell = row[colMap.description];
    const desc = _cellText(descCell).trim();
    if (!desc) continue;

    // Skip total / summary / VAT rows
    const descClean = desc.replace(/[ְ-ׇ]/g, ''); // strip nikud for matching
    if (/סה"כ|סהכ|סך פרק|סך מחיר|מע"מ|מעמ|סיכום ביניים/i.test(descClean)) {
      skippedCount++;
      continue;
    }

    const numCell = colMap.itemNumber != null ? row[colMap.itemNumber] : null;
    const numVal  = numCell ? _cellText(numCell) : '';
    const numInfo = detectItemNumber(numVal);
    // A cell with a formula (even broken #REF!) counts as "has an item slot" —
    // prevents broken-formula rows from being misclassified as chapter headers.
    const hasItemSlot = !!numInfo || _cellHasFormula(numCell);

    const qty = colMap.quantity != null ? _cellNumber(row[colMap.quantity]) : null;
    const unitPrice = colMap.unitPrice != null ? _cellNumber(row[colMap.unitPrice]) : null;
    const unit      = colMap.unit         != null ? _cellText(row[colMap.unit]).trim()    : '';
    const mfr       = colMap.manufacturer != null ? _cellText(row[colMap.manufacturer]).trim() : null;
    const mdl       = colMap.model        != null ? _cellText(row[colMap.model]).trim()   : null;
    const rowNotes  = colMap.notes        != null ? _cellText(row[colMap.notes]).trim()   : null;

    const hasQty  = qty != null && qty >= 1;
    const hasUnit = !!unit;

    // Section/chapter header: no item number AND (bold OR starts with "פרק")
    // Deliberately excludes "!hasQty" — a no-number, no-qty row that isn't bold
    // is just an empty/zero catalogue row and should be skipped, not imported as a section.
    const isBold = descCell && descCell.font && descCell.font.bold;
    // OLIO-style parent nodes: item number present but no qty.
    // - Generic: no unit either (e.g. "02.18.01" chapter with empty D cell)
    // - OLIO-specific: code with ≤2 dots (parent-level code) forces section even if D has text
    //   like a customer name ("עומר"), because OLIO sections always have 3-segment codes.
    const dotCount = numInfo ? (numInfo.itemNumber.match(/\./g) || []).length : -1;
    const isParentNode = hasItemSlot && !hasQty && (!hasUnit || (isOlioFormat && dotCount <= 2));
    const isSection = isParentNode || (!hasItemSlot && (isBold || !hasQty || /^פרק[\s ]/i.test(desc)));

    // Skip rows hidden by Excel's AutoFilter — but KEEP section headers even if hidden,
    // because section rows have no qty and Excel's filter hides them too.
    // In multi-company BOQs (e.g. עיריית נתניה), the AutoFilter intentionally shows only
    // rows where this company's quantity column ≥ 1 — respecting that filter is correct.
    if (row._hidden && !isSection) {
      skippedCount++;
      continue;
    }

    // Skip non-section items that have no quantity.
    if (!isSection && !hasQty) {
      skippedCount++;
      continue;
    }

    items.push({
      itemNumber:        numInfo ? numInfo.itemNumber : null,
      parentNumber:      numInfo ? numInfo.parentNumber : null,
      description:       desc,
      unit:              unit || null,
      quantity:          hasQty ? qty : 1,
      isSection,
      isRfq:             !isSection && unitPrice == null,
      contractUnitPrice: unitPrice,
      manufacturer:      mfr      || null,
      model:             mdl      || null,
      notes:             rowNotes || null,
    });
  }

  if (skippedCount > 0) warnings.push(`${skippedCount} שורות דולגו (ללא כמות)`);

  // Post-process: remove section headers that have no data items before the next section.
  // This cleans up empty chapters that appear when AutoFilter hides all items in a chapter
  // (e.g. Netanya multi-company BOQ — chapters with no יוספטל-qty items are stripped).
  // Logic: a section is kept only if the immediately next item(s) include at least one
  // non-section row before the next section header starts.
  {
    const filtered = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].isSection) {
        // Scan forward until we find a data item or the next section
        let hasChildren = false;
        for (let j = i + 1; j < items.length; j++) {
          if (!items[j].isSection) { hasChildren = true; break; }
          break; // next item is also a section → this chapter is empty
        }
        if (!hasChildren) { skippedCount++; continue; }
      }
      filtered.push(items[i]);
    }
    // Replace items with filtered list
    items.length = 0;
    items.push(...filtered);
  }

  // Build human-readable column map for debugging (header row text per field)
  const headerRow = rawRows[detection ? detection.headerRowIndex : 0] || [];
  const colMapDebug = {};
  for (const [field, ci] of Object.entries(colMap)) {
    colMapDebug[field] = { colIndex: ci, header: _cellText(headerRow[ci]) || '(ריק)' };
  }

  // Format detection (municipality / schema fingerprint)
  const format = detectFormat(rawRows, detection ? detection.headerRowIndex : 0, colMap);
  if (format.name === 'netanya' && colMap.notes == null) {
    warnings.push('זוהה פורמט נתניה אך עמודת "הערות" לא נמצאה');
  }

  return { items, warnings, skippedCount, colMapDebug, format };
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { items: [], warnings: ['Empty CSV'] };

  // Detect delimiter
  const tabs = (lines[0].match(/\t/g) || []).length;
  const commas = (lines[0].match(/,/g) || []).length;
  const delim = tabs >= commas ? '\t' : ',';

  const splitLine = (line) => line.split(delim).map(s => s.trim().replace(/^["']|["']$/g, ''));
  const headerCells = splitLine(lines[0]).map(s => ({ value: s }));
  const detection = detectHeaderRow([headerCells]);
  const warnings = [];
  let colMap, startRow;

  if (detection) {
    colMap = detection.colMap;
    startRow = 1;
  } else {
    warnings.push('לא זוהתה שורת כותרת — מניח: מס׳, תיאור, יחידה, כמות, מחיר');
    colMap = { itemNumber: 0, description: 1, unit: 2, quantity: 3, unitPrice: 4 };
    startRow = 1;
  }

  const items = [];
  let skippedCount = 0;
  for (let ri = startRow; ri < lines.length; ri++) {
    const cols = splitLine(lines[ri]);
    const desc = (colMap.description != null ? cols[colMap.description] : '') || '';
    if (!desc) continue;

    // Skip total / summary rows
    const descClean = desc.replace(/[ְ-ׇ]/g, '');
    if (/סה"כ|סהכ|סך פרק|סך מחיר|מע"מ|מעמ|סיכום ביניים/i.test(descClean)) {
      skippedCount++;
      continue;
    }

    const numVal = colMap.itemNumber != null ? (cols[colMap.itemNumber] || '') : '';
    const numInfo = detectItemNumber(numVal);
    const qty = colMap.quantity != null ? parseFloat(cols[colMap.quantity]) : null;
    const unitPrice = colMap.unitPrice != null ? (parseFloat(cols[colMap.unitPrice]) || null) : null;
    const unit = colMap.unit != null ? (cols[colMap.unit] || '') : '';

    const hasQty = qty != null && !isNaN(qty) && qty >= 1;
    const isSection = !numInfo && (!hasQty || /^פרק[\s ]/i.test(desc));

    if (!isSection && !hasQty) {
      skippedCount++;
      continue;
    }

    items.push({
      itemNumber:        numInfo ? numInfo.itemNumber : null,
      parentNumber:      numInfo ? numInfo.parentNumber : null,
      description:       desc,
      unit:              unit || null,
      quantity:          hasQty ? qty : 1,
      isSection:         isSection,
      isRfq:             !isSection && unitPrice == null,
      contractUnitPrice: unitPrice,
    });
  }
  if (skippedCount > 0) warnings.push(`${skippedCount} שורות דולגו (ללא כמות או סיכומים)`);
  return { items, warnings, skippedCount };
}

// ── Cost rollup ────────────────────────────────────────────────────────────────

function rollupItem(item, components, rates) {
  if (item.is_section) return { totalIls: 0, breakdown: [] };
  if (item.is_rfq && item.rfq_price_ils != null) {
    return { totalIls: item.rfq_price_ils, breakdown: [{ label: 'RFQ', amountIls: item.rfq_price_ils }] };
  }
  const breakdown = [];
  let total = 0;
  for (const c of components) {
    const rate = c.currency === 'USD' ? (rates?.USD || 1)
               : c.currency === 'EUR' ? (rates?.EUR || 1) : 1;
    const amount = (c.unit_price || 0) * (c.quantity || 1) * rate;
    total += amount;
    breakdown.push({ label: c.label, amountIls: amount });
  }
  return { totalIls: total, breakdown };
}

function rollupProject(items, allComponents, rates) {
  const compsByItem = {};
  for (const c of allComponents) {
    (compsByItem[c.item_id] = compsByItem[c.item_id] || []).push(c);
  }

  let knownTotal = 0, rfqTotal = 0, unknownRfqCount = 0;
  const bySection = [];
  let currentSection = null, sectionTotal = 0;

  for (const item of items) {
    if (item.is_section) {
      if (currentSection) bySection.push({ ...currentSection, totalIls: sectionTotal });
      currentSection = { itemNumber: item.item_number, description: item.description };
      sectionTotal = 0;
      continue;
    }
    if (item.is_rfq) {
      if (item.rfq_price_ils != null) {
        rfqTotal += item.rfq_price_ils;
        knownTotal += item.rfq_price_ils;
        sectionTotal += item.rfq_price_ils;
      } else {
        unknownRfqCount++;
      }
    } else {
      const comps = compsByItem[item.id] || [];
      const { totalIls } = rollupItem(item, comps, rates);
      knownTotal += totalIls;
      sectionTotal += totalIls;
    }
  }
  if (currentSection) bySection.push({ ...currentSection, totalIls: sectionTotal });

  return { knownTotal, rfqTotal, unknownRfqCount, bySection, grandTotal: knownTotal };
}

// ── Excel export ───────────────────────────────────────────────────────────────

async function exportXlsx(project, items, allComponents, rates) {
  const compsByItem = {};
  for (const c of allComponents) {
    (compsByItem[c.item_id] = compsByItem[c.item_id] || []).push(c);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.views = [{ rightToLeft: true }];

  // ── Sheet 1: full breakdown ──
  const ws = workbook.addWorksheet('כתב כמויות', { views: [{ rightToLeft: true }] });

  ws.columns = [
    { header: 'מס׳', key: 'num', width: 8 },
    { header: 'תיאור סעיף', key: 'desc', width: 40 },
    { header: 'יחידה', key: 'unit', width: 8 },
    { header: 'כמות', key: 'qty', width: 8 },
    { header: 'רכיב עלות', key: 'comp', width: 30 },
    { header: 'מחיר יחידה', key: 'up', width: 12 },
    { header: 'מטבע', key: 'cur', width: 7 },
    { header: 'כמות רכיב', key: 'cqty', width: 10 },
    { header: 'סה"כ ₪', key: 'total', width: 14 },
  ];

  // Style header row
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  headerRow.alignment = { horizontal: 'center' };

  const USD = rates?.USD || 1;
  const EUR = rates?.EUR || 1;

  let projectGrand = 0;

  for (const item of items) {
    if (item.is_section) {
      const r = ws.addRow([item.item_number || '', item.description, '', '', '', '', '', '', '']);
      r.font = { bold: true };
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
      ws.mergeCells(`B${r.number}:I${r.number}`);
      continue;
    }

    const comps = compsByItem[item.id] || [];
    if (comps.length === 0) {
      let ils = 0;
      if (item.is_rfq && item.rfq_price_ils != null) ils = item.rfq_price_ils;
      projectGrand += ils;
      ws.addRow([item.item_number || '', item.description, item.unit || '', item.quantity,
        item.is_rfq ? 'RFQ' : '—', '', '', '', ils || '']);
      continue;
    }

    let itemTotal = 0;
    let firstComp = true;
    for (const c of comps) {
      const rate = c.currency === 'USD' ? USD : c.currency === 'EUR' ? EUR : 1;
      const rowTotal = (c.unit_price || 0) * (c.quantity || 1) * rate;
      itemTotal += rowTotal;
      const r = ws.addRow([
        firstComp ? (item.item_number || '') : '',
        firstComp ? item.description : '',
        firstComp ? (item.unit || '') : '',
        firstComp ? item.quantity : '',
        c.label,
        c.unit_price,
        c.currency,
        c.quantity,
        Math.round(rowTotal),
      ]);
      if (!firstComp) {
        r.getCell(1).value = null;
        r.getCell(2).value = null;
      }
      firstComp = false;
    }
    projectGrand += itemTotal;
    // Subtotal row
    const stRow = ws.addRow(['', '', '', '', '', '', '', 'סה"כ סעיף:', Math.round(itemTotal)]);
    stRow.font = { italic: true };
    stRow.getCell(9).font = { bold: true };
  }

  // Grand total
  const gtRow = ws.addRow(['', '', '', '', '', '', '', 'סה"כ פרויקט:', Math.round(projectGrand)]);
  gtRow.font = { bold: true, size: 12 };
  gtRow.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };

  // Number format for price columns
  ws.getColumn('up').numFmt = '#,##0.00';
  ws.getColumn('total').numFmt = '#,##0';

  // ── Sheet 2: summary ──
  const ws2 = workbook.addWorksheet('סיכום', { views: [{ rightToLeft: true }] });
  ws2.addRow(['פרויקט:', project.name]);
  ws2.addRow(['אתר:', project.site || '']);
  ws2.addRow(['']);
  ws2.addRow(['סעיף', 'סה"כ ₪']);
  ws2.getRow(4).font = { bold: true };

  const rollup = rollupProject(items, allComponents, rates);
  for (const sec of rollup.bySection) {
    ws2.addRow([sec.description, Math.round(sec.totalIls)]);
  }
  ws2.addRow(['']);
  const totalRow = ws2.addRow(['סה"כ פרויקט:', Math.round(rollup.grandTotal)]);
  totalRow.font = { bold: true };
  if (rollup.unknownRfqCount > 0) {
    ws2.addRow([`* ${rollup.unknownRfqCount} פריטי RFQ ממתינים להצעת מחיר`]);
  }

  ws2.getColumn(1).width = 40;
  ws2.getColumn(2).width = 16;
  ws2.getColumn(2).numFmt = '#,##0';

  const buf = await workbook.xlsx.writeBuffer();
  return buf;
}

// ── PDF export ─────────────────────────────────────────────────────────────────

async function exportPdf(project, items, allComponents, rates) {
  const rollup = rollupProject(items, allComponents, rates);
  const compsByItem = {};
  for (const c of allComponents) {
    (compsByItem[c.item_id] = compsByItem[c.item_id] || []).push(c);
  }
  const USD = rates?.USD || 1;
  const EUR = rates?.EUR || 1;
  const fmt = n => Math.round(n).toLocaleString('he-IL');

  let rows = '';
  for (const item of items) {
    if (item.is_section) {
      rows += `<tr class="section"><td colspan="5"><strong>${item.description || ''}</strong></td></tr>`;
      continue;
    }
    const comps = compsByItem[item.id] || [];
    let total = 0;
    if (item.is_rfq && item.rfq_price_ils != null) total = item.rfq_price_ils;
    else {
      for (const c of comps) {
        const rate = c.currency === 'USD' ? USD : c.currency === 'EUR' ? EUR : 1;
        total += (c.unit_price || 0) * (c.quantity || 1) * rate;
      }
    }
    const rfqLabel = item.is_rfq && item.rfq_price_ils == null ? '<span class="rfq">RFQ</span>' : '';
    rows += `<tr>
      <td>${item.item_number || ''}</td>
      <td>${item.description}</td>
      <td>${item.unit || ''}</td>
      <td>${item.quantity || ''}</td>
      <td>${rfqLabel || '₪' + fmt(total)}</td>
    </tr>`;
  }

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8">
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1a1a1a; margin: 24px; }
  h1 { font-size: 18px; color: #1e3a5f; }
  .meta { color: #555; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #1e3a5f; color: #fff; padding: 6px 8px; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; }
  tr.section td { background: #e8f0fe; font-weight: bold; }
  .rfq { color: #d97706; font-weight: bold; }
  .summary { margin-top: 24px; border-top: 2px solid #1e3a5f; padding-top: 12px; }
  .total-row { font-weight: bold; font-size: 14px; }
</style>
</head>
<body>
<h1>כתב כמויות — ${project.name}</h1>
<div class="meta">אתר: ${project.site || '—'} | תאריך: ${new Date().toLocaleDateString('he-IL')}</div>
<table>
  <thead><tr>
    <th>מס׳</th><th>תיאור</th><th>יחידה</th><th>כמות</th><th>סה"כ ₪</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="summary">
  <table>
    <tr class="total-row"><td>סה"כ ידוע:</td><td>₪${fmt(rollup.knownTotal)}</td></tr>
    ${rollup.unknownRfqCount > 0 ? `<tr><td>פריטי RFQ ממתינים:</td><td>${rollup.unknownRfqCount} פריטים</td></tr>` : ''}
  </table>
</div>
</body></html>`;

  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { throw new Error('puppeteer not available'); }
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  return pdfBuffer;
}

// ── Column letter helper ───────────────────────────────────────────────────────

function _colLetter(n) {
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(((n - 1) % 26) + 65) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = { seedSystemTemplates, matchTemplate, parseXlsx, parseCsv, rollupItem, rollupProject, exportXlsx, exportPdf };
