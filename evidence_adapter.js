/**
 * evidence_adapter.js — TX Dashboard Phase 2 Evidence Adapter
 * Koronet Revenue OS · Chapter TX
 *
 * Loads all 13 Phase 2 data files once, then provides O(1) lookup via:
 *   getAccountEvidence(companyId, timeframe)
 *
 * Keying strategy:
 *   company_id (string) is the primary key throughout.
 *   Files keyed by company_name are resolved via account_universe (name→id map).
 *   Files keyed by company_id use the id directly (as string).
 *
 * Evidence states: 'observed' | 'proxy' | 'model' | 'gap'
 *
 * Timeframe tokens (timeframe param):
 *   'current_month'  — most recent month in the monthly series
 *   'prior_month'    — second-most-recent month
 *   'ytd'            — YTD 2026 aggregates (default)
 *   'l12m'           — last-12-months aggregate
 *
 * Graceful fallback: any missing file or missing account returns null for that section.
 */

(function (root) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     MODULE STATE — populated by _loadAll(), then frozen
  ───────────────────────────────────────────────────────────────────────── */
  const _state = {
    loaded: false,
    loadPromise: null,

    // Raw file data
    universe: [],           // account_universe_v1.json  (list)
    estGmv: {},             // est_gmv_v2.json           .accounts  (id → obj)
    crosswalk: [],          // identity_crosswalk_final.json .records (list)
    sellDomain: {},         // sell_domain_v2.json       .companies (name → obj)
    buyDomain: {},          // buy_domain_v2.json        .companies (name → obj)
    feesDomain: {},         // fees_domain_v2.json       .companies (name → obj)
    buyers: {},             // buyers_evidence_v2.json   .companies (name → obj)
    vendors: [],            // vendors_evidence_v2.json  .companies (list)
    temporal: {},           // temporal_evidence_v2.json (raw)
    inventory: {},          // inventory_current_v1.json .companies (id → obj)
    benchmarks: {},         // benchmarks_v2.json        .benchmarks
    config: {},             // config_evidence_v2.json   .companies (id → obj)
    hardgoods: [],          // hardgoods_v2.json         .companies (list)
    skusOnlineOffline: {},  // skus_online_offline.json  .companies (name → obj)

    // Derived lookup maps (built after all files loaded)
    idToName: {},           // company_id → company_name
    nameToId: {},           // company_name → company_id
    idToUniverse: {},       // company_id → universe record
    vendorsByName: {},      // company_name → vendor record
    hardgoodsByName: {},    // company_name → hardgoods record
    temporalSellAnticipation: {},   // company_name → [ rows ]
    temporalVarietyFreshness: {},   // company_name → [ rows ]
    temporalForwardInventory: {},   // company_name → [ rows ]
  };

  /* ─────────────────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────────────── */
  const DATA_BASE = 'data/';

  const FILES = {
    universe:          DATA_BASE + 'account_universe_v1.json',
    estGmv:            DATA_BASE + 'est_gmv_v2.json',
    crosswalk:         DATA_BASE + 'identity_crosswalk_final.json',
    sellDomain:        DATA_BASE + 'sell_domain_v2.json',
    buyDomain:         DATA_BASE + 'buy_domain_v2.json',
    feesDomain:        DATA_BASE + 'fees_domain_v2.json',
    buyers:            DATA_BASE + 'buyers_evidence_v2.json',
    vendors:           DATA_BASE + 'vendors_evidence_v2.json',
    temporal:          DATA_BASE + 'temporal_evidence_v2.json',
    inventory:         DATA_BASE + 'inventory_current_v1.json',
    benchmarks:        DATA_BASE + 'benchmarks_v2.json',
    config:            DATA_BASE + 'config_evidence_v2.json',
    hardgoods:         DATA_BASE + 'hardgoods_v2.json',
    skusOnlineOffline: DATA_BASE + 'skus_online_offline.json',
  };

  /* ─────────────────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Fetch a JSON file. Returns null on any error (network, parse, 404).
   */
  function _fetchJson(url) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) { console.warn('[EvidenceAdapter] 404:', url); return null; }
        return r.json();
      })
      .catch(function (e) {
        console.warn('[EvidenceAdapter] fetch error:', url, e);
        return null;
      });
  }

  /** Normalize company_id to string */
  function _sid(id) {
    return id == null ? null : String(id);
  }

  /** Safe numeric get — returns null if absent/NaN */
  function _num(val) {
    var n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  /**
   * Pick the most recent month key from a monthly dict { 'YYYY-MM': ... }.
   * offset=0 → current, offset=1 → prior, etc.
   */
  function _latestMonthKey(monthlyDict, offset) {
    if (!monthlyDict || typeof monthlyDict !== 'object') return null;
    var keys = Object.keys(monthlyDict).sort();
    var idx = keys.length - 1 - (offset || 0);
    return idx >= 0 ? keys[idx] : null;
  }

  /**
   * Pick the most recent month from a monthly list [{ month: 'YYYY-MM', ... }].
   * offset=0 → current, offset=1 → prior
   */
  function _latestMonthItem(monthlyList, offset) {
    if (!Array.isArray(monthlyList) || !monthlyList.length) return null;
    var sorted = monthlyList.slice().sort(function (a, b) {
      return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
    });
    var idx = sorted.length - 1 - (offset || 0);
    return idx >= 0 ? sorted[idx] : null;
  }

  /**
   * Compute a simple delta object { value, pct, direction }
   * direction: 'up' | 'down' | 'flat'
   */
  function _delta(current, prior) {
    if (current == null || prior == null || prior === 0) return null;
    var diff = current - prior;
    var pct  = (diff / prior) * 100;
    return {
      value: diff,
      pct:   pct,
      direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    };
  }

  /**
   * Evidence tag helper — wraps a value with its evidence state
   */
  function _ev(value, state, note) {
    return { value: value, ev: state || 'gap', note: note || null };
  }

  /**
   * Build a period selector object for sell/buy monthly data.
   * Returns { current, prior } month values for the chosen timeframe.
   */
  function _selectPeriod(monthlyData, timeframe, isList) {
    if (!monthlyData) return { current: null, prior: null };
    var isListType = isList === true;

    var currentItem, priorItem;

    if (timeframe === 'prior_month') {
      currentItem = isListType ? _latestMonthItem(monthlyData, 1) : null;
      priorItem   = isListType ? _latestMonthItem(monthlyData, 2) : null;
      if (!isListType) {
        var k0 = _latestMonthKey(monthlyData, 1);
        var k1 = _latestMonthKey(monthlyData, 2);
        currentItem = k0 ? monthlyData[k0] : null;
        priorItem   = k1 ? monthlyData[k1] : null;
      }
    } else {
      // default: current_month or ytd
      if (isListType) {
        currentItem = _latestMonthItem(monthlyData, 0);
        priorItem   = _latestMonthItem(monthlyData, 1);
      } else {
        var ck = _latestMonthKey(monthlyData, 0);
        var pk = _latestMonthKey(monthlyData, 1);
        currentItem = ck ? monthlyData[ck] : null;
        priorItem   = pk ? monthlyData[pk] : null;
      }
    }

    return { current: currentItem, prior: priorItem };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LOAD ALL FILES
  ───────────────────────────────────────────────────────────────────────── */

  // Training/sandbox/demo accounts to exclude from the dashboard
  var EXCLUDED_IDS = {
    '561353': true, // Arizona Family Florist - Training Account
    '549016': true, // Brightland Farms - Sandbox
    '6316':   true, // Demo & Flowers
    '554582': true, // Fresca Farms - Sandbox Account
    '531246': true, // Implementations Sandbox
    '531265': true, // KBC Cooler - Training
    '55326':  true, // Kennicott Brothers Company - Training Site
    '751276': true, // Kennicott Brothers West - Training Site
    '132431': true, // Mayesh Wholesale - Training Site
    '468006': true, // Rosaprima Sandbox
    '398804': true, // [Sandbox] - Vimass
    '806094': true, // eSuite Wholesaler Koronet Demo
  };

  function _buildLookups() {
    // id ↔ name from account_universe (master)
    if (Array.isArray(_state.universe)) {
      _state.universe.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (!id) return;
        // Skip training/sandbox/demo accounts
        if (EXCLUDED_IDS[id]) return;
        _state.idToName[id]    = rec.company_name;
        _state.idToUniverse[id] = rec;
        if (rec.company_name) {
          _state.nameToId[rec.company_name] = id;
        }
      });
    }

    // Supplement name→id from crosswalk (covers accounts not in universe)
    if (Array.isArray(_state.crosswalk)) {
      _state.crosswalk.forEach(function (rec) {
        var id   = _sid(rec.company_id);
        var name = rec.company_name;
        if (id && name && !_state.nameToId[name]) {
          _state.nameToId[name] = id;
        }
        if (id && name && !_state.idToName[id]) {
          _state.idToName[id] = name;
        }
      });
    }

    // vendors list → dict by name
    if (Array.isArray(_state.vendors)) {
      _state.vendors.forEach(function (rec) {
        if (rec.company_name) {
          _state.vendorsByName[rec.company_name] = rec;
        }
      });
    }

    // hardgoods list → dict by name
    if (Array.isArray(_state.hardgoods)) {
      _state.hardgoods.forEach(function (rec) {
        if (rec.company_name) {
          _state.hardgoodsByName[rec.company_name] = rec;
        }
      });
    }

    // temporal: group sell_anticipation by company_name
    var tempSA = (_state.temporal && _state.temporal.sell_anticipation && _state.temporal.sell_anticipation.data) || [];
    tempSA.forEach(function (row) {
      var n = row.company_name;
      if (!n) return;
      if (!_state.temporalSellAnticipation[n]) _state.temporalSellAnticipation[n] = [];
      _state.temporalSellAnticipation[n].push(row);
    });

    // temporal: group variety_freshness by company_name
    var tempVF = (_state.temporal && _state.temporal.variety_freshness && _state.temporal.variety_freshness.data) || [];
    tempVF.forEach(function (row) {
      var n = row.company_name;
      if (!n) return;
      if (!_state.temporalVarietyFreshness[n]) _state.temporalVarietyFreshness[n] = [];
      _state.temporalVarietyFreshness[n].push(row);
    });

    // temporal: group forward_inventory_depth by company_name
    var tempFI = (_state.temporal && _state.temporal.forward_inventory_depth && _state.temporal.forward_inventory_depth.data) || [];
    tempFI.forEach(function (row) {
      var n = row.company_name;
      if (!n) return;
      if (!_state.temporalForwardInventory[n]) _state.temporalForwardInventory[n] = [];
      _state.temporalForwardInventory[n].push(row);
    });
  }

  function _loadAll() {
    if (_state.loadPromise) return _state.loadPromise;

    var promises = Object.keys(FILES).map(function (key) {
      return _fetchJson(FILES[key]).then(function (data) {
        return { key: key, data: data };
      });
    });

    _state.loadPromise = Promise.all(promises).then(function (results) {
      results.forEach(function (r) {
        if (!r.data) return; // file failed to load — leave as default empty

        switch (r.key) {
          case 'universe':
            _state.universe = Array.isArray(r.data) ? r.data : [];
            break;
          case 'estGmv':
            _state.estGmv = (r.data && r.data.accounts) ? r.data.accounts : {};
            break;
          case 'crosswalk':
            _state.crosswalk = (r.data && Array.isArray(r.data.records)) ? r.data.records : [];
            break;
          case 'sellDomain':
            _state.sellDomain = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'buyDomain':
            _state.buyDomain = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'feesDomain':
            _state.feesDomain = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'buyers':
            _state.buyers = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'vendors':
            _state.vendors = (r.data && Array.isArray(r.data.companies)) ? r.data.companies : [];
            break;
          case 'temporal':
            _state.temporal = r.data || {};
            break;
          case 'inventory':
            _state.inventory = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'benchmarks':
            _state.benchmarks = (r.data && r.data.benchmarks) ? r.data.benchmarks : {};
            break;
          case 'config':
            _state.config = (r.data && r.data.companies) ? r.data.companies : {};
            break;
          case 'hardgoods':
            _state.hardgoods = (r.data && Array.isArray(r.data.companies)) ? r.data.companies : [];
            break;
          case 'skusOnlineOffline':
            _state.skusOnlineOffline = (r.data && r.data.companies) ? r.data.companies : {};
            break;
        }
      });

      _buildLookups();
      _state.loaded = true;
    });

    return _state.loadPromise;
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SECTION BUILDERS
  ───────────────────────────────────────────────────────────────────────── */

  /** IDENTITY — from account_universe + crosswalk */
  function _buildIdentity(companyId) {
    var id   = _sid(companyId);
    var urec = _state.idToUniverse[id] || null;
    if (!urec) return null;

    var xrec = null;
    if (Array.isArray(_state.crosswalk)) {
      for (var i = 0; i < _state.crosswalk.length; i++) {
        if (_sid(_state.crosswalk[i].company_id) === id) { xrec = _state.crosswalk[i]; break; }
      }
    }

    return {
      company_id:   id,
      company_name: urec.company_name,
      ct_id:        urec.ct_id        || null,
      sfdc_id:      urec.sfdc_id      || (xrec && xrec.sfdc_id) || null,
      sfdc_type:    urec.sfdc_type    || (xrec && xrec.sfdc_type) || null,
      priority_level: urec.priority_level || null,
      status:       urec.status       || null,
      industry:     urec.industry     || null,
      komet_status: urec.komet_status || null,
      system_type:  urec.system_type  || null,
      impl_stage:   urec.impl_stage   || null,
      impl_type:    urec.impl_type    || null,
      has_2026_sell: urec.has_2026_sell || false,
      has_2026_buy:  urec.has_2026_buy  || false,
      // from crosswalk
      ga4_hostname:   xrec ? xrec.ga4_hostname   : null,
      has_login_cvr:  xrec ? xrec.has_login_cvr  : null,
      has_ga4_cvr:    xrec ? xrec.has_ga4_cvr    : null,
      sfdc_confidence: xrec ? xrec.sfdc_confidence : null,
    };
  }

  /** POTENTIAL — est_gmv + sell/buy/fees summary */
  function _buildPotential(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var gmvRec   = _state.estGmv[id]                || null;
    var sellRec  = name ? _state.sellDomain[name]   : null;
    var buyRec   = name ? _state.buyDomain[name]    : null;
    var feesRec  = name ? _state.feesDomain[name]   : null;

    // ── Estimated GMV
    var estSell = gmvRec ? _num(gmvRec.est_sell_gmv) : null;
    var estBuy  = gmvRec ? _num(gmvRec.est_buy_gmv)  : null;

    // ── Koronet actuals — prefer YTD 2026, fallback to monthly series
    var koronetSellYtd = gmvRec ? _num(gmvRec.koronet_sell_ytd) : (sellRec ? _num(sellRec.ytd_2026) : null);
    var koronetBuyYtd  = gmvRec ? _num(gmvRec.koronet_buy_ytd)  : (buyRec  ? _num(buyRec.ytd_2026)  : null);

    // ── Online % — from sell/buy YTD monthly current
    var sellOnlinePct = null;
    var buyOnlinePct  = null;

    if (sellRec && Array.isArray(sellRec.monthly) && sellRec.monthly.length) {
      var sellPeriod = _selectPeriod(sellRec.monthly, timeframe, true);
      if (timeframe === 'ytd' || timeframe === 'current_month' || !timeframe) {
        // Use YTD aggregate
        var sellTotal   = _num(sellRec.ytd_2026);
        var sellOnline  = null;
        // sum online from monthly
        if (Array.isArray(sellRec.monthly)) {
          var sumOnline = 0, sumTotal = 0;
          sellRec.monthly.forEach(function (m) {
            if (m.month && m.month >= '2026-01') {
              sumOnline += (_num(m.sell_online) || 0);
              sumTotal  += (_num(m.sell_total)  || 0);
            }
          });
          sellOnlinePct = sumTotal > 0 ? (sumOnline / sumTotal) * 100 : null;
        }
      } else if (sellPeriod.current) {
        sellOnlinePct = _num(sellPeriod.current.online_pct);
      }
    }

    if (buyRec && typeof buyRec.monthly === 'object' && !Array.isArray(buyRec.monthly)) {
      var buyMonthly = buyRec.monthly;
      if (timeframe === 'ytd' || !timeframe || timeframe === 'current_month') {
        var sumBuyOnline = 0, sumBuyTotal = 0;
        Object.keys(buyMonthly).forEach(function (k) {
          if (k >= '2026-01') {
            var m = buyMonthly[k];
            sumBuyOnline += (_num(m.buy_online) || 0);
            sumBuyTotal  += (_num(m.buy_total)  || 0);
          }
        });
        buyOnlinePct = sumBuyTotal > 0 ? (sumBuyOnline / sumBuyTotal) * 100 : null;
      } else {
        var bk = _latestMonthKey(buyMonthly, timeframe === 'prior_month' ? 1 : 0);
        if (bk && buyMonthly[bk]) buyOnlinePct = _num(buyMonthly[bk].online_pct);
      }
    }

    // ── Penetration (annualized to make monthly / YTD comparable to annual est)
    // CRITICAL: koronetSellYtd is ALWAYS YTD (Jan-Jul), never a single month.
    // For current_month/prior_month, we need the MONTHLY value from sell_domain, not YTD.
    var sellPenetration = null;
    var buyPenetration  = null;
    if (estSell && estSell > 0) {
      var koronetSellForPen = koronetSellYtd; // default = YTD
      var annualizer = 12 / 7; // YTD through month 7

      if (timeframe === 'current_month' || timeframe === 'prior_month') {
        // Use monthly value from sell_domain, not YTD
        var monthIdx = timeframe === 'current_month' ? 0 : 1;
        if (sellRec && Array.isArray(sellRec.monthly) && sellRec.monthly.length > monthIdx) {
          var monthKeys = Object.keys(sellRec.monthly[0] || {}).filter(function(k){ return k.match(/^\d{4}-\d{2}$/); });
          // Sort descending to get latest first
          var sorted = sellRec.monthly.slice().sort(function(a,b){ return Object.keys(b)[0] > Object.keys(a)[0] ? 1 : -1; });
          var sp = _selectPeriod(sellRec.monthly, timeframe, true);
          if (sp && sp.current && sp.current.sell_total != null) {
            koronetSellForPen = _num(sp.current.sell_total);
            annualizer = 12; // single month × 12
          }
        }
      }

      if (koronetSellForPen && koronetSellForPen > 0) {
        sellPenetration = (koronetSellForPen * annualizer / estSell) * 100;
      }
    }
    if (estBuy && koronetBuyYtd && estBuy > 0) {
      var buyAnnualizer = 12 / 7; // YTD
      var koronetBuyForPen = koronetBuyYtd;
      if (timeframe === 'current_month' || timeframe === 'prior_month') {
        if (buyRec && Array.isArray(buyRec.monthly)) {
          var bp = _selectPeriod(buyRec.monthly, timeframe, true);
          if (bp && bp.current && bp.current.buy_total != null) {
            koronetBuyForPen = _num(bp.current.buy_total);
            buyAnnualizer = 12;
          }
        }
      }
      buyPenetration = (koronetBuyForPen * buyAnnualizer / estBuy) * 100;
    }

    // Source tracking for penetration honesty
    var sellEstSource = gmvRec ? gmvRec.sell_source : null;
    var buyEstSource  = gmvRec ? gmvRec.buy_source  : null;

    // ── Fees
    var feesTotal    = feesRec ? _num(feesRec.total_12m)  : null;
    var feesYtd2026  = feesRec ? _num(feesRec.ytd_2026)   : null;
    var feesYtd2025  = feesRec ? _num(feesRec.ytd_2025)   : null;
    var feesYoyPct   = feesRec ? _num(feesRec.yoy_pct)    : null;
    var feesYoyDelta = feesRec ? _num(feesRec.yoy_delta)  : null;
    var feesMomDelta = feesRec ? _num(feesRec.mom_delta)  : null;
    var feesByChannel = feesRec ? feesRec.ytd_2026_by_channel : null;

    // ── Take rate = fees_ytd / koronet_sell_ytd
    var takeRate = null;
    if (feesYtd2026 && koronetSellYtd && koronetSellYtd > 0) {
      takeRate = (feesYtd2026 / koronetSellYtd) * 100;
    }

    // ── YoY sell delta
    var sellYtd2025 = sellRec ? _num(sellRec.ytd_2025) : null;
    var sellYoyDelta = (koronetSellYtd && sellYtd2025) ? _delta(koronetSellYtd, sellYtd2025) : null;

    // ── Offline amounts
    var sellOfflineYtd = null;
    if (sellRec && Array.isArray(sellRec.monthly)) {
      var offSum = 0;
      sellRec.monthly.forEach(function (m) {
        if (m.month >= '2026-01') offSum += (_num(m.sell_offline) || 0);
      });
      sellOfflineYtd = offSum > 0 ? offSum : null;
    }

    var buyOfflineYtd = null;
    if (buyRec && typeof buyRec.monthly === 'object' && !Array.isArray(buyRec.monthly)) {
      var offBuySum = 0;
      Object.keys(buyRec.monthly).forEach(function (k) {
        if (k >= '2026-01') offBuySum += (_num(buyRec.monthly[k].buy_offline) || 0);
      });
      buyOfflineYtd = offBuySum > 0 ? offBuySum : null;
    }

    return {
      // Estimated total market
      est_sell:        _ev(estSell,  gmvRec ? gmvRec.sell_source === 'koronet_actual_annualized' ? 'observed' : 'proxy' : 'gap', gmvRec ? gmvRec.sell_source : null),
      est_buy:         _ev(estBuy,   gmvRec ? gmvRec.buy_source  === 'koronet_actual_annualized' ? 'observed' : 'proxy' : 'gap', gmvRec ? gmvRec.buy_source  : null),
      sell_confidence: gmvRec ? gmvRec.sell_confidence : null,
      buy_confidence:  gmvRec ? gmvRec.buy_confidence  : null,
      is_core:         gmvRec ? gmvRec.is_core : null,

      // Koronet actuals
      koronet_sell_ytd: _ev(koronetSellYtd, koronetSellYtd ? 'observed' : 'gap', 'Snowflake YTD 2026'),
      koronet_buy_ytd:  _ev(koronetBuyYtd,  koronetBuyYtd  ? 'observed' : 'gap', 'Snowflake YTD 2026'),
      sell_ytd_2025:    _ev(sellYtd2025, sellYtd2025 ? 'observed' : 'gap', null),
      buy_ytd_2025:     _ev(buyRec ? _num(buyRec.ytd_2025) : null, buyRec && buyRec.ytd_2025 ? 'observed' : 'gap', null),

      // Offline amounts
      sell_offline_ytd: _ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap', null),
      buy_offline_ytd:  _ev(buyOfflineYtd,  buyOfflineYtd  ? 'observed' : 'gap', null),

      // Penetration — evidence state depends on est_gmv source
      // 'tautological' = koronet_actual_annualized (est IS koronet, so pen ≈ 100% by definition)
      // 'model' = ora/sfdc/christine (external estimate, penetration is meaningful)
      // 'gap' = no estimate available
      sell_penetration: _ev(
        sellPenetration,
        sellEstSource === 'koronet_actual_annualized' ? 'tautological'
          : (estSell && koronetSellYtd) ? 'model' : 'gap',
        sellEstSource || 'koronet_ytd / est_total'
      ),
      buy_penetration: _ev(
        buyPenetration,
        buyEstSource === 'koronet_actual_annualized' ? 'tautological'
          : buyEstSource === 'estimated_54pct' ? 'tautological'
          : (estBuy && koronetBuyYtd) ? 'model' : 'gap',
        buyEstSource || 'koronet_ytd / est_total'
      ),

      // Online %
      sell_online_pct: _ev(sellOnlinePct, sellOnlinePct != null ? 'observed' : 'gap', 'Snowflake sell domain'),
      buy_online_pct:  _ev(buyOnlinePct,  buyOnlinePct  != null ? 'observed' : 'gap', 'Snowflake buy domain'),

      // Fees
      fees_total_12m:    _ev(feesTotal,   feesTotal   ? 'observed' : 'gap', 'Snowflake L12M'),
      fees_ytd_2026:     _ev(feesYtd2026, feesYtd2026 ? 'observed' : 'gap', 'Snowflake YTD 2026'),
      fees_ytd_2025:     _ev(feesYtd2025, feesYtd2025 ? 'observed' : 'gap', null),
      fees_yoy_pct:      _ev(feesYoyPct,  feesYoyPct  != null ? 'model' : 'gap', null),
      fees_yoy_delta:    _ev(feesYoyDelta, feesYoyDelta != null ? 'model' : 'gap', null),
      fees_mom_delta:    _ev(feesMomDelta, feesMomDelta != null ? 'observed' : 'gap', null),
      fees_by_channel:   _ev(feesByChannel, feesByChannel ? 'observed' : 'gap', 'ecom + k2k + api'),

      // Take rate
      take_rate:  _ev(takeRate, (feesYtd2026 && koronetSellYtd) ? 'model' : 'gap', 'fees_ytd / koronet_sell_ytd'),

      // Sell YoY delta
      sell_yoy_delta: sellYoyDelta,
    };
  }

  /** OPPORTUNITIES — placeholder until opportunity engine exists */
  function _buildOpportunities(companyId) {
    // Opportunities are computed from buy, list, sell signals.
    // This stub returns an empty array — the opportunity engine
    // (e.g. a separate opportunity_engine.js) should populate this
    // by calling getAccountEvidence and computing plays.
    // Each entry shape: { type, text, arr, effort, action, prerequisite }
    return [];
  }

  /** BUY DOMAIN — vendor lifecycle, k2k, categories, leakage, anticipation */
  function _buildBuy(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var buyRec  = name ? _state.buyDomain[name]          : null;
    var vendRec = name ? _state.vendorsByName[name]       : null;
    var saRows  = name ? (_state.temporalSellAnticipation[name] || null) : null;
    var skusRec = name ? (_state.skusOnlineOffline[name] || null) : null;

    // ── Monthly sourcing table (buy domain)
    var sourcingTable = null;
    if (buyRec && buyRec.monthly) {
      sourcingTable = {
        ytd_2026:      _num(buyRec.ytd_2026),
        ytd_2025:      _num(buyRec.ytd_2025),
        yoy_delta:     buyRec.yoy_delta     || null,
        yoy_delta_online: buyRec.yoy_delta_online || null,
        mom_delta:     buyRec.mom_delta     || null,
        monthly:       buyRec.monthly,     // full dict keyed by YYYY-MM
        ev:            'observed',
      };
      // Add current/prior month convenience fields
      var bk0 = _latestMonthKey(buyRec.monthly, timeframe === 'prior_month' ? 1 : 0);
      var bk1 = _latestMonthKey(buyRec.monthly, timeframe === 'prior_month' ? 2 : 1);
      sourcingTable.current_month = bk0 ? buyRec.monthly[bk0] : null;
      sourcingTable.current_month_key = bk0;
      sourcingTable.prior_month   = bk1 ? buyRec.monthly[bk1] : null;
      sourcingTable.prior_month_key = bk1;
    }

    // ── K2K lifecycle + vendor lifecycle from vendors_evidence
    var k2kLifecycle  = null;
    var vendorLifecycle = null;
    var categoriesTop20 = null;
    var leakage       = null;

    if (vendRec) {
      k2kLifecycle    = vendRec.k2k_connections  || null;
      vendorLifecycle = vendRec.vendor_lifecycle  || null;
      categoriesTop20 = vendRec.categories_top20  || null;
      leakage         = vendRec.vendor_leakage    || null;
    }

    // ── Anticipation (sell-side ordering horizon, both channels)
    var anticipation = null;
    if (saRows && saRows.length) {
      var onlineRows  = saRows.filter(function (r) { return r.channel_type === 'online'; });
      var offlineRows = saRows.filter(function (r) { return r.channel_type === 'offline'; });

      function _summarizeBuckets(rows) {
        var total = 0;
        rows.forEach(function (r) { total += (r.total_orders || 0); });
        var buckets = {};
        rows.forEach(function (r) { buckets[r.bucket] = { orders: r.total_orders, gmv: r.total_gmv, avg_days: r.avg_days }; });
        // Weighted avg days
        var weightedDays = 0, totalOrders = 0;
        rows.forEach(function (r) {
          weightedDays += (r.avg_days || 0) * (r.total_orders || 0);
          totalOrders  += (r.total_orders || 0);
        });
        return {
          buckets: buckets,
          total_orders: totalOrders,
          avg_days: totalOrders > 0 ? weightedDays / totalOrders : null,
        };
      }

      anticipation = {
        online:  onlineRows.length  ? _summarizeBuckets(onlineRows)  : null,
        offline: offlineRows.length ? _summarizeBuckets(offlineRows) : null,
        ev:      'observed',
      };
    }

    return {
      sourcing_table:         sourcingTable  ? _ev(sourcingTable, 'observed', 'Snowflake buy domain')  : null,
      k2k_lifecycle:          k2kLifecycle   ? _ev(k2kLifecycle, 'observed', 'vendors_evidence_v2')    : null,
      vendor_lifecycle:       vendorLifecycle ? _ev(vendorLifecycle, 'observed', 'vendors_evidence_v2') : null,
      anticipation_online:    anticipation && anticipation.online  ? _ev(anticipation.online, 'observed', 'temporal sell_anticipation') : null,
      anticipation_offline:   anticipation && anticipation.offline ? _ev(anticipation.offline, 'observed', 'temporal sell_anticipation') : null,
      categories_top20:       categoriesTop20 ? _ev(categoriesTop20, 'observed', 'vendors_evidence_v2') : null,
      leakage:                leakage         ? _ev(leakage, 'observed', 'vendors_evidence_v2')         : null,
      skus_online_offline:    skusRec         ? _ev(skusRec, 'observed', 'skus_online_offline')         : null,
    };
  }

  /** LIST DOMAIN — inventory, variety freshness, TAM lost, config */
  function _buildList(companyId) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var invRec  = _state.inventory[id]                           || null;
    var cfgRec  = _state.config[id]                              || null;
    var vfRows  = name ? (_state.temporalVarietyFreshness[name] || null) : null;
    var fiRows  = name ? (_state.temporalForwardInventory[name] || null) : null;

    // ── Inventory (current published)
    var inventoryCurrent = null;
    if (invRec) {
      inventoryCurrent = {
        by_type:     invRec.by_inventory_type     || null,
        by_division: invRec.by_inventory_division || null,
        totals:      invRec.totals                || null,
        ev:          'observed',
      };
    }

    // ── Variety freshness (online vs offline)
    var varietyFreshness = null;
    if (vfRows && vfRows.length) {
      var onlineVF  = vfRows.filter(function (r) { return r.channel_type === 'online';  });
      var offlineVF = vfRows.filter(function (r) { return r.channel_type === 'offline'; });

      function _groupFreshness(rows) {
        var buckets = {};
        var totalVar = 0;
        rows.forEach(function (r) {
          buckets[r.freshness_bucket] = { variety_count: r.variety_count, avg_days: r.avg_days_since };
          totalVar += (r.variety_count || 0);
        });
        return { buckets: buckets, total_varieties: totalVar };
      }

      varietyFreshness = {
        online:  onlineVF.length  ? _groupFreshness(onlineVF)  : null,
        offline: offlineVF.length ? _groupFreshness(offlineVF) : null,
        ev:      'observed',
      };
    }

    // ── Forward inventory depth
    var forwardInventory = null;
    if (fiRows && fiRows.length) {
      var fiByBucket = {};
      fiRows.forEach(function (r) {
        fiByBucket[r.horizon_bucket] = {
          prebook_lines:    r.prebook_lines,
          total_value:      r.total_value,
          distinct_vendors: r.distinct_vendors,
          distinct_products: r.distinct_products,
        };
      });
      forwardInventory = { by_bucket: fiByBucket, ev: 'observed' };
    }

    // ── TAM lost — computed from variety/inventory gap
    // tam_lost is directional: gap_items / total_offline_items * offline_sell_gmv
    // We expose the components; the card renders the formula
    var tamLost = null;
    // variety gap comes from sell_domain not inventory — computed in SELL section
    // Expose what we have; card computes display

    // ── Config
    var config = null;
    if (cfgRec) {
      config = {
        raw:                cfgRec.config              || null,
        bunches_reality:    cfgRec.bunches_reality      || null,
        sfdc:               cfgRec.sfdc                 || null,
        company_name:       cfgRec.company_name         || null,
        company_industry:   cfgRec.company_industry     || null,
        ev:                 'observed',
      };
    }

    return {
      inventory_current:  inventoryCurrent ? _ev(inventoryCurrent, 'observed', 'inventory_current_v1') : null,
      variety_freshness:  varietyFreshness ? _ev(varietyFreshness, 'observed', 'temporal variety_freshness') : null,
      forward_inventory:  forwardInventory ? _ev(forwardInventory, 'observed', 'temporal forward_inventory_depth') : null,
      tam_lost:           null,  // directional — computed by card from sell + list signals
      config:             config ? _ev(config, 'observed', 'config_evidence_v2') : null,
    };
  }

  /** SELL DOMAIN — buyers, CVR, repeat rate, concentration, hardgoods, retention */
  function _buildSell(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var sellRec  = name ? _state.sellDomain[name]       : null;
    var buyRec   = name ? (_state.buyers[name] || null) : null;  // buyers_evidence
    var hgRec    = name ? _state.hardgoodsByName[name]  : null;

    // ── Monthly sell series
    var monthlySeries = null;
    var currentMonth = null;
    var priorMonth   = null;

    if (sellRec && Array.isArray(sellRec.monthly)) {
      var sp = _selectPeriod(sellRec.monthly, timeframe, true);
      monthlySeries = sellRec.monthly;
      currentMonth  = sp.current;
      priorMonth    = sp.prior;
    }

    // ── Buyers table
    var buyersTable = null;
    if (buyRec && buyRec.buyers) {
      var bd = buyRec.buyers;
      buyersTable = {
        online_buyers:   _num(bd.online_buyers),
        offline_buyers:  _num(bd.offline_buyers),
        total_buyers:    _num(bd.total_buyers),
        l30d_online:     _num(bd.l30d_online),
        l30d_offline:    _num(bd.l30d_offline),
        aov_online:      _num(bd.aov_online)   || null,
        aov_offline:     _num(bd.aov_offline)  || null,
        new_month:       _num(bd.new_month)    || null,
        churned:         _num(bd.churned)      || null,
        ev:              'observed',
      };
    }

    // ── CVR
    var cvr         = buyRec ? buyRec.login_cvr    : null;
    var newUserCvr  = buyRec ? buyRec.new_user_cvr : null;

    // ── Repeat rate
    var repeatRate = buyRec ? buyRec.repeat_rate : null;

    // ── Concentration
    var concentration = buyRec ? buyRec.concentration : null;

    // ── Hardgoods
    var hardgoods = null;
    if (hgRec) {
      hardgoods = {
        hardgoods_total:       _num(hgRec.hardgoods_total),
        hardgoods_online:      _num(hgRec.hardgoods_online),
        hardgoods_offline:     _num(hgRec.hardgoods_offline),
        hardgoods_online_pct:  _num(hgRec.hardgoods_online_pct),
        plants_total:          _num(hgRec.plants_total),
        plants_online:         _num(hgRec.plants_online),
        plants_offline:        _num(hgRec.plants_offline),
        plants_online_pct:     _num(hgRec.plants_online_pct),
        ct_id:                 hgRec.ct_id || null,
        ev:                    'observed',
      };
    }

    // ── Sell monthly — online vs offline split for current period
    var sellOnlineYtd   = null;
    var sellOfflineYtd  = null;
    var sellTotalYtd    = null;

    if (sellRec && Array.isArray(sellRec.monthly)) {
      var on = 0, off = 0, tot = 0;
      sellRec.monthly.forEach(function (m) {
        if (m.month >= '2026-01') {
          on  += (_num(m.sell_online)  || 0);
          off += (_num(m.sell_offline) || 0);
          tot += (_num(m.sell_total)   || 0);
        }
      });
      sellOnlineYtd  = on  > 0 ? on  : null;
      sellOfflineYtd = off > 0 ? off : null;
      sellTotalYtd   = tot > 0 ? tot : null;
    }

    return {
      buyers_table:    buyersTable    ? _ev(buyersTable,   'observed', 'buyers_evidence_v2') : null,
      cvr:             cvr            ? _ev(cvr,           'observed', 'buyers_evidence_v2') : null,
      new_user_cvr:    newUserCvr     ? _ev(newUserCvr,    'observed', 'buyers_evidence_v2') : null,
      repeat_rate:     repeatRate     ? _ev(repeatRate,    'observed', 'buyers_evidence_v2') : null,
      concentration:   concentration  ? _ev(concentration, 'observed', 'buyers_evidence_v2') : null,
      hardgoods:       hardgoods      ? _ev(hardgoods,     'observed', 'hardgoods_v2')       : null,
      sell_online_ytd:  _ev(sellOnlineYtd,  sellOnlineYtd  ? 'observed' : 'gap', null),
      sell_offline_ytd: _ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap', null),
      sell_total_ytd:   _ev(sellTotalYtd,   sellTotalYtd   ? 'observed' : 'gap', null),
      monthly_series:  monthlySeries  ? _ev(monthlySeries, 'observed', 'sell_domain_v2')     : null,
      current_month:   currentMonth   || null,
      prior_month:     priorMonth     || null,
    };
  }

  /** BENCHMARKS — network + segment benchmarks for this account's ct_id */
  function _buildBenchmarks(companyId) {
    var id   = _sid(companyId);
    var urec = _state.idToUniverse[id];
    var ctId = urec ? (urec.ct_id || '') : '';

    var bmarks = _state.benchmarks;
    if (!bmarks || !Object.keys(bmarks).length) return null;

    var result = { segment: ctId, per_metric: {} };

    Object.keys(bmarks).forEach(function (key) {
      var bm      = bmarks[key];
      var network = bm.network   || null;
      var segData = (bm.by_segment && ctId && bm.by_segment[ctId]) ? bm.by_segment[ctId] : null;

      result.per_metric[key] = {
        description: bm.description || null,
        network: network,
        segment: segData,
        // convenience flattening
        median:       network ? network.median     : null,
        p75:          network ? network.p75        : null,
        p90:          network ? network.p90        : null,
        best_account: network ? network.best_account : null,
        best_value:   network ? network.best_value : null,
        seg_median:   segData ? segData.median     : null,
        seg_p75:      segData ? segData.p75        : null,
        seg_p90:      segData ? segData.p90        : null,
      };
    });

    return result;
  }

  /** FRESHNESS — which sources were found and when they were generated */
  function _buildFreshness(companyId) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var sources = [];

    function _checkSource(label, found, asOf) {
      sources.push({ source: label, found: !!found, as_of: asOf || null });
    }

    _checkSource('account_universe',   !!_state.idToUniverse[id],                    null);
    _checkSource('est_gmv',            !!_state.estGmv[id],                           (_state.estGmv._metadata && _state.estGmv._metadata.as_of_sell) || null);
    _checkSource('identity_crosswalk', name ? !!_state.nameToId[name] : false,         null);
    _checkSource('sell_domain',        name ? !!_state.sellDomain[name] : false,        null);
    _checkSource('buy_domain',         name ? !!_state.buyDomain[name] : false,         null);
    _checkSource('fees_domain',        name ? !!_state.feesDomain[name] : false,        null);
    _checkSource('buyers_evidence',    name ? !!_state.buyers[name] : false,            null);
    _checkSource('vendors_evidence',   name ? !!_state.vendorsByName[name] : false,     null);
    _checkSource('temporal',           name ? !!((_state.temporalSellAnticipation[name] && _state.temporalSellAnticipation[name].length)) : false, null);
    _checkSource('inventory_current',  !!_state.inventory[id],                         null);
    _checkSource('benchmarks',         !!Object.keys(_state.benchmarks).length,         null);
    _checkSource('config_evidence',    !!_state.config[id],                             null);
    _checkSource('hardgoods',          name ? !!_state.hardgoodsByName[name] : false,   null);

    var foundCount = sources.filter(function (s) { return s.found; }).length;

    return {
      as_of:         new Date().toISOString().slice(0, 10),
      sources_used:  foundCount,
      sources_total: sources.length,
      coverage_pct:  Math.round((foundCount / sources.length) * 100),
      sources:       sources,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * Initialize — call once on page load. Returns a Promise.
   * The mockup can await this before rendering.
   */
  function init() {
    return _loadAll();
  }

  /**
   * getAccountEvidence(companyId, timeframe)
   *
   * Returns ONE object with all evidence for this account, shaped to
   * match the TX Dashboard card requirements.
   *
   * @param  {string|number} companyId  — CT company_id (primary key)
   * @param  {string}        timeframe  — 'current_month' | 'prior_month' | 'ytd' | 'l12m'
   * @returns {Object|null}
   */
  function getAccountEvidence(companyId, timeframe) {
    if (!_state.loaded) {
      console.warn('[EvidenceAdapter] Data not loaded yet. Call EvidenceAdapter.init() first.');
      return null;
    }

    var id = _sid(companyId);
    if (!id) return null;

    var tf = timeframe || 'ytd';

    // Identity is the guard — if we can't find the account at all, return null
    var identity = _buildIdentity(id);
    if (!identity) return null;

    var potential    = null;
    var buy          = null;
    var list         = null;
    var sell         = null;
    var benchmarks   = null;
    var opportunities = null;
    var freshness    = null;

    try { potential     = _buildPotential(id, tf); }    catch (e) { console.error('[EvidenceAdapter] potential error', id, e); }
    try { buy           = _buildBuy(id, tf); }          catch (e) { console.error('[EvidenceAdapter] buy error', id, e); }
    try { list          = _buildList(id); }              catch (e) { console.error('[EvidenceAdapter] list error', id, e); }
    try { sell          = _buildSell(id, tf); }          catch (e) { console.error('[EvidenceAdapter] sell error', id, e); }
    try { benchmarks    = _buildBenchmarks(id); }        catch (e) { console.error('[EvidenceAdapter] benchmarks error', id, e); }
    try { opportunities = _buildOpportunities(id); }     catch (e) { console.error('[EvidenceAdapter] opportunities error', id, e); }
    try { freshness     = _buildFreshness(id); }         catch (e) { console.error('[EvidenceAdapter] freshness error', id, e); }

    return {
      identity:     identity,
      potential:    potential,
      opportunities: opportunities,
      buy:          buy,
      list:         list,
      sell:         sell,
      benchmarks:   benchmarks,
      freshness:    freshness,
      // convenience
      _timeframe:   tf,
      _company_id:  id,
      _company_name: identity.company_name,
    };
  }

  /**
   * getAccountByName(companyName, timeframe)
   * Convenience wrapper — looks up company_id from name then calls getAccountEvidence.
   */
  function getAccountByName(companyName, timeframe) {
    if (!_state.loaded) {
      console.warn('[EvidenceAdapter] Data not loaded yet.');
      return null;
    }
    var id = _state.nameToId[companyName];
    if (!id) {
      console.warn('[EvidenceAdapter] No company_id found for name:', companyName);
      return null;
    }
    return getAccountEvidence(id, timeframe);
  }

  /**
   * getAllAccountIds()
   * Returns sorted array of all company_ids present in account_universe.
   */
  function getAllAccountIds() {
    return Object.keys(_state.idToUniverse).sort();
  }

  /**
   * getLoadedState()
   * Debug helper — exposes raw lookup map sizes.
   */
  function getLoadedState() {
    return {
      loaded:              _state.loaded,
      universe_count:      _state.universe.length,
      est_gmv_count:       Object.keys(_state.estGmv).length,
      crosswalk_count:     _state.crosswalk.length,
      sell_domain_count:   Object.keys(_state.sellDomain).length,
      buy_domain_count:    Object.keys(_state.buyDomain).length,
      fees_domain_count:   Object.keys(_state.feesDomain).length,
      buyers_count:        Object.keys(_state.buyers).length,
      vendors_count:       _state.vendors.length,
      inventory_count:     Object.keys(_state.inventory).length,
      benchmarks_count:    Object.keys(_state.benchmarks).length,
      config_count:        Object.keys(_state.config).length,
      hardgoods_count:     _state.hardgoods.length,
      name_to_id_count:    Object.keys(_state.nameToId).length,
      id_to_name_count:    Object.keys(_state.idToName).length,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EXPORT
  ───────────────────────────────────────────────────────────────────────── */

  var EvidenceAdapter = {
    init:               init,
    getAccountEvidence: getAccountEvidence,
    getAccountByName:   getAccountByName,
    getAllAccountIds:    getAllAccountIds,
    getLoadedState:     getLoadedState,
  };

  // Support both browser global and CommonJS/Node environments
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EvidenceAdapter;
  } else {
    root.EvidenceAdapter = EvidenceAdapter;
  }

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
