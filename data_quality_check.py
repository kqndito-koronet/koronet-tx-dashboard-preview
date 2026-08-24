#!/usr/bin/env python3
"""
TX Dashboard V3 — Data Quality Check
Run BEFORE every push. Catches data issues that should never reach Facu.

Usage: python3 docs/transactions/scripts/data_quality_check.py
Exit code 0 = all pass, 1 = failures found
"""
import json, os, sys, re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')

errors = []
warnings = []

def error(msg): errors.append(msg)
def warn(msg): warnings.append(msg)

# Load data
with open(os.path.join(DATA, 'accounts_v3.json')) as f:
    accts = json.load(f)['accounts']

sell_cube = json.load(open(os.path.join(DATA, 'current', 'sell_monthly.json')))['data']
buy_cube = json.load(open(os.path.join(DATA, 'current', 'buy_monthly.json')))['data']

config = {}
config_path = os.path.join(DATA, 'config_evidence_v2.json')
if os.path.exists(config_path):
    config = json.load(open(config_path)).get('companies', {})

# Build lookups
sell_by_co = {}
for r in sell_cube:
    sell_by_co.setdefault(r['company_id'], []).append(r)

buy_by_co = {}
for r in buy_cube:
    buy_by_co.setdefault(r['company_id'], []).append(r)

print("=" * 60)
print("TX Dashboard V3 — Data Quality Check")
print("=" * 60)

# === CHECK 1: Bunches consistency ===
print("\n[1] Bunches consistency...")
for cid, rec in config.items():
    cfg = rec.get('config', {})
    br = rec.get('bunches_reality', {})
    actually_sells = br.get('actually_sells_bunches_ecom', None)
    bunch_gmv = br.get('bunch_ecom_gmv_2026', 0) or 0

    # Config says OFF but reality says sells bunches
    bunch_flag = cfg.get('is_on_hand_inventory_units') or cfg.get('sell_in_bunches') or cfg.get('bunches')
    if actually_sells == True and bunch_flag in (False, 0, 'false'):
        name = rec.get('company_name', cid)
        warn(f"Bunches: {name} — config flag OFF but sells ${bunch_gmv:,.0f} in bunches eCom. Dashboard must show bunches ACTIVE.")

    if actually_sells == False and bunch_gmv > 1000:
        name = rec.get('company_name', cid)
        error(f"Bunches: {name} — bunches_reality=false but bunch_ecom_gmv=${bunch_gmv:,.0f}. Data contradiction.")

# === CHECK 2: Online % honesty ===
print("[2] Online % honesty...")
for a in accts:
    dp = a.get('digital_pct')
    tier = a.get('product_tier', '')
    cid = str(a.get('company_id', ''))

    if dp is not None and dp >= 95:
        # Check if this is because we only see digital
        sell_rows = sell_by_co.get(cid, [])
        has_offline = any(r.get('channel') == 'Offline' and r.get('sell_gmv', 0) > 0 for r in sell_rows)

        if not has_offline and tier not in ('K2K', 'Procurement'):
            warn(f"Online %: {a['company_name']} shows {dp}% digital but has NO offline sales in cube. Label as 'solo digital visible'.")

# === CHECK 3: Product tier vs system_type ===
print("[3] Product tier vs system_type...")
uni_path = os.path.join(DATA, 'account_universe_v1.json')
if os.path.exists(uni_path):
    with open(uni_path) as f:
        uni = json.load(f)
    uni = uni if isinstance(uni, list) else uni.get('accounts', uni.get('companies', []))
    uni_by_id = {str(a.get('company_id','')): a for a in uni}

    for a in accts:
        cid = str(a.get('company_id', ''))
        urec = uni_by_id.get(cid, {})
        st = (urec.get('system_type', '') or '').lower()
        tier = a.get('product_tier', '')

        if tier == 'Core+' and 'k2k' in st and 'core' not in st:
            error(f"Tier mismatch: {a['company_name']} is Core+ but system_type='{urec.get('system_type')}'. Should be K2K.")
        if tier == 'Core+' and 'esuite' in st and 'core' not in st:
            error(f"Tier mismatch: {a['company_name']} is Core+ but system_type='{urec.get('system_type')}'. Should be eSuite.")
        if tier == 'Core+' and 'procurement' in st and 'core' not in st and 'k2k' not in st:
            error(f"Tier mismatch: {a['company_name']} is Core+ but system_type='{urec.get('system_type')}'. Should be Procurement.")

