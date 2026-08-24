#!/usr/bin/env python3
"""
TX Dashboard — Account Classification Engine
Runs EVERY TIME accounts_v3.json is regenerated.

This is the SINGLE SOURCE OF TRUTH for:
- Client vs Pre-live vs Prospect
- Business type (Wholesaler vs Importer vs Grower vs Retailer)
- Product tier (Core+ vs eSuite vs Procurement vs K2K)
- Potential tier (Flagship vs Growth Engine vs Activate vs Seed)

Rules are CODE, not documents. If a rule changes, change it HERE.
"""
import json, os, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')

# ═══════════════════════════════════════════════════════════
# RULE 1: CLIENT vs PRE-LIVE vs PROSPECT
# ═══════════════════════════════════════════════════════════
# Client = ALL of:
#   - Has company_id in Snowflake
#   - komet_status = "Production - Live"
#   - sfdc_type NOT in (Prospect, Churned Customer, blank)
#   - system_type is a Komet product
#
# Pre-live = komet_status = "Implementation - Not Live"
# Prospect = everything else

KOMET_PRODUCTS = {
    'komet core', 'komet sales', 'komet - k2k', 'komet - e-commerce',
    'koronet esuite', 'koronet procurement', 'koronet procurement - free trial',
    'komet sales - k2k', 'komet sales - e-commerce', 'procurement lite trial',
    'k2k e-commerce', 'esuite wholesaler', 'esuite grower', 'esuite virtual broker',
}

OTHER_ERP = {'smart system', 'axerrio', 'axerrio core', 'unosof core', 'mas',
             'quickbooks', 'easy flower', 'flowers online', 'in house system', 'excel'}

def classify_account_class(account, universe_record):
    """Returns (account_class, prospect_reason)"""
    cid = account.get('company_id')
    has_id = bool(cid and str(cid) != 'None')
    ks = account.get('komet_status', '')
    sfdc = universe_record.get('sfdc_type', '')
    st = (universe_record.get('system_type', '') or '').lower()

    is_komet = any(kp in st for kp in KOMET_PRODUCTS) if st else False
    is_other = any(np in st for np in OTHER_ERP) if st else False

    if has_id and ks == 'Production - Live' and sfdc not in ('Prospect', 'Churned Customer', '') and is_komet and not is_other:
        return 'Client', None
    elif ks == 'Implementation - Not Live':
        return 'Pre-live', None
    else:
        reasons = []
        if not has_id: reasons.append('No Snowflake ID')
        if ks == 'Deactivated': reasons.append('Deactivated')
        if sfdc in ('Prospect', ''): reasons.append('SFDC Prospect')
        if sfdc == 'Churned Customer': reasons.append('Churned')
        if is_other: reasons.append('Other ERP: ' + (universe_record.get('system_type', '') or ''))
        if not is_komet and not is_other and has_id and ks == 'Production - Live':
            reasons.append('No Komet product: ' + (st or 'blank'))
        return 'Prospect', ', '.join(reasons) or 'Other'


# ═══════════════════════════════════════════════════════════
# RULE 2: PRODUCT TIER — from system_type + sell channel reality
# ═══════════════════════════════════════════════════════════
# Core+ = system_type contains Core/Komet Sales (not K2K-only)
# eSuite = system_type contains eSuite OR has eCommerce sell (even if system_type says Procurement)
# Procurement = system_type contains Procurement AND no sell data
# K2K = system_type contains K2K (not Core, not eSuite)

def classify_product_tier(account, universe_record, has_ecom_sell):
    """Returns product_tier"""
    st = (universe_record.get('system_type', '') or '').lower()

    if not st:
        return 'Unknown'
    if 'esuite' in st:
        return 'eSuite'
    if ('core' in st or 'komet sales' in st) and 'k2k' not in st and 'e-commerce' not in st:
        return 'Core+'
    if 'e-commerce' in st or 'ecommerce' in st:
        # Komet E-Commerce = eSuite product
        return 'eSuite'
    if 'procurement' in st:
        # If they sell via eCom, they're eSuite (not Procurement-only)
        if has_ecom_sell:
            return 'eSuite'
        return 'Procurement'
    if 'k2k' in st:
        return 'K2K'
    return 'Unknown'


# ═══════════════════════════════════════════════════════════
# RULE 3: BUSINESS TYPE — from industry, verified by name
# ═══════════════════════════════════════════════════════════
# Trust industry field, but verify against name for obvious mismatches.

