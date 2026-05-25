/**
 * docpack.js — Word document generation for "תיק תיעוד" portfolios
 *
 * Uses docxtemplater + pizzip + docxtemplater-image-module-free.
 * Templates live in ./templates/<type>.docx (commit-time, not user-uploaded in MVP).
 * Photos live in <UPLOADS_DIR>/<pack_id>/<filename>.
 *
 * ─── Placeholder schema (single source of truth) ────────────────────────────
 * Text fields:
 *   {site_name}             — שם האתר
 *   {site_address}          — כתובת
 *   {site_subtitle}         — שורת תיאור משנית בכותרת
 *   {contractor_org}        — גורם מבצע (חברה)
 *   {contractor_person}     — גורם מבצע (איש קשר)
 *   {pm_org}                — גורם מוביל (חברה)
 *   {pm_person}             — גורם מוביל / מנהל פרויקט (איש קשר)
 *   {customer_org}          — לקוח סופי (ארגון)
 *   {customer_person}       — לקוח סופי (איש קשר)
 *   {consultant_org}        — יועץ טכנולוגי (חברה)
 *   {consultant_person}     — יועץ טכנולוגי (איש קשר)
 *   {engineer_org}          — מהנדס טכנולוגי (חברה)
 *   {engineer_person}       — מהנדס טכנולוגי (איש קשר)
 *   {submit_date}           — תאריך הגשה
 *   {update_date}           — תאריך עדכון
 *   {intro_text}            — הקדמה (טקסט חופשי, multi-paragraph שנקטע בפסקאות)
 *   {network_arch_text}     — תיאור ארכיטקטורת רשת
 *
 * Loops:
 *   {#scope_items}{text}{/scope_items}         — תכולת הפרויקט (bullets)
 *   {#cameras}{idx},{cabinet},{name},{model},{port},{ip},{location}{/cameras}
 *   {#backhauls}{idx},{type},{mpn},{vendor},{location},{ip}{/backhauls}
 *   {#switches}{idx},{name},{mpn},{vendor},{ip}{/switches}
 *   {#photos}{%img}{caption}{/photos}          — תמונות AS-MADE
 *
 * Image tags (use `%` prefix, image module):
 *   {%network_diagram_img}   — דיאגרמת רשת (one)
 *   {%site_plan_img}         — תכנית אתר (one)
 *   inside {#photos}: {%img} — תמונה ל-loop
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');
const PizZip          = require('pizzip');
const Docxtemplater   = require('docxtemplater');
const ImageModule     = require('docxtemplater-image-module-free');
const db = require('./db');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const UPLOADS_DIR   = process.env.DOC_PACK_UPLOADS_DIR || path.join(__dirname, 'data', 'doc_packs');

// Ensure uploads dir exists at module load
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function templatePath(type) {
  return path.join(TEMPLATES_DIR, `${type || 'cctv'}.docx`);
}

function packDir(packId) {
  const d = path.join(UPLOADS_DIR, String(packId));
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileDiskPath(packId, filename) {
  return path.join(packDir(packId), filename);
}

/**
 * imageModuleOpts() — returns options object for docxtemplater-image-module-free.
 *
 * `getImage(tagValue)` reads from disk. The tag value is the absolute file path
 *  produced by buildContext (e.g. /data/doc_packs/3/abc123.jpg).
 * `getSize(_, tagValue, tagName)` returns [widthPx, heightPx] for the image
 *  inside the document. We use 600×400 for photos and 720×400 for diagrams.
 */
function imageModuleOpts() {
  return {
    centered: false,
    getImage(tagValue) {
      if (!tagValue || !fs.existsSync(tagValue)) {
        // Return a 1×1 transparent PNG so docxtemplater doesn't blow up
        return Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVQYV2NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
          'base64'
        );
      }
      return fs.readFileSync(tagValue);
    },
    getSize(_img, _tagValue, tagName) {
      if (tagName && /diagram|plan/i.test(tagName)) return [620, 380];
      return [560, 380]; // default photo size
    },
  };
}

/**
 * buildContext(pack, files) — produces the placeholder context for docxtemplater.
 * Defensive against missing fields so the template never throws on an empty pack.
 */