# === CHECK 4: GMV pace sanity ===
print("[4] GMV pace sanity...")
pacing_path = os.path.join(DATA, 'gmv_pacing.json')
if os.path.exists(pacing_path):
    with open(pacing_path) as f:
        pacing = json.load(f).get('pacing', [])

    for p in pacing:
        ref = p.get('gmv_reference', 0) or 0
        pace = p.get('annual_pace', 0) or 0
        conf = p.get('confidence', '')

        if ref > 0 and pace > 0:
            ratio = pace / ref
            if ratio > 5 and conf in ('Baja', 'Insuficiente'):
                warn(f"GMV pace: {p['company_name']} — pace ${pace:,.0f} is {ratio:.0f}x reference ${ref:,.0f} ({conf}). Likely seasonal distortion.")
            if ratio < 0.1 and conf == 'Alta':
                # Check if reference is ORA (declared, may be inflated) vs measured
                acct = next((a for a in accts if str(a.get('company_id','')) == str(p.get('company_id',''))), {})
                src = acct.get('gmv_source', '')
                if src in ('ORA', 'FCS'):
                    warn(f"GMV pace: {p['company_name']} — pace ${pace:,.0f} is only {ratio:.1%} of {src} ${ref:,.0f}. ORA may be inflated or account barely uses platform.")
                else:
                    error(f"GMV pace: {p['company_name']} — pace ${pace:,.0f} is only {ratio:.1%} of reference ${ref:,.0f} ({src}) but confidence is Alta. Investigate.")

# === CHECK 5: Active PMT vs Christine's source ===
print("[5] Active PMT alignment...")
active_pmt = [a for a in accts if a.get('has_active_pmt')]
print(f"   Active PMT: {len(active_pmt)} accounts")
for a in active_pmt:
    if not a.get('pmt_lead'):
        warn(f"PMT: {a['company_name']} is Active PMT but has no lead assigned.")

# === CHECK 6: Duplicate company_ids ===
print("[6] Duplicate check...")
ids = [str(a['company_id']) for a in accts if a.get('company_id')]
dupes = [x for x in set(ids) if ids.count(x) > 1]
for d in dupes:
    names = [a['company_name'] for a in accts if str(a.get('company_id','')) == d]
    error(f"Duplicate company_id {d}: {names}")

# === CHECK 7: Training/sandbox/demo accounts ===
print("[7] Test account check...")
for a in accts:
    name = (a.get('company_name', '') or '').lower()
    if any(t in name for t in ['training', 'sandbox', 'demo', 'test site']):
        error(f"Test account in universe: {a['company_name']} (id={a.get('company_id')})")

# === CHECK 8: GMV buy ratio ===
print("[8] Buy ratio check...")
for a in accts:
    ref = a.get('gmv_reference', 0) or 0
    buy = a.get('buy_gmv_estimated', 0) or 0
    if ref > 0 and buy > 0:
        ratio = buy / ref
        if abs(ratio - 0.45) > 0.01:
            error(f"Buy ratio: {a['company_name']} has ratio {ratio:.2f} (should be 0.45). gmv={ref}, buy_est={buy}")
            break  # Only report first one

# === CHECK 9: Accounts without ANY classification ===
print("[9] Classification completeness...")
no_tier = sum(1 for a in accts if not a.get('product_tier') or a['product_tier'] == 'Unknown')
no_type = sum(1 for a in accts if not a.get('business_type') or a['business_type'] == 'Unknown')
if no_tier > 0:
    warn(f"Classification: {no_tier} accounts with Unknown product_tier")
if no_type > 0:
    warn(f"Classification: {no_type} accounts with Unknown business_type")

# === CHECK 10: Renderer field compatibility ===
print("[10] Renderer field check...")
required_fields = ['company_id', 'company_name', 'business_type', 'product_tier', 'sell_channel',
                   'priority_level', 'potential_tier', 'engagement_status', 'impl_stage_display',
                   'has_active_pmt', 'gmv_reference', 'gmv_source']
for a in accts[:5]:  # Spot check first 5
    for f in required_fields:
        if f not in a:
            error(f"Missing field '{f}' in account {a.get('company_name', '?')}")

# === CHECK 11: Prioritization universe integrity ===
print("[11] Prioritization universe (Client Wholesaler filter)...")
required_fields.append('account_class')
client_ws = [a for a in accts
             if a.get('account_class') == 'Client'
             and a.get('business_type') == 'Wholesaler'
             and a.get('product_tier')
             and a.get('product_tier') != 'Unknown']
non_client_ws = [a for a in accts
                 if a.get('account_class') != 'Client'
                 and a.get('business_type') == 'Wholesaler'
                 and a.get('product_tier')
                 and a.get('product_tier') != 'Unknown']
print(f"   Client Wholesalers with tier: {len(client_ws)}")
if non_client_ws:
    for a in non_client_ws:
        warn(f"Non-Client wholesaler has product_tier: {a['company_name']} (class={a.get('account_class')}, tier={a.get('product_tier')}). "
             f"Will be excluded from matrix but should be reviewed.")
# Verify account_class exists on ALL accounts
no_class = [a for a in accts if not a.get('account_class')]
if no_class:
    for a in no_class[:5]:
        error(f"Missing account_class: {a.get('company_name', '?')} (id={a.get('company_id')}). Cannot filter for matrix.")
    if len(no_class) > 5:
        error(f"...and {len(no_class) - 5} more accounts without account_class")