NOT_WHOLESALER_NAMES = ['import', 'farm', 'grower', 'nursery', 'garden center', 'retail', 'studio']

def classify_business_type(account, buy_sell_ratio=None):
    """Returns business_type.
    buy_sell_ratio: annualized buy / annualized sell.
    If < 0.5 with significant sell → likely Importer (sells more than buys through Koronet).
    """
    ind = (account.get('industry', '') or '').lower()
    name = (account.get('company_name', '') or '').lower()

    if 'importer' in ind: return 'Importer'
    if 'grower' in ind or 'farm' in ind: return 'Grower'
    if 'retailer' in ind: return 'Retailer'
    if 'wholesaler' in ind or 'wholesale' in ind: return 'Wholesaler'

    # Fallback: check name
    if 'wholesale' in name: return 'Wholesaler'
    if 'import' in name: return 'Importer'
    if any(w in name for w in ['farm', 'grower', 'nursery']): return 'Grower'

    # Buy/sell ratio signal: < 0.5 = sells more than buys = likely importer/producer
    if buy_sell_ratio is not None and buy_sell_ratio < 0.5:
        return 'Importer'

    return 'Wholesaler'  # Default assumption for floral industry


# ═══════════════════════════════════════════════════════════
# RULE 4: POTENTIAL TIER — from GMV × product tier
# ═══════════════════════════════════════════════════════════
# Separate thresholds by capability (Core+ can monetize more than K2K)

def classify_potential_tier(gmv, product_tier, ann_sell=0):
    """Returns potential_tier.
    If account has Core+/eSuite but barely uses it (penetration < 5%),
    downgrade one level — the capability is theoretical, not real.
    """
    if not gmv or gmv <= 0:
        return 'Unmeasured'

    # Penetration: how much of Est GMV flows through Koronet
    pen = (ann_sell / gmv * 100) if gmv > 0 and ann_sell > 0 else 0

    if product_tier in ('Core+', 'eSuite'):
        if gmv >= 10_000_000:
            # Flagship only if they actually USE the platform (pen >= 5%)
            # Otherwise they have Core but don't use it → Growth Engine (grow them)
            return 'Flagship' if pen >= 5 else 'Growth Engine'
        if gmv >= 2_000_000: return 'Growth Engine'
        if gmv >= 500_000: return 'Activate'
        return 'Seed'
    # K2K/Procurement — shifted (less platform capability)
    if gmv >= 10_000_000: return 'Growth Engine'
    if gmv >= 2_000_000: return 'Activate'
    return 'Seed'


# ═══════════════════════════════════════════════════════════
# RULE 5: GMV FOR K2K/PROCUREMENT
# ═══════════════════════════════════════════════════════════
# If product_tier is K2K or Procurement, "Medido" GMV is only what passes
# through Koronet — NOT their real business. Use external estimate if available
# and larger. Label the Koronet-measured as "Piso (solo K2K/KP)".

def adjust_gmv_for_channel(account, external_estimate):
    """Adjusts gmv_reference for K2K/Procurement accounts"""
    tier = account.get('product_tier', '')
    if tier not in ('K2K', 'Procurement'):
        return  # Only adjust non-Core accounts

    measured = account.get('gmv_reference', 0) or 0
    source = account.get('gmv_source', '')
    ext_mid = external_estimate.get('estimated_gmv_mid', 0) or 0

    if source == 'Medido' and measured > 0:
        account['gmv_koronet_visible'] = measured
        account['gmv_koronet_channel'] = 'K2K' if tier == 'K2K' else 'KP'
        if ext_mid > measured * 2:
            account['gmv_reference'] = ext_mid
            account['gmv_source'] = 'Estimado'
        else:
            account['gmv_source'] = 'Piso (solo ' + ('K2K' if tier == 'K2K' else 'KP') + ')'
            account['gmv_is_floor'] = True


# ═══════════════════════════════════════════════════════════
# MAIN — apply all rules
# ═══════════════════════════════════════════════════════════