function buildContext(pack, files) {
  let data = {};
  try { data = JSON.parse(pack.data || '{}'); } catch { data = {}; }

  const scope_items = (data.scope_items || []).filter(s => s && s.trim()).map(text => ({ text }));

  const cameras = (data.cameras || []).map((r, i) => ({
    idx:      r.idx      || (i + 1),
    cabinet:  r.cabinet  || '',
    name:     r.name     || '',
    model:    r.model    || '',
    port:     r.port     || '',
    ip:       r.ip       || '',
    location: r.location || '',
  }));

  const backhauls = (data.backhauls || []).map((r, i) => ({
    idx:      r.idx      || (i + 1),
    type:     r.type     || '',
    mpn:      r.mpn      || '',
    vendor:   r.vendor   || '',
    location: r.location || '',
    ip:       r.ip       || '',
  }));

  const switches = (data.switches || []).map((r, i) => ({
    idx:    r.idx    || (i + 1),
    name:   r.name   || '',
    mpn:    r.mpn    || '',
    vendor: r.vendor || '',
    ip:     r.ip     || '',
  }));

  // ── Images ──
  // network_diagram_img & site_plan_img are single-file slots (kind='network_diagram'/'site_plan')
  // photos[] is the gallery (kind='photo'), each with caption
  const findFirst = (kind) => (files || []).find(f => f.kind === kind);
  const network = findFirst('network_diagram');
  const sitepl  = findFirst('site_plan');

  const photoRows = (files || [])
    .filter(f => f.kind === 'photo')
    .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));

  return {
    site_name:        data.site_name        || pack.name || '',
    site_address:     data.site_address     || '',
    site_subtitle:    data.site_subtitle    || '',
    contractor_org:   data.contractor_org   || '',
    contractor_person:data.contractor_person|| '',
    pm_org:           data.pm_org           || '',
    pm_person:        data.pm_person        || '',
    customer_org:     data.customer_org     || '',
    customer_person:  data.customer_person  || '',
    consultant_org:   data.consultant_org   || '',
    consultant_person:data.consultant_person|| '',
    engineer_org:     data.engineer_org     || '',
    engineer_person:  data.engineer_person  || '',
    submit_date:      data.submit_date      || '',
    update_date:      data.update_date      || '',
    intro_text:       data.intro_text       || '',
    network_arch_text:data.network_arch_text|| '',
    scope_items,
    cameras,
    backhauls,
    switches,
    // Image tag values are absolute paths; getImage() reads them
    network_diagram_img: network ? fileDiskPath(network.pack_id, network.filename) : '',
    site_plan_img:       sitepl  ? fileDiskPath(sitepl.pack_id,  sitepl.filename)  : '',
    photos: photoRows.map(p => ({
      img:     fileDiskPath(p.pack_id, p.filename),
      caption: p.caption || '',
    })),
    // Useful flags for conditional sections inside the template
    has_cameras:   cameras.length   > 0,
    has_backhauls: backhauls.length > 0,
    has_switches:  switches.length  > 0,
    has_photos:    photoRows.length > 0,
    has_network_diagram: !!network,
    has_site_plan:       !!sitepl,
  };
}

/**
 * generateDocPack(packId) — loads the pack + files, runs docxtemplater,
 * returns a Node Buffer containing the .docx bytes.
 */
function generateDocPack(packId) {
  const pack = db.getDocPack(packId);
  if (!pack) {
    const e = new Error('Pack not found'); e.code = 'PACK_NOT_FOUND';
    throw e;
  }
  const tplPath = templatePath(pack.type);
  if (!fs.existsSync(tplPath)) {
    const e = new Error(`Template missing: ${path.basename(tplPath)}`); e.code = 'TEMPLATE_MISSING';
    throw e;
  }
  const files = db.listDocPackFiles(packId);
  const context = buildContext(pack, files);

  const content = fs.readFileSync(tplPath, 'binary');
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    modules: [new ImageModule(imageModuleOpts())],
    errorLogging: 'json',
  });
  doc.render(context);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * dryRenderAllTemplates() — boot-time sanity check; renders every template
 * in TEMPLATES_DIR with empty sample data so we catch malformed templates
 * before the first user request. Logs results; does not throw.
 */
function dryRenderAllTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.log('[docpack] templates/ dir not found — skipping dry-render');
    return;
  }
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.toLowerCase().endsWith('.docx'));
  if (!files.length) {
    console.log('[docpack] no templates found in templates/ — skipping dry-render');
    return;
  }
  const samplePack = { id: 0, name: 'דוגמה', type: 'cctv', data: '{}' };
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'binary');
      const zip = new PizZip(content);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        modules: [new ImageModule(imageModuleOpts())],
      });
      doc.render(buildContext(samplePack, []));
      console.log(`[docpack] ✓ template ${f} dry-renders OK`);
    } catch (e) {
      console.error(`[docpack] ✗ template ${f} FAILED dry-render:`, e.message);
      if (e.properties && e.properties.errors) {
        for (const err of e.properties.errors.slice(0, 5)) {
          console.error('  -', err.message);
        }
      }
    }
  }
}

module.exports = {
  buildContext,
  generateDocPack,
  dryRenderAllTemplates,
  fileDiskPath,
  packDir,
  UPLOADS_DIR,
  TEMPLATES_DIR,
};