# === CHECK 12: Renderer uses canonical filter ===
print("[12] Renderer canonical filter check...")
renderer_path = os.path.join(BASE, 'index_v3.html')
if os.path.exists(renderer_path):
    renderer_code = open(renderer_path).read()
    if 'isClientWholesaler' not in renderer_code:
        error("Renderer does NOT use EvidenceAdapter.isClientWholesaler(). Matrix may include non-Client accounts.")
    # Check for any inline business_type === 'Wholesaler' filter that bypasses the canonical function
    import re
    # Check for inline Wholesaler filters in _filteredEvidence.filter() contexts (bypasses canonical)
    # Exclude tab counters and dropdown setters which legitimately reference 'Wholesaler'
    filter_sections = re.findall(r'_filteredEvidence\.filter\([^)]*business_type\s*===?\s*[\'"]Wholesaler[\'"]', renderer_code)
    if filter_sections:
        error(f"Renderer has {len(filter_sections)} inline Wholesaler filter(s) in _filteredEvidence.filter() bypassing canonical isClientWholesaler().")

# === CHECK 13: Proportional logic (smell test) ===
print("[13] Proportional logic...")

# Build sell/buy lookups
sell_by_co_online = {}
sell_by_co_total = {}
for r in sell_cube:
    cid = str(r.get('company_id',''))
    gmv = r.get('sell_gmv', 0) or 0
    sell_by_co_total[cid] = sell_by_co_total.get(cid, 0) + gmv
    ch = r.get('channel', r.get('sales_channel', ''))
    if ch in ('Online', 'eCommerce', 'K2K', 'API'):
        sell_by_co_online[cid] = sell_by_co_online.get(cid, 0) + gmv

buy_by_co = {}
for r in buy_cube:
    cid = str(r.get('company_id',''))
    buy_by_co[cid] = buy_by_co.get(cid, 0) + (r.get('buy_gmv', 0) or 0)

acct_by_id = {str(a.get('company_id','')): a for a in accts}

for a in accts:
    if a.get('account_class') != 'Client':
        continue
    cid = str(a.get('company_id',''))
    sell = sell_by_co_total.get(cid, 0)
    buy = buy_by_co.get(cid, 0)
    gmv = a.get('gmv_reference', 0) or 0
    online = sell_by_co_online.get(cid, 0)
    tier = a.get('product_tier', '')
    bt = a.get('business_type', '')
    name = a.get('company_name', '?')

    # A. Buy/sell ratio: wholesalers typically 0.3-0.7
    if sell > 200000 and buy > 0:
        ratio = buy / sell
        if ratio > 1.5 and bt == 'Wholesaler':
            warn(f"BUY>>SELL: {name} buy/sell={ratio:.2f} — buying more than selling, broker pattern?")

    # B. eSuite with >50% offline sell — should be Core+
    if tier == 'eSuite' and sell > 100000:
        offline = sell - online
        if sell > 0 and offline / sell > 0.5:
            warn(f"ESUITE_OFFLINE: {name} {offline/sell*100:.0f}% offline sell — should be Core+?")

    # C. Online sell but $0 in fees cube — investigate
    # (only flag if significant online volume)
    if online > 50000 and bt == 'Wholesaler':
        # Check if in fees cube
        fees_path = os.path.join(DATA, 'current', 'fees_monthly.json')
        if os.path.exists(fees_path):
            with open(fees_path) as f:
                fees_data = json.load(f).get('data', [])
            has_fees = any(str(r.get('company_id','')) == cid for r in fees_data if (r.get('fee_amount',0) or 0) > 0)
            if not has_fees:
                warn(f"NO_FEES: {name} has ${online:,.0f} online sell but $0 fees — K2K seller-side or data gap?")

    # D. GMV sanity: annualized sell shouldn't exceed GMV for non-tautological
    if gmv > 0 and sell > 0 and a.get('gmv_source','') not in ('Medido','Piso de red','Piso (solo K2K)','Piso (solo KP)'):
        ann_sell = sell * 12 / 7  # YTD assumption
        if ann_sell > gmv * 1.1:
            warn(f"SELL>GMV: {name} ann_sell=${ann_sell:,.0f} > gmv=${gmv:,.0f} ({a.get('gmv_source')}) — estimate too low?")

# === RESULTS ===
print("\n" + "=" * 60)
print(f"ERRORS: {len(errors)}")
for e in errors:
    print(f"  ❌ {e}")
print(f"\nWARNINGS: {len(warnings)}")
for w in warnings:
    print(f"  ⚠️  {w}")
print(f"\nTotal accounts: {len(accts)}")
print("=" * 60)

if errors:
    print("\n🔴 FAIL — fix errors before pushing")
    sys.exit(1)
else:
    print("\n🟢 PASS — warnings are informational, errors are zero")
    sys.exit(0)
