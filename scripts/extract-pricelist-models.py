"""
scripts/extract-pricelist-models.py
Extract {mfr, model, ds} from PRICE_LIST_DATA in dashboard.html -> pricelist-models.json
Run: python scripts/extract-pricelist-models.py
"""
import re, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_PATH = os.path.join(ROOT, 'dashboard.html')
OUT_PATH  = os.path.join(ROOT, 'pricelist-models.json')

with open(HTML_PATH, encoding='utf-8') as f:
    html = f.read()

# ── Locate the PRICE_LIST_DATA array ───────────────────────────────────────────
marker = 'const PRICE_LIST_DATA'  # matches both "= [" and "=["
start  = html.find(marker)
if start == -1:
    print('ERROR: PRICE_LIST_DATA not found'); sys.exit(1)

arr_start = html.index('[', start)

# Bracket-match to find the end
depth = 0
arr_end = -1
for i in range(arr_start, len(html)):
    c = html[i]
    if   c == '[': depth += 1
    elif c == ']':
        depth -= 1
        if depth == 0: arr_end = i; break
if arr_end == -1:
    print('ERROR: could not find closing ] for PRICE_LIST_DATA'); sys.exit(1)

array_text = html[arr_start:arr_end+1]

# ── Extract each object ──────────────────────────────────────────────────────
# Regex for one field: key: 'value'  or  key: "value"
def grab(text, key):
    m = re.search(r'\b' + key + r'\s*:\s*[\'"]([^\'\"]*)[\'"]', text)
    return m.group(1) if m else ''

# Split on object boundaries: find each { ... } at depth-1 of the array
items = []
seen  = set()
obj_re = re.compile(r'\{[^{}]*\}', re.DOTALL)
for m in obj_re.finditer(array_text):
    obj = m.group(0)
    mfr   = grab(obj, 'mfr')
    model = grab(obj, 'model')
    ds    = grab(obj, 'ds')
    if not mfr or not model:
        continue
    key = f'{mfr}||{model}'
    if key in seen:
        continue
    seen.add(key)
    items.append({'mfr': mfr, 'model': model, 'ds': ds})

with open(OUT_PATH, 'w', encoding='utf-8') as f:
    json.dump(items, f, ensure_ascii=False, indent=2)

print(f'Extracted {len(items)} unique (mfr, model) entries -> pricelist-models.json')
by_mfr = {}
for x in items:
    by_mfr[x['mfr']] = by_mfr.get(x['mfr'], 0) + 1
for mfr, n in sorted(by_mfr.items(), key=lambda t: -t[1]):
    has_ds = sum(1 for x in items if x['mfr']==mfr and x['ds'])
    print(f"  {mfr:<14} {n:>4} items  ({has_ds} with existing ds url)")