def run(accounts_path=None, universe_path=None, sell_path=None, external_path=None, k2k_path=None):
    accounts_path = accounts_path or os.path.join(DATA, 'accounts_v3.json')
    universe_path = universe_path or os.path.join(DATA, 'account_universe_v1.json')
    sell_path = sell_path or os.path.join(DATA, 'current', 'sell_monthly.json')
    external_path = external_path or os.path.join(DATA, 'gmv_estimates_external.json')
    k2k_path = k2k_path or os.path.join(DATA, 'gmv_estimates_k2k.json')

    with open(accounts_path) as f:
        accts = json.load(f)
    with open(universe_path) as f:
        uni = json.load(f)
    uni = uni if isinstance(uni, list) else uni.get('accounts', uni.get('companies', []))
    uni_by_id = {str(a.get('company_id', '')): a for a in uni}

    with open(sell_path) as f:
        sell = json.load(f)['data']

    # Load buy cube for tier inference
    buy_path = os.path.join(DATA, 'current', 'buy_monthly.json')
    buy_data = []
    if os.path.exists(buy_path):
        with open(buy_path) as f:
            buy_data = json.load(f)['data']

    # Build buy YTD lookup
    buy_ytd = {}
    for r in buy_data:
        if r.get('month', '') >= '2026-01':
            cid = str(r['company_id'])
            buy_ytd[cid] = buy_ytd.get(cid, 0) + (r.get('buy_gmv', 0) or 0)

    # Build sell lookups: channel, YTD totals, month counts
    # Use string company_id consistently to avoid int/str mismatch
    ecom_sell = set()
    sell_ytd = {}   # company_id (str) → total sell YTD 2026
    sell_months = {}  # company_id (str) → set of months
    for r in sell:
        if r['month'] >= '2026-01':
            cid = str(r['company_id'])
            gmv = r.get('sell_gmv', 0) or 0
            if r['channel'] in ('Online', 'eCommerce') and gmv > 0:
                ecom_sell.add(cid)
            sell_ytd[cid] = sell_ytd.get(cid, 0) + gmv
            sell_months.setdefault(cid, set()).add(r['month'])

    # Load external estimates
    ext_by_id = {}
    for path in [external_path, k2k_path]:
        if os.path.exists(path):
            with open(path) as f:
                for e in json.load(f).get('estimates', []):
                    cid = str(e.get('company_id', ''))
                    if cid:
                        ext_by_id[cid] = e

    # Apply all rules
    stats = {'Client': 0, 'Pre-live': 0, 'Prospect': 0}

    for a in accts['accounts']:
        cid = str(a.get('company_id', ''))
        urec = uni_by_id.get(cid, {})

        # Rule 1: Account class
        a['account_class'], a['prospect_reason'] = classify_account_class(a, urec)
        stats[a['account_class']] += 1

        # Rule 2: Product tier
        has_ecom = str(cid) in ecom_sell
        a['product_tier'] = classify_product_tier(a, urec, has_ecom)

        # Rule 3: Business type — use buy/sell ratio if available
        cid_for_ratio = str(a.get('company_id', ''))
        s_ytd = sell_ytd.get(cid_for_ratio, 0)
        b_ytd = buy_ytd.get(cid_for_ratio, 0)
        bs_ratio = b_ytd / s_ytd if s_ytd > 100_000 else None  # only meaningful with significant sell
        a['business_type'] = classify_business_type(a, bs_ratio)

        # Rule 5: GMV adjustment for K2K/Proc
        ext = ext_by_id.get(cid, {})
        adjust_gmv_for_channel(a, ext)

        # Rule 4: Potential tier (after GMV adjustment) — needs ann_sell for pen check
        cid_str = str(cid)
        ytd_sell = sell_ytd.get(cid_str, 0)
        ms_sell = len(sell_months.get(cid_str, set()))
        ann_sell_val = ytd_sell * (12 / ms_sell) if ms_sell > 0 else 0
        a['potential_tier'] = classify_potential_tier(a.get('gmv_reference', 0), a['product_tier'], ann_sell_val)

        # Buy GMV
        gmv = a.get('gmv_reference', 0) or 0
        a['buy_gmv_estimated'] = round(gmv * 0.45) if gmv > 0 else None

    # ═══════════════════════════════════════════════════════════
    # RULE 6: AUTO-PROMOTE Prospect/Pre-live → Client
    # If ann_sell > $100K, they're functionally a Client
    # ═══════════════════════════════════════════════════════════
    promoted = 0
    for a in accts['accounts']:
        if a['account_class'] not in ('Prospect', 'Pre-live'):
            continue
        cid = str(a.get('company_id', ''))
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        if ms > 0:
            ann = ytd * (12 / ms)
            if ann > 100_000 and a.get('komet_status') != 'Deactivated':
                a['account_class'] = 'Client'
                a['prospect_auto_promoted'] = True
                a['prospect_original_reason'] = a.get('prospect_reason', '')
                stats['Client'] += 1
                stats[a.get('prospect_reason_class', 'Prospect')] = stats.get(a.get('prospect_reason_class', 'Prospect'), 0)
                promoted += 1

    # ═══════════════════════════════════════════════════════════
    # RULE 7: INFER Unknown tier from sell channel
    # If Unknown tier AND ann_sell > $100K, infer from channel mix
    # ═══════════════════════════════════════════════════════════
    inferred = 0
    for a in accts['accounts']:
        if a.get('product_tier') not in ('Unknown', None, ''):
            continue
        cid = str(a.get('company_id', ''))
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        if ms == 0 or ytd * (12 / ms) < 100_000:
            continue
        has_ecom = cid in ecom_sell
        has_buy = buy_ytd.get(cid, 0) > 0
        urec = uni_by_id.get(cid, {})
        st = (urec.get('system_type', '') or '').lower()
        # Infer from system_type or sell channel
        if has_ecom or 'esuite' in st or 'e-commerce' in st:
            a['product_tier'] = 'eSuite'
            a['tier_inferred'] = True
            inferred += 1
        elif 'core' in st or 'komet sales' in st:
            a['product_tier'] = 'Core+'
            a['tier_inferred'] = True
            inferred += 1
        elif 'k2k' in st:
            a['product_tier'] = 'K2K'
            a['tier_inferred'] = True
            inferred += 1
        # Infer from product flags (eShop, Procurement)
        elif a.get('has_eshop') and a.get('has_procurement'):
            a['product_tier'] = 'eSuite'
            a['tier_inferred'] = True
            inferred += 1
        elif a.get('has_eshop'):
            a['product_tier'] = 'eSuite'
            a['tier_inferred'] = True
            inferred += 1
        elif a.get('has_procurement'):
            a['product_tier'] = 'Procurement'
            a['tier_inferred'] = True
            inferred += 1
        # Infer from buy activity (if buying through Koronet → at least K2K)
        elif has_buy:
            a['product_tier'] = 'K2K'
            a['tier_inferred'] = True
            inferred += 1

    # ═══════════════════════════════════════════════════════════
    # RULE 11: PREFER external estimate over Medido for solo_digital
    # If account only sees digital channel and has an external estimate,
    # the external estimate is more accurate than the digital-only Medido
    # ═══════════════════════════════════════════════════════════
    ext_upgraded = 0
    for a in accts['accounts']:
        if a.get('digital_pct_caveat') != 'solo_digital_visible':
            continue
        src = a.get('gmv_source', '')
        if not src.startswith(('Medido', 'Piso')):
            continue  # already has Estimado/ORA
        cid = str(a.get('company_id', ''))
        ext = ext_by_id.get(cid, {})
        ext_mid = ext.get('estimated_gmv_mid', 0) or 0
        if ext_mid > 0:
            a['gmv_reference'] = ext_mid
            a['gmv_source'] = 'Estimado'
            a['gmv_is_floor'] = False
            a['buy_gmv_estimated'] = round(ext_mid * 0.45)
            ext_upgraded += 1

    # ═══════════════════════════════════════════════════════════
    # RULE 12: UPGRADE eSuite → Core+ if Offline sell > 50%
    # Offline sell means they use Koronet as ERP (only Core processes offline)
    # ═══════════════════════════════════════════════════════════
    offline_sell = {}
    total_sell_by_co = {}
    for r in sell:
        if r['month'] >= '2026-01':
            cid = str(r['company_id'])
            gmv = r.get('sell_gmv', 0) or 0
            total_sell_by_co[cid] = total_sell_by_co.get(cid, 0) + gmv
            if r.get('channel') == 'Offline':
                offline_sell[cid] = offline_sell.get(cid, 0) + gmv

    upgraded_core = 0
    for a in accts['accounts']:
        if a.get('product_tier') != 'eSuite':
            continue
        cid = str(a.get('company_id', ''))
        off = offline_sell.get(cid, 0)
        tot = total_sell_by_co.get(cid, 0)
        if tot > 0 and off / tot > 0.5:
            a['product_tier'] = 'Core+'
            a['tier_upgrade_reason'] = f'Offline sell {off/tot*100:.0f}% of total'
            upgraded_core += 1

    # ═══════════════════════════════════════════════════════════
    # RULE 8: REFRESH gmv_reference for Medido/Piso
    # If ann_sell 2026 > gmv_reference * 1.05, update
    # ═══════════════════════════════════════════════════════════
    refreshed = 0
    for a in accts['accounts']:
        src = a.get('gmv_source', '')
        if not src or not src.startswith(('Medido', 'Piso')):
            continue
        cid = str(a.get('company_id', ''))
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        if ms == 0 or ytd <= 0:
            continue
        ann = ytd * (12 / ms)
        ref = a.get('gmv_reference', 0) or 0
        if ann > ref * 1.05:
            a['gmv_reference'] = round(ann)
            a['buy_gmv_estimated'] = round(ann * 0.45)
            refreshed += 1

    # ═══════════════════════════════════════════════════════════
    # RULE 9: FLAG suspect Estimado (>20x ann_sell)
    # Don't change the value — flag it for review
    # ═══════════════════════════════════════════════════════════
    suspect = 0
    for a in accts['accounts']:
        if a.get('gmv_source') != 'Estimado':
            continue
        cid = str(a.get('company_id', ''))
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        ref = a.get('gmv_reference', 0) or 0
        if ms > 0 and ytd > 10_000 and ref > 0:
            ann = ytd * (12 / ms)
            ratio = ann / ref
            if ratio < 0.05:  # estimate > 20x reality
                a['gmv_estimate_suspect'] = True
                suspect += 1
            else:
                a['gmv_estimate_suspect'] = False

    # ═══════════════════════════════════════════════════════════
    # RULE 10: PISO for accounts with no GMV but Koronet activity
    # If gmv_reference missing/zero AND has sell data → Piso de red
    # ═══════════════════════════════════════════════════════════
    piso_filled = 0
    for a in accts['accounts']:
        ref = a.get('gmv_reference') or 0
        src = a.get('gmv_source', '')
        if ref > 0 and src not in ('not in Christine cascade', 'Sin dato', ''):
            continue
        cid = str(a.get('company_id', ''))
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        if ms > 0 and ytd > 0:
            ann = ytd * (12 / ms)
            a['gmv_reference'] = round(ann)
            a['gmv_source'] = 'Piso de red'
            a['gmv_is_floor'] = True
            a['buy_gmv_estimated'] = round(ann * 0.45)
            piso_filled += 1

    # Recompute potential_tier after all adjustments
    for a in accts['accounts']:
        cid = str(a.get('company_id', ''))
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        ann = ytd * (12 / ms) if ms > 0 else 0
        a['potential_tier'] = classify_potential_tier(a.get('gmv_reference', 0), a['product_tier'], ann)
        gmv = a.get('gmv_reference', 0) or 0
        a['buy_gmv_estimated'] = round(gmv * 0.45) if gmv > 0 else None

    # ═══════════════════════════════════════════════════════════
    # SMELL TEST — catch things before they reach Facu
    # ═══════════════════════════════════════════════════════════
    smell_issues = []
    for a in accts['accounts']:
        cid = str(a.get('company_id', ''))
        name = a.get('company_name', '?')
        ytd = sell_ytd.get(cid, 0)
        ms = len(sell_months.get(cid, set()))
        ann = ytd * (12 / ms) if ms > 0 else 0
        gmv = a.get('gmv_reference') or 0
        bt = a.get('business_type', '')
        tier = a.get('product_tier', '')
        cls = a.get('account_class', '')

        # 1. Wholesaler with 100% online sell and significant volume → probably wrong
        if bt == 'Wholesaler' and tier == 'Core+' and ann > 500_000:
            caveat = a.get('digital_pct_caveat', '')
            if caveat == 'solo_digital_visible':
                smell_issues.append(f'SMELL: {name} — Core+ Wholesaler ${ann:,.0f}/yr but solo_digital_visible. Offline data missing from cube?')

        # 2. Buy ≈ Sell (broker pattern) classified as Wholesaler
        buy_ytd_val = 0
        # approximate from buy cube if available
        if ann > 200_000 and a.get('buy_gmv_estimated') and gmv > 0:
            # We don't have buy_ytd easily here, skip for now
            pass

        # 3. Prospect with >$500K sell that wasn't promoted (shouldn't happen after Rule 6)
        if cls == 'Prospect' and ann > 500_000:
            smell_issues.append(f'SMELL: {name} — Prospect with ${ann:,.0f}/yr sell. Should have been promoted by Rule 6.')

        # 4. eSuite/K2K with Medido GMV < $200K but known to be large (suspect small Medido)
        if tier in ('eSuite', 'K2K') and a.get('gmv_source', '').startswith('Medido') and gmv < 200_000 and gmv > 0:
            smell_issues.append(f'SMELL: {name} — {tier} with Medido ${gmv:,.0f}. Only sees digital channel. Needs external estimate.')

    if smell_issues:
        print(f"\n  ⚠️  SMELL TEST: {len(smell_issues)} issues")
        for s in smell_issues[:10]:
            print(f"    {s}")
        if len(smell_issues) > 10:
            print(f"    ...and {len(smell_issues) - 10} more")

    # ═══════════════════════════════════════════════════════════
    # EXPORT — Christine's source of truth view
    # CSV with: company_id, name, class, type, tier, gmv, source,
    #           confidence, ann_sell, ann_buy, penetration, flags
    # Christine reads this. Her overrides go back to her sheet.
    # ═══════════════════════════════════════════════════════════
    import csv
    export_path = os.path.join(DATA, 'gmv_source_of_truth.csv')
    with open(export_path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['company_id', 'company_name', 'account_class', 'business_type',
                     'product_tier', 'potential_tier', 'gmv_reference', 'gmv_source',
                     'ann_sell_2026', 'sell_months', 'penetration_pct',
                     'suspect_estimate', 'needs_review', 'notes'])
        for a in sorted(accts['accounts'], key=lambda x: x.get('gmv_reference', 0) or 0, reverse=True):
            cid = str(a.get('company_id', ''))
            ytd = sell_ytd.get(cid, 0)
            ms = len(sell_months.get(cid, set()))
            ann = round(ytd * (12 / ms)) if ms > 0 else 0
            gmv = a.get('gmv_reference') or 0
            src = a.get('gmv_source', '')
            is_taut = src.startswith('Medido') or src.startswith('Piso')
            pen = '~100% (tautological)' if is_taut and ann > 0 else (round(ann / gmv * 100, 1) if gmv > 0 and ann > 0 else '')
            suspect_flag = a.get('gmv_estimate_suspect', False)
            needs_review = ''
            if suspect_flag:
                needs_review = 'Estimado >20x reality'
            elif a.get('digital_pct_caveat') == 'solo_digital_visible' and a.get('gmv_source', '').startswith('Medido') and gmv < 500_000:
                needs_review = 'Medido = solo digital, needs external estimate'
            elif a.get('prospect_auto_promoted'):
                needs_review = f'Auto-promoted from Prospect ({a.get("prospect_original_reason", "")})'
            elif a.get('tier_inferred'):
                needs_review = 'Tier inferred from sell channel (not from system_type)'
            w.writerow([
                a.get('company_id', ''), a.get('company_name', ''),
                a.get('account_class', ''), a.get('business_type', ''),
                a.get('product_tier', ''), a.get('potential_tier', ''),
                gmv, a.get('gmv_source', ''),
                ann, ms, pen,
                suspect_flag, needs_review, ''
            ])
    print(f"\n  📋 Exported: {export_path} ({len(accts['accounts'])} rows)")

    # Save
    with open(accounts_path, 'w') as f:
        json.dump(accts, f, indent=2, ensure_ascii=False)

    # Summary
    ws_clients = [a for a in accts['accounts'] if a['account_class'] == 'Client' and a['business_type'] == 'Wholesaler' and a['product_tier'] not in ('Unknown', None, '')]

    print(f"Classification complete: {len(accts['accounts'])} accounts")
    print(f"  Client: {stats['Client']} · Pre-live: {stats['Pre-live']} · Prospect: {stats['Prospect']}")
    print(f"  Rule 6: {promoted} auto-promoted to Client (ann_sell > $500K)")
    print(f"  Rule 7: {inferred} tiers inferred from sell channel")
    print(f"  Rule 8: {refreshed} Medido/Piso gmv_reference refreshed")
    print(f"  Rule 9: {suspect} Estimado flagged suspect (>20x reality)")
    print(f"  Rule 10: {piso_filled} accounts got Piso de red (had no GMV)")
    print(f"  Rule 11: {ext_upgraded} solo_digital upgraded to external estimate")
    print(f"  Rule 12: {upgraded_core} eSuite → Core+ (Offline sell > 50%)")
    print(f"  Wholesaler clients with product: {len(ws_clients)}")
    for t in ['Core+', 'eSuite', 'Procurement', 'K2K']:
        n = sum(1 for a in ws_clients if a['product_tier'] == t)
        if n > 0:
            print(f"    {t}: {n}")


if __name__ == '__main__':
    run()
