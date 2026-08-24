/**
 * evidence_adapter_v3.js — TX Dashboard V3 Evidence Adapter
 * Koronet Revenue OS · Chapter TX
 *
 * V3 upgrade: loads accounts_v3.json (430 accounts with classification),
 * sell/buy/fees monthly cubes, GMV pacing, and external GMV estimates,
 * ON TOP of the V2 evidence files (buyers, vendors, temporal, inventory,
 * benchmarks, config, hardgoods, skus_online_offline).
 *
 * API (same as V2):
 *   init()                              → Promise
 *   getAccountEvidence(companyId, tf)    → Object | null
 *   getAccountByName(companyName, tf)    → Object | null
 *   getAllAccountIds()                   → string[]
 *   getLoadedState()                     → Object
 *
 * Keying: company_id (string) is the primary key.
 * V2 evidence files keyed by company_name use the name→id lookup.
 *
 * Timeframe tokens: 'ytd' | 'current_month' | 'prior_month' | 'l12m'
 *
 * Evidence states: 'observed' | 'proxy' | 'model' | 'gap'
 *
 * Graceful fallback: any missing file or field returns null, never crash.
 */

(function (root) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────────────── */
  var _state = {
    loaded: false,
    loadPromise: null,

    // ── V3 new data ──
    accountsV3: [],           // accounts_v3.json .accounts (list)
    sellCube: [],             // sell_monthly.json .data (list)
    buyCube: [],              // buy_monthly.json .data (list)
    feesCube: [],             // fees_monthly.json .data (list)
    gmvPacing: [],            // gmv_pacing.json .pacing (list)
    gmvExternal: [],          // gmv_estimates_external.json .estimates (list)

    // ── V2 legacy data ──
    buyers: {},               // buyers_evidence_v2.json .companies (name → obj)
    vendors: [],              // vendors_evidence_v2.json .companies (list)
    temporal: {},             // temporal_evidence_v2.json (raw)
    inventory: {},            // inventory_current_v1.json .companies (id → obj)
    benchmarks: {},           // benchmarks_v2.json .benchmarks
    config: {},               // config_evidence_v2.json .companies (id → obj)
    hardgoods: [],            // hardgoods_v2.json .companies (list)
    skusOnlineOffline: {},    // skus_online_offline.json .companies (name → obj)

    // ── Derived lookup maps ──
    accountById: {},          // company_id → accounts_v3 record
    idToName: {},             // company_id → company_name
    nameToId: {},             // company_name → company_id
    sellCubeById: {},         // company_id → [ rows ]
    buyCubeById: {},          // company_id → [ rows ]
    feesCubeById: {},         // company_id → [ rows ]
    pacingById: {},           // company_id → pacing record
    externalById: {},         // company_id → external estimate record
    vendorsByName: {},        // company_name → vendor record
    hardgoodsByName: {},      // company_name → hardgoods record
    temporalSellAnticipation: {},
    temporalVarietyFreshness: {},
    temporalForwardInventory: {},
  };

  /* ─────────────────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────────────── */
  var DATA_BASE = 'data/';

  var FILES = {
    // V3 new files
    accountsV3:     DATA_BASE + 'accounts_v3.json',
    sellCube:       DATA_BASE + 'current/sell_monthly.json',
    buyCube:        DATA_BASE + 'current/buy_monthly.json',
    feesCube:       DATA_BASE + 'current/fees_monthly.json',
    gmvPacing:      DATA_BASE + 'gmv_pacing.json',
    gmvExternal:    DATA_BASE + 'gmv_estimates_external.json',
    // V2 legacy files
    buyers:            DATA_BASE + 'buyers_evidence_v2.json',
    vendors:           DATA_BASE + 'vendors_evidence_v2.json',
    temporal:          DATA_BASE + 'temporal_evidence_v2.json',
    inventory:         DATA_BASE + 'inventory_current_v1.json',
    benchmarks:        DATA_BASE + 'benchmarks_v2.json',
    config:            DATA_BASE + 'config_evidence_v2.json',
    hardgoods:         DATA_BASE + 'hardgoods_v2.json',
    skusOnlineOffline: DATA_BASE + 'skus_online_offline.json',
  };

  // Training/sandbox/demo accounts to exclude
  var EXCLUDED_IDS = {
    '561353': true, '549016': true, '6316': true,   '554582': true,
    '531246': true, '531265': true, '55326': true,  '751276': true,
    '132431': true, '468006': true, '398804': true, '806094': true,
  };

  /* ─────────────────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  function _fetchJson(url) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) { console.warn('[EvidenceAdapterV3] 404:', url); return null; }
        return r.json();
      })
      .catch(function (e) {
        console.warn('[EvidenceAdapterV3] fetch error:', url, e);
        return null;
      });
  }

  function _sid(id) {
    return id == null ? null : String(id);
  }

  function _num(val) {
    if (val == null) return null;
    var n = parseFloat(val);
    return isNaN(n) ? null : n;
  }

  function _ev(value, state, note) {
    return { value: value, ev: state || 'gap', note: note || null };
  }

  function _delta(current, prior) {
    if (current == null || prior == null || prior === 0) return null;
    var diff = current - prior;
    var pct  = (diff / prior) * 100;
    return {
      value: diff,
      pct: pct,
      direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    };
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

  function _selectPeriod(monthlyData, timeframe, isList) {
    if (!monthlyData) return { current: null, prior: null };
    var currentItem, priorItem;

    if (timeframe === 'prior_month') {
      if (isList) {
        currentItem = _latestMonthItem(monthlyData, 1);
        priorItem   = _latestMonthItem(monthlyData, 2);
      } else {
        var k0 = _latestMonthKey(monthlyData, 1);
        var k1 = _latestMonthKey(monthlyData, 2);
        currentItem = k0 ? monthlyData[k0] : null;
        priorItem   = k1 ? monthlyData[k1] : null;
      }
    } else {
      if (isList) {
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
     CUBE AGGREGATION HELPERS
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * From a list of cube rows for one company, aggregate by timeframe.
   * Sell cube rows: { month, channel, sell_gmv }
   * Returns { total, online, offline, months: [sorted unique months] }
   */
  function _aggregateSellCube(rows, timeframe) {
    if (!rows || !rows.length) return null;

    var filtered = _filterByTimeframe(rows, timeframe);
    if (!filtered.length) return null;

    var total = 0, online = 0, offline = 0;
    filtered.forEach(function (r) {
      var v = _num(r.sell_gmv) || 0;
      total += v;
      if (r.channel === 'Online') online += v;
      else offline += v;
    });

    var months = _uniqueMonths(filtered);
    return { total: total, online: online, offline: offline, months: months };
  }

  /**
   * From a list of buy cube rows for one company, aggregate by timeframe.
   * Buy cube rows: { month, buy_gmv, buy_online, buy_offline }
   */
  function _aggregateBuyCube(rows, timeframe) {
    if (!rows || !rows.length) return null;

    var filtered = _filterByTimeframe(rows, timeframe);
    if (!filtered.length) return null;

    var total = 0, online = 0, offline = 0;
    filtered.forEach(function (r) {
      total   += _num(r.buy_gmv) || 0;
      online  += _num(r.buy_online) || 0;
      offline += _num(r.buy_offline) || 0;
    });

    var months = _uniqueMonths(filtered);
    return { total: total, online: online, offline: offline, months: months };
  }

  /**
   * From a list of fees cube rows for one company, aggregate.
   * Fees cube rows: { company_id, period, fee_channel, fee_amount }
   * Note: fees cube is YTD-only (no monthly grain), so timeframe filtering is limited.
   */
  function _aggregateFeesCube(rows) {
    if (!rows || !rows.length) return null;

    var total = 0;
    var byChannel = { ecom: 0, k2k: 0, api: 0, indirect: 0 };
    rows.forEach(function (r) {
      var v = _num(r.fee_amount) || 0;
      total += v;
      var ch = (r.fee_channel || '').toLowerCase();
      if (ch === 'ecom') byChannel.ecom += v;
      else if (ch === 'k2k') byChannel.k2k += v;
      else if (ch === 'api') byChannel.api += v;
      else byChannel.indirect += v;
    });

    return { total: total, byChannel: byChannel };
  }

  /**
   * Filter cube rows by timeframe.
   * Each row has a .month field ('YYYY-MM').
   */
  function _filterByTimeframe(rows, timeframe) {
    if (!rows || !rows.length) return [];

    // Get all unique months sorted
    var allMonths = _uniqueMonths(rows);

    if (timeframe === 'ytd' || !timeframe) {
      // Sum all months in 2026 (Jan-Jul)
      return rows.filter(function (r) {
        return r.month && r.month >= '2026-01' && r.month <= '2026-12';
      });
    }

    if (timeframe === 'current_month') {
      var latest = allMonths[allMonths.length - 1];
      return latest ? rows.filter(function (r) { return r.month === latest; }) : [];
    }

    if (timeframe === 'prior_month') {
      var prior = allMonths.length >= 2 ? allMonths[allMonths.length - 2] : null;
      return prior ? rows.filter(function (r) { return r.month === prior; }) : [];
    }

    if (timeframe === 'l12m') {
      // All rows (the cubes already contain 12 months of data)
      return rows;
    }

    // Default to ytd
    return rows.filter(function (r) {
      return r.month && r.month >= '2026-01';
    });
  }

  function _uniqueMonths(rows) {
    var monthSet = {};
    rows.forEach(function (r) { if (r.month) monthSet[r.month] = true; });
    return Object.keys(monthSet).sort();
  }

  /**
   * Get monthly totals for sell cube rows (both channels summed per month).
   * Returns sorted array of { month, sell_gmv, sell_online, sell_offline }
   */
  function _sellMonthlyTotals(rows) {
    if (!rows || !rows.length) return [];
    var byMonth = {};
    rows.forEach(function (r) {
      var m = r.month;
      if (!m) return;
      if (!byMonth[m]) byMonth[m] = { month: m, sell_gmv: 0, sell_online: 0, sell_offline: 0 };
      var v = _num(r.sell_gmv) || 0;
      byMonth[m].sell_gmv += v;
      if (r.channel === 'Online') byMonth[m].sell_online += v;
      else byMonth[m].sell_offline += v;
    });
    return Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
  }

  /**
   * Get monthly totals for buy cube rows.
   * Returns sorted array of { month, buy_gmv, buy_online, buy_offline }
   */
  function _buyMonthlyTotals(rows) {
    if (!rows || !rows.length) return [];
    var byMonth = {};
    rows.forEach(function (r) {
      var m = r.month;
      if (!m) return;
      if (!byMonth[m]) byMonth[m] = { month: m, buy_gmv: 0, buy_online: 0, buy_offline: 0 };
      byMonth[m].buy_gmv    += _num(r.buy_gmv) || 0;
      byMonth[m].buy_online += _num(r.buy_online) || 0;
      byMonth[m].buy_offline += _num(r.buy_offline) || 0;
    });
    return Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     LOAD ALL FILES
  ───────────────────────────────────────────────────────────────────────── */

  function _buildLookups() {
    // accounts_v3 → accountById, idToName, nameToId
    if (Array.isArray(_state.accountsV3)) {
      _state.accountsV3.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (!id || EXCLUDED_IDS[id]) return;
        _state.accountById[id] = rec;
        _state.idToName[id] = rec.company_name;
        if (rec.company_name) {
          _state.nameToId[rec.company_name] = id;
        }
      });
    }

    // sell cube → sellCubeById
    if (Array.isArray(_state.sellCube)) {
      _state.sellCube.forEach(function (row) {
        var id = _sid(row.company_id);
        if (!id) return;
        if (!_state.sellCubeById[id]) _state.sellCubeById[id] = [];
        _state.sellCubeById[id].push(row);
      });
    }

    // buy cube → buyCubeById
    if (Array.isArray(_state.buyCube)) {
      _state.buyCube.forEach(function (row) {
        var id = _sid(row.company_id);
        if (!id) return;
        if (!_state.buyCubeById[id]) _state.buyCubeById[id] = [];
        _state.buyCubeById[id].push(row);
      });
    }

    // fees cube → feesCubeById
    if (Array.isArray(_state.feesCube)) {
      _state.feesCube.forEach(function (row) {
        var id = _sid(row.company_id);
        if (!id) return;
        if (!_state.feesCubeById[id]) _state.feesCubeById[id] = [];
        _state.feesCubeById[id].push(row);
      });
    }

    // gmv pacing → pacingById
    if (Array.isArray(_state.gmvPacing)) {
      _state.gmvPacing.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (id) _state.pacingById[id] = rec;
      });
    }

    // gmv external → externalById
    if (Array.isArray(_state.gmvExternal)) {
      _state.gmvExternal.forEach(function (rec) {
        var id = _sid(rec.company_id);
        if (id) _state.externalById[id] = rec;
      });
    }

    // vendors list → dict by name
    if (Array.isArray(_state.vendors)) {
      _state.vendors.forEach(function (rec) {
        if (rec.company_name) _state.vendorsByName[rec.company_name] = rec;
      });
    }

    // hardgoods list → dict by name
    if (Array.isArray(_state.hardgoods)) {
      _state.hardgoods.forEach(function (rec) {
        if (rec.company_name) _state.hardgoodsByName[rec.company_name] = rec;
      });
    }

    // temporal: sell_anticipation by company_name
    var tempSA = (_state.temporal && _state.temporal.sell_anticipation && _state.temporal.sell_anticipation.data) || [];
    tempSA.forEach(function (row) {
      var n = row.company_name;
      if (!n) return;
      if (!_state.temporalSellAnticipation[n]) _state.temporalSellAnticipation[n] = [];
      _state.temporalSellAnticipation[n].push(row);
    });

    // temporal: variety_freshness by company_name
    var tempVF = (_state.temporal && _state.temporal.variety_freshness && _state.temporal.variety_freshness.data) || [];
    tempVF.forEach(function (row) {
      var n = row.company_name;
      if (!n) return;
      if (!_state.temporalVarietyFreshness[n]) _state.temporalVarietyFreshness[n] = [];
      _state.temporalVarietyFreshness[n].push(row);
    });

    // temporal: forward_inventory_depth by company_name
    var tempFI = (_state.temporal && _state.temporal.forward_inventory_depth && _state.temporal.forward_inventory_depth.data) || [];
    tempFI.forEach(function (row) {
      var n = row.company_name;
      if (!n) return;
      if (!_state.temporalForwardInventory[n]) _state.temporalForwardInventory[n] = [];
      _state.temporalForwardInventory[n].push(row);
    });

    // Supplement name→id from V2 evidence files (buyers, vendors) for accounts
    // not in accounts_v3 but present in V2 data
    if (_state.buyers && typeof _state.buyers === 'object') {
      Object.keys(_state.buyers).forEach(function (name) {
        if (!_state.nameToId[name]) {
          // Try to find id from sell cube or buy cube data
          // Not critical — V2 compat only
        }
      });
    }
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
        if (!r.data) return;

        switch (r.key) {
          // V3 new files
          case 'accountsV3':
            _state.accountsV3 = (r.data && Array.isArray(r.data.accounts)) ? r.data.accounts : [];
            break;
          case 'sellCube':
            _state.sellCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'buyCube':
            _state.buyCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'feesCube':
            _state.feesCube = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
            break;
          case 'gmvPacing':
            _state.gmvPacing = (r.data && Array.isArray(r.data.pacing)) ? r.data.pacing : [];
            break;
          case 'gmvExternal':
            _state.gmvExternal = (r.data && Array.isArray(r.data.estimates)) ? r.data.estimates : [];
            break;

          // V2 legacy files
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

  /** IDENTITY — from accounts_v3 (primary) */
  function _buildIdentity(companyId) {
    var id  = _sid(companyId);
    var rec = _state.accountById[id];
    if (!rec) return null;

    return {
      company_id:       id,
      company_name:     rec.company_name || null,
      account_class:    rec.account_class || null,
      business_type:    rec.business_type || null,
      product_tier:     rec.product_tier || null,
      sell_channel:     rec.sell_channel || null,
      potential_tier:   rec.potential_tier || null,
      impl_stage_display: rec.impl_stage_display || null,
      digital_pct_caveat: rec.digital_pct_caveat || null,
      has_active_pmt:   rec.has_active_pmt || false,
      pmt_lead:         rec.pmt_lead || null,
      pmt_status:       rec.pmt_status || null,
      pmt_health:       rec.pmt_health || null,
      priority_level:   rec.priority_level || null,
      engagement_status: rec.engagement_status || null,
      komet_status:     rec.komet_status || null,
      industry:         rec.industry || null,
      sfdc_id:          rec.sfdc_id || null,
      impl_stage:       rec.impl_stage || null,
      impl_type:        rec.impl_type || null,
      ct_id:            rec.ct_id || null,
      sfdc_type:        rec.sfdc_type || null,
      digital_pct:      _num(rec.digital_pct),
      has_eshop:        rec.has_eshop || false,
      has_procurement:  rec.has_procurement || false,
      in_christine_sheet: rec.in_christine_sheet || false,
      // V2 compat — not in accounts_v3 yet
      city:             null,
      location:         null,
      am_name:          null,
      account_manager:  null,
      status:           null,
    };
  }

  /** POTENTIAL — GMV + sell/buy/fees from cubes + pacing + external estimates */
  function _buildPotential(companyId, timeframe) {
    var id   = _sid(companyId);
    var acct = _state.accountById[id] || {};
    var name = _state.idToName[id];

    // ── GMV reference (from accounts_v3 — Christine cascade)
    var gmvRef      = _num(acct.gmv_reference);
    var gmvSource   = acct.gmv_source || null;
    var gmvIsFloor  = acct.gmv_is_floor || false;
    var buyGmvEst   = _num(acct.buy_gmv_estimated);

    // GMV confidence: derive from source
    var gmvConfidence = null;
    if (gmvSource === 'Medido') gmvConfidence = 'Alta';
    else if (gmvSource === 'Piso de red') gmvConfidence = 'Alta';
    else if (gmvSource === 'ORA' || gmvSource === 'FCS') gmvConfidence = 'Baja';
    else if (gmvSource === 'not in Christine cascade' || gmvSource === 'Sin dato') gmvConfidence = null;

    // ── Pacing
    var paceRec  = _state.pacingById[id] || null;
    var gmvPace  = null;
    if (paceRec) {
      gmvPace = {
        value: _num(paceRec.annual_pace),
        daily_rate: _num(paceRec.daily_rate),
        confidence: paceRec.confidence || null,
      };
    }

    // ── External estimate
    var extRec = _state.externalById[id] || null;
    var gmvExternal = null;
    if (extRec) {
      gmvExternal = {
        value: _num(extRec.estimated_gmv_mid),
        methods: extRec.methods_used || [],
        confidence: extRec.confidence || null,
      };
    }

    // ── GMV ORA (from pacing record if source is ORA)
    var gmvOra = null;
    if (gmvSource === 'ORA' && gmvRef) {
      gmvOra = { value: gmvRef };
    }

    // ── Sell cube aggregation
    var sellRows  = _state.sellCubeById[id] || [];
    var sellAgg   = _aggregateSellCube(sellRows, timeframe);
    var sellAggYtd = _aggregateSellCube(sellRows, 'ytd');

    // ── Sell YTD 2025 (from cube — sum months 2025-01 to 2025-07)
    var sell2025Rows = sellRows.filter(function (r) {
      return r.month && r.month >= '2025-01' && r.month <= '2025-07';
    });
    var sellYtd2025 = null;
    if (sell2025Rows.length) {
      sellYtd2025 = 0;
      sell2025Rows.forEach(function (r) { sellYtd2025 += _num(r.sell_gmv) || 0; });
    }

    // ── Buy cube aggregation
    var buyRows  = _state.buyCubeById[id] || [];
    var buyAgg   = _aggregateBuyCube(buyRows, timeframe);
    var buyAggYtd = _aggregateBuyCube(buyRows, 'ytd');

    // ── Buy YTD 2025
    var buy2025Rows = buyRows.filter(function (r) {
      return r.month && r.month >= '2025-01' && r.month <= '2025-07';
    });
    var buyYtd2025 = null;
    if (buy2025Rows.length) {
      buyYtd2025 = 0;
      buy2025Rows.forEach(function (r) { buyYtd2025 += _num(r.buy_gmv) || 0; });
    }

    // ── Fees cube aggregation
    var feesRows = _state.feesCubeById[id] || [];
    var feesAgg  = _aggregateFeesCube(feesRows);
    var feesYtd2026 = feesAgg ? feesAgg.total : null;
    var feesByChannel = feesAgg ? feesAgg.byChannel : null;

    // ── Fees YTD 2025 — not in fees cube (cube is 2026 only)
    // Will be null unless we load it from V2 fees_domain
    var feesYtd2025 = null;

    // Offline amounts
    var sellOfflineYtd = sellAggYtd ? (sellAggYtd.offline > 0 ? sellAggYtd.offline : null) : null;
    var buyOfflineYtd  = buyAggYtd  ? (buyAggYtd.offline  > 0 ? buyAggYtd.offline  : null) : null;

    // ── Koronet YTD totals
    var koronetSellYtd = sellAggYtd ? sellAggYtd.total : null;
    var koronetBuyYtd  = buyAggYtd  ? buyAggYtd.total  : null;

    // ── Online amounts (for online % calculation below)
    var onlineSellYtd = sellAggYtd ? sellAggYtd.online : 0;
    var onlineBuyYtd  = buyAggYtd  ? buyAggYtd.online  : 0;

    // ── Penetration + Piso logic
    // Rule: Est GMV can never be less than what we already measure.
    // If annualized Koronet sell > gmv_reference → the estimate was wrong.
    // Upgrade to "Piso de red" (network floor = measured minimum).
    var sellPenetration = null;
    var sellPenEv = 'gap';
    var sellPenNote = null;
    var buyPenetration = null;
    var buyPenEv = 'gap';
    var buyPenNote = null;

    // Rule D: No GMV reference but has Koronet activity → auto Piso de red
    var ytdMonthsSell = sellAggYtd ? sellAggYtd.months.length : 0;
    if ((!gmvRef || gmvRef <= 0 || gmvSource === 'not in Christine cascade' || gmvSource === 'Sin dato')
        && koronetSellYtd && koronetSellYtd > 0 && ytdMonthsSell > 0) {
      gmvRef = koronetSellYtd * (12 / ytdMonthsSell);
      gmvSource = 'Piso de red';
      gmvConfidence = 'Alta';
      gmvIsFloor = true;
      buyGmvEst = gmvRef * 0.45;
    }

    if (gmvRef && gmvRef > 0 && gmvSource !== 'not in Christine cascade' && gmvSource !== 'Sin dato') {
      var isTautological = /^(Medido|Piso)/.test(gmvSource || '');

      var ytdMonths = sellAggYtd ? sellAggYtd.months.length : 0;
      if (koronetSellYtd && koronetSellYtd > 0 && ytdMonths > 0) {
        var annualizedSell = koronetSellYtd * (12 / ytdMonths);

        if (isTautological) {
          // Medido/Piso: reference IS Koronet → tautological
          sellPenetration = 100;
          sellPenEv = 'tautological';
        } else if (annualizedSell > gmvRef) {
          // Estimado is wrong — Koronet already exceeds it. Upgrade to Piso.
          gmvRef = annualizedSell;
          gmvSource = 'Piso de red';
          gmvConfidence = 'Alta';
          gmvIsFloor = true;
          buyGmvEst = gmvRef * 0.45;
          sellPenetration = 100;
          sellPenEv = 'tautological';
        } else {
          // Real external estimate > Koronet → meaningful penetration
          sellPenetration = (annualizedSell / gmvRef) * 100;
          sellPenEv = gmvConfidence === 'Alta' ? 'model' : 'proxy';
        }
        sellPenNote = gmvSource;
      }

      // Buy penetration — same piso logic
      if (buyGmvEst && buyGmvEst > 0 && koronetBuyYtd && koronetBuyYtd > 0) {
        var buyYtdMonths = buyAggYtd ? buyAggYtd.months.length : 0;
        if (buyYtdMonths > 0) {
          var annualizedBuy = koronetBuyYtd * (12 / buyYtdMonths);

          if (isTautological || sellPenEv === 'tautological') {
            buyPenetration = 100;
            buyPenEv = 'tautological';
          } else if (annualizedBuy > buyGmvEst) {
            // Buy estimate wrong — upgrade
            buyGmvEst = annualizedBuy;
            buyPenetration = 100;
            buyPenEv = 'tautological';
          } else {
            buyPenetration = (annualizedBuy / buyGmvEst) * 100;
            buyPenEv = gmvConfidence === 'Alta' ? 'model' : 'proxy';
          }
          buyPenNote = gmvSource;
        }
      }
    }

    // ── Online % = ALWAYS annualized online / Est GMV
    // "What fraction of their TOTAL business is digital through us"
    // Same denominator as penetration → online% ≤ penetration always
    var sellMonthCount = sellAggYtd ? sellAggYtd.months.length : 0;
    var buyMonthCount  = buyAggYtd  ? buyAggYtd.months.length  : 0;

    var sellOnlinePct = null;
    if (koronetSellYtd && koronetSellYtd > 0 && gmvRef && gmvRef > 0) {
      if (onlineSellYtd > 0 && sellMonthCount > 0) {
        var annOnlineSell = onlineSellYtd * (12 / sellMonthCount);
        sellOnlinePct = (annOnlineSell / gmvRef) * 100;
      } else {
        sellOnlinePct = 0;  // has sell but no online → 0%, not null
      }
    }
    var buyOnlinePct = null;
    if (koronetBuyYtd && koronetBuyYtd > 0 && buyGmvEst && buyGmvEst > 0) {
      if (onlineBuyYtd > 0 && buyMonthCount > 0) {
        var annOnlineBuy = onlineBuyYtd * (12 / buyMonthCount);
        buyOnlinePct = (annOnlineBuy / buyGmvEst) * 100;
      } else {
        buyOnlinePct = 0;
      }
    }

    // Logical constraint: online ⊂ total → online% ≤ penetration%
    // Small overages are period/rounding artifacts, not real
    if (sellOnlinePct != null && sellPenetration != null && sellOnlinePct > sellPenetration) {
      sellOnlinePct = sellPenetration;
    }
    if (buyOnlinePct != null && buyPenetration != null && buyOnlinePct > buyPenetration) {
      buyOnlinePct = buyPenetration;
    }

    // ── Take rate = fees_ytd / koronet_sell_ytd
    // Only meaningful with sufficient sell volume (> $10K YTD)
    var takeRate = null;
    if (feesYtd2026 && koronetSellYtd && koronetSellYtd > 10000) {
      takeRate = (feesYtd2026 / koronetSellYtd) * 100;
    }

    // ── YoY sell delta (YTD 2026 vs YTD 2025)
    var sellYoyDelta = (koronetSellYtd && sellYtd2025) ? _delta(koronetSellYtd, sellYtd2025) : null;

    // ── Fees YoY
    var feesYoyPct = null;
    // feesYtd2025 not available from cube — will stay null

    // ── MoM deltas (from cubes)
    var sellMomDelta = _computeMomDelta(_sellMonthlyTotals(sellRows), 'sell_gmv');
    var buyMomDelta  = _computeMomDelta(_buyMonthlyTotals(buyRows), 'buy_gmv');
    // Fees MoM — cube is YTD only, no monthly grain
    var feesMomDelta = null;

    // ── Days observed (from pacing)
    var daysObserved = paceRec ? _num(paceRec.days_observed) : null;

    return {
      // GMV reference
      gmv_reference: {
        value: gmvRef,
        source: gmvSource,
        is_floor: gmvIsFloor,
        confidence: gmvConfidence,
        days_observed: daysObserved,
      },
      gmv_pace:     gmvPace,
      gmv_external: gmvExternal,
      gmv_ora:      gmvOra,
      buy_gmv_estimated: { value: buyGmvEst },

      // Koronet actuals from cubes
      koronet_sell_ytd: _ev(koronetSellYtd, koronetSellYtd ? 'observed' : 'gap', 'sell cube'),
      koronet_buy_ytd:  _ev(koronetBuyYtd,  koronetBuyYtd  ? 'observed' : 'gap', 'buy cube'),
      sell_ytd_2025:    _ev(sellYtd2025, sellYtd2025 ? 'observed' : 'gap', null),
      buy_ytd_2025:     _ev(buyYtd2025,  buyYtd2025  ? 'observed' : 'gap', null),

      // Online %
      sell_online_pct: _ev(sellOnlinePct, sellOnlinePct != null ? 'observed' : 'gap', null),
      buy_online_pct:  _ev(buyOnlinePct,  buyOnlinePct  != null ? 'observed' : 'gap', null),
      sell_offline_ytd: _ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap', null),
      buy_offline_ytd:  _ev(buyOfflineYtd,  buyOfflineYtd  ? 'observed' : 'gap', null),

      // Penetration — HONEST
      sell_penetration: _ev(sellPenetration, sellPenEv, sellPenNote),
      buy_penetration:  _ev(buyPenetration,  buyPenEv,  buyPenNote),

      // Fees from cube
      fees_ytd_2026:  _ev(feesYtd2026, feesYtd2026 ? 'observed' : 'gap', 'fees cube'),
      fees_ytd_2025:  _ev(feesYtd2025, feesYtd2025 ? 'observed' : 'gap', null),
      fees_by_channel: { value: feesByChannel },
      fees_yoy_pct:   _ev(feesYoyPct, feesYoyPct != null ? 'observed' : 'gap', null),
      take_rate:      _ev(takeRate, (feesYtd2026 && koronetSellYtd) ? 'model' : 'gap', null),

      // Sell trend
      sell_yoy_delta: sellYoyDelta,

      // MoM deltas
      sell_mom_delta: sellMomDelta,
      buy_mom_delta:  buyMomDelta,
      fees_mom_delta: feesMomDelta,
    };
  }

  /**
   * Compute MoM delta from a sorted monthly totals array.
   * monthlyTotals: [{ month, sell_gmv/buy_gmv, ... }]
   * valueKey: 'sell_gmv' or 'buy_gmv'
   */
  function _computeMomDelta(monthlyTotals, valueKey) {
    if (!monthlyTotals || monthlyTotals.length < 2) return null;

    var currentMonth = monthlyTotals[monthlyTotals.length - 1];
    var priorMonth   = monthlyTotals[monthlyTotals.length - 2];

    var currVal = _num(currentMonth[valueKey]) || 0;
    var priorVal = _num(priorMonth[valueKey]) || 0;

    if (priorVal === 0) return null;

    return {
      pct: ((currVal - priorVal) / priorVal) * 100,
      absolute: currVal - priorVal,
      current_month: currentMonth.month,
      prior_month: priorMonth.month,
    };
  }

  /** BUY DOMAIN — V2 legacy (vendor lifecycle, k2k, categories, leakage, anticipation) */
  function _buildBuy(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var vendRec = name ? (_state.vendorsByName[name] || null) : null;
    var saRows  = name ? (_state.temporalSellAnticipation[name] || null) : null;
    var skusRec = name ? (_state.skusOnlineOffline[name] || null) : null;

    // ── Monthly sourcing from buy cube
    var buyRows = _state.buyCubeById[id] || [];
    var buyMonthlyTotals = _buyMonthlyTotals(buyRows);
    var buyAggYtd = _aggregateBuyCube(buyRows, 'ytd');
    var buy2025Rows = buyRows.filter(function (r) {
      return r.month && r.month >= '2025-01' && r.month <= '2025-07';
    });
    var buyYtd2025 = null;
    if (buy2025Rows.length) {
      buyYtd2025 = 0;
      buy2025Rows.forEach(function (r) { buyYtd2025 += _num(r.buy_gmv) || 0; });
    }

    var sourcingTable = null;
    if (buyMonthlyTotals.length) {
      var byMonthDict = {};
      buyMonthlyTotals.forEach(function (m) { byMonthDict[m.month] = m; });

      var sp = _selectPeriod(byMonthDict, timeframe, false);

      sourcingTable = {
        ytd_2026: buyAggYtd ? buyAggYtd.total : null,
        ytd_2025: buyYtd2025,
        yoy_delta: (buyAggYtd && buyYtd2025) ? _delta(buyAggYtd.total, buyYtd2025) : null,
        monthly: byMonthDict,
        current_month: sp.current || null,
        current_month_key: sp.current ? sp.current.month : null,
        prior_month: sp.prior || null,
        prior_month_key: sp.prior ? sp.prior.month : null,
        ev: 'observed',
      };
    }

    // ── K2K lifecycle + vendor lifecycle from vendors_evidence
    var k2kLifecycle    = null;
    var vendorLifecycle = null;
    var categoriesTop20 = null;
    var leakage         = null;

    if (vendRec) {
      k2kLifecycle    = vendRec.k2k_connections  || null;
      vendorLifecycle = vendRec.vendor_lifecycle  || null;
      categoriesTop20 = vendRec.categories_top20  || null;
      leakage         = vendRec.vendor_leakage    || null;
    }

    // ── Anticipation
    var anticipation = null;
    if (saRows && saRows.length) {
      var onlineRows  = saRows.filter(function (r) { return r.channel_type === 'online'; });
      var offlineRows = saRows.filter(function (r) { return r.channel_type === 'offline'; });

      function _summarizeBuckets(rows) {
        var buckets = {};
        var totalOrders = 0;
        var weightedDays = 0;
        rows.forEach(function (r) {
          buckets[r.bucket] = { orders: r.total_orders, gmv: r.total_gmv, avg_days: r.avg_days };
          totalOrders += (r.total_orders || 0);
          weightedDays += (r.avg_days || 0) * (r.total_orders || 0);
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
        ev: 'observed',
      };
    }

    return {
      sourcing_table:       sourcingTable ? _ev(sourcingTable, 'observed', 'buy cube + vendors_evidence_v2') : null,
      k2k_lifecycle:        k2kLifecycle  ? _ev(k2kLifecycle, 'observed', 'vendors_evidence_v2')  : null,
      vendor_lifecycle:     vendorLifecycle ? _ev(vendorLifecycle, 'observed', 'vendors_evidence_v2') : null,
      anticipation_online:  anticipation && anticipation.online  ? _ev(anticipation.online, 'observed', 'temporal sell_anticipation') : null,
      anticipation_offline: anticipation && anticipation.offline ? _ev(anticipation.offline, 'observed', 'temporal sell_anticipation') : null,
      categories_top20:     categoriesTop20 ? _ev(categoriesTop20, 'observed', 'vendors_evidence_v2') : null,
      leakage:              leakage ? _ev(leakage, 'observed', 'vendors_evidence_v2') : null,
      skus_online_offline:  skusRec ? _ev(skusRec, 'observed', 'skus_online_offline') : null,
    };
  }

  /** LIST DOMAIN — inventory, variety freshness, config (from V2) */
  function _buildList(companyId) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var invRec = _state.inventory[id] || null;
    var cfgRec = _state.config[id]    || null;
    var vfRows = name ? (_state.temporalVarietyFreshness[name] || null) : null;
    var fiRows = name ? (_state.temporalForwardInventory[name] || null) : null;

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

    // ── Variety freshness
    var varietyFreshness = null;
    if (vfRows && vfRows.length) {
      var onlineVF  = vfRows.filter(function (r) { return r.channel_type === 'online'; });
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

    // ── Config
    var config = null;
    if (cfgRec) {
      config = {
        raw:              cfgRec.config            || null,
        bunches_reality:  cfgRec.bunches_reality    || null,
        sfdc:             cfgRec.sfdc               || null,
        company_name:     cfgRec.company_name       || null,
        company_industry: cfgRec.company_industry   || null,
        ev:               'observed',
      };
    }

    return {
      inventory_current: inventoryCurrent ? _ev(inventoryCurrent, 'observed', 'inventory_current_v1') : null,
      variety_freshness: varietyFreshness  ? _ev(varietyFreshness, 'observed', 'temporal variety_freshness') : null,
      forward_inventory: forwardInventory ? _ev(forwardInventory, 'observed', 'temporal forward_inventory_depth') : null,
      tam_lost:          null,
      config:            config ? _ev(config, 'observed', 'config_evidence_v2') : null,
    };
  }

  /** SELL DOMAIN — buyers, CVR, repeat rate, concentration, hardgoods (from V2) + sell cube */
  function _buildSell(companyId, timeframe) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var buyRec = name ? (_state.buyers[name] || null) : null;
    var hgRec  = name ? (_state.hardgoodsByName[name] || null) : null;

    // ── Monthly sell series from cube
    var sellRows = _state.sellCubeById[id] || [];
    var monthlyTotals = _sellMonthlyTotals(sellRows);

    var currentMonth = monthlyTotals.length ? monthlyTotals[monthlyTotals.length - 1] : null;
    var priorMonth   = monthlyTotals.length >= 2 ? monthlyTotals[monthlyTotals.length - 2] : null;

    if (timeframe === 'prior_month') {
      currentMonth = monthlyTotals.length >= 2 ? monthlyTotals[monthlyTotals.length - 2] : null;
      priorMonth   = monthlyTotals.length >= 3 ? monthlyTotals[monthlyTotals.length - 3] : null;
    }

    // ── Buyers table
    var buyersTable = null;
    if (buyRec && buyRec.buyers) {
      var bd = buyRec.buyers;
      buyersTable = {
        online_buyers:  _num(bd.online_buyers),
        offline_buyers: _num(bd.offline_buyers),
        total_buyers:   _num(bd.total_buyers),
        l30d_online:    _num(bd.l30d_online),
        l30d_offline:   _num(bd.l30d_offline),
        aov_online:     _num(bd.aov_online) || null,
        aov_offline:    _num(bd.aov_offline) || null,
        new_month:      _num(bd.new_month) || null,
        churned:        _num(bd.churned) || null,
        ev:             'observed',
      };
    }

    // ── CVR
    var cvr        = buyRec ? buyRec.login_cvr    : null;
    var newUserCvr = buyRec ? buyRec.new_user_cvr : null;

    // ── Repeat rate
    var repeatRate = buyRec ? buyRec.repeat_rate : null;

    // ── Concentration
    var concentration = buyRec ? buyRec.concentration : null;

    // ── Hardgoods
    var hardgoods = null;
    if (hgRec) {
      hardgoods = {
        hardgoods_total:      _num(hgRec.hardgoods_total),
        hardgoods_online:     _num(hgRec.hardgoods_online),
        hardgoods_offline:    _num(hgRec.hardgoods_offline),
        hardgoods_online_pct: _num(hgRec.hardgoods_online_pct),
        plants_total:         _num(hgRec.plants_total),
        plants_online:        _num(hgRec.plants_online),
        plants_offline:       _num(hgRec.plants_offline),
        plants_online_pct:    _num(hgRec.plants_online_pct),
        ct_id:                hgRec.ct_id || null,
        ev:                   'observed',
      };
    }

    // ── Sell monthly — from cube
    var sellAggYtd = _aggregateSellCube(sellRows, 'ytd');
    var sellOnlineYtd  = sellAggYtd ? (sellAggYtd.online  > 0 ? sellAggYtd.online  : null) : null;
    var sellOfflineYtd = sellAggYtd ? (sellAggYtd.offline > 0 ? sellAggYtd.offline : null) : null;
    var sellTotalYtd   = sellAggYtd ? (sellAggYtd.total   > 0 ? sellAggYtd.total   : null) : null;

    return {
      buyers_table:     buyersTable   ? _ev(buyersTable,   'observed', 'buyers_evidence_v2') : null,
      cvr:              cvr           ? _ev(cvr,           'observed', 'buyers_evidence_v2') : null,
      new_user_cvr:     newUserCvr    ? _ev(newUserCvr,    'observed', 'buyers_evidence_v2') : null,
      repeat_rate:      repeatRate    ? _ev(repeatRate,    'observed', 'buyers_evidence_v2') : null,
      concentration:    concentration ? _ev(concentration, 'observed', 'buyers_evidence_v2') : null,
      hardgoods:        hardgoods     ? _ev(hardgoods,     'observed', 'hardgoods_v2')       : null,
      sell_online_ytd:  _ev(sellOnlineYtd,  sellOnlineYtd  ? 'observed' : 'gap', null),
      sell_offline_ytd: _ev(sellOfflineYtd, sellOfflineYtd ? 'observed' : 'gap', null),
      sell_total_ytd:   _ev(sellTotalYtd,   sellTotalYtd   ? 'observed' : 'gap', null),
      monthly_series:   monthlyTotals.length ? _ev(monthlyTotals, 'observed', 'sell cube') : null,
      current_month:    currentMonth || null,
      prior_month:      priorMonth   || null,
    };
  }

  /** BENCHMARKS — network + segment benchmarks (from V2) */
  function _buildBenchmarks(companyId) {
    var id   = _sid(companyId);
    var acct = _state.accountById[id];
    var ctId = acct ? (acct.ct_id || '') : '';

    var bmarks = _state.benchmarks;
    if (!bmarks || !Object.keys(bmarks).length) return null;

    var result = { segment: ctId, per_metric: {} };

    Object.keys(bmarks).forEach(function (key) {
      var bm      = bmarks[key];
      var network = bm.network || null;
      var segData = (bm.by_segment && ctId && bm.by_segment[ctId]) ? bm.by_segment[ctId] : null;

      result.per_metric[key] = {
        description:  bm.description || null,
        network:      network,
        segment:      segData,
        median:       network ? network.median       : null,
        p75:          network ? network.p75          : null,
        p90:          network ? network.p90          : null,
        best_account: network ? network.best_account : null,
        best_value:   network ? network.best_value   : null,
        seg_median:   segData ? segData.median       : null,
        seg_p75:      segData ? segData.p75          : null,
        seg_p90:      segData ? segData.p90          : null,
      };
    });

    return result;
  }

  /** FRESHNESS / TIMELINE — source coverage for this account */
  function _buildFreshness(companyId) {
    var id   = _sid(companyId);
    var name = _state.idToName[id];

    var sources = [];

    function _check(label, found, asOf) {
      sources.push({ source: label, found: !!found, as_of: asOf || null });
    }

    _check('accounts_v3',        !!_state.accountById[id],                         null);
    _check('sell_cube',          !!(_state.sellCubeById[id] && _state.sellCubeById[id].length), null);
    _check('buy_cube',           !!(_state.buyCubeById[id] && _state.buyCubeById[id].length),   null);
    _check('fees_cube',          !!(_state.feesCubeById[id] && _state.feesCubeById[id].length), null);
    _check('gmv_pacing',         !!_state.pacingById[id],                          null);
    _check('gmv_external',       !!_state.externalById[id],                        null);
    _check('buyers_evidence',    name ? !!_state.buyers[name] : false,             null);
    _check('vendors_evidence',   name ? !!_state.vendorsByName[name] : false,      null);
    _check('temporal',           name ? !!((_state.temporalSellAnticipation[name] && _state.temporalSellAnticipation[name].length)) : false, null);
    _check('inventory_current',  !!_state.inventory[id],                           null);
    _check('benchmarks',         !!Object.keys(_state.benchmarks).length,          null);
    _check('config_evidence',    !!_state.config[id],                              null);
    _check('hardgoods',          name ? !!_state.hardgoodsByName[name] : false,    null);

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

  function init() {
    return _loadAll();
  }

  /**
   * getAccountEvidence(companyId, timeframe)
   *
   * @param  {string|number} companyId
   * @param  {string}        timeframe — 'current_month' | 'prior_month' | 'ytd' | 'l12m'
   * @returns {Object|null}
   */
  function getAccountEvidence(companyId, timeframe) {
    if (!_state.loaded) {
      console.warn('[EvidenceAdapterV3] Data not loaded yet. Call init() first.');
      return null;
    }

    var id = _sid(companyId);
    if (!id) return null;

    var tf = timeframe || 'ytd';

    var identity = _buildIdentity(id);
    if (!identity) return null;

    var potential   = null;
    var buy         = null;
    var list        = null;
    var sell        = null;
    var benchmarks  = null;
    var freshness   = null;

    try { potential  = _buildPotential(id, tf); }  catch (e) { console.error('[EvidenceAdapterV3] potential error', id, e); }
    try { buy        = _buildBuy(id, tf); }         catch (e) { console.error('[EvidenceAdapterV3] buy error', id, e); }
    try { list       = _buildList(id); }             catch (e) { console.error('[EvidenceAdapterV3] list error', id, e); }
    try { sell       = _buildSell(id, tf); }         catch (e) { console.error('[EvidenceAdapterV3] sell error', id, e); }
    try { benchmarks = _buildBenchmarks(id); }       catch (e) { console.error('[EvidenceAdapterV3] benchmarks error', id, e); }
    try { freshness  = _buildFreshness(id); }        catch (e) { console.error('[EvidenceAdapterV3] freshness error', id, e); }

    return {
      _company_id:   id,
      _company_name: identity.company_name,
      _timeframe:    tf,

      identity:   identity,
      potential:  potential,
      buy:        buy,
      list:       list,
      sell:       sell,
      benchmarks: benchmarks,
      freshness:  freshness,
    };
  }

  /**
   * getAccountByName(companyName, timeframe)
   */
  function getAccountByName(companyName, timeframe) {
    if (!_state.loaded) {
      console.warn('[EvidenceAdapterV3] Data not loaded yet.');
      return null;
    }
    var id = _state.nameToId[companyName];
    if (!id) {
      console.warn('[EvidenceAdapterV3] No company_id found for name:', companyName);
      return null;
    }
    return getAccountEvidence(id, timeframe);
  }

  /**
   * getAllAccountIds()
   * Returns sorted array of company_ids from accounts_v3.json (NOT from old universe).
   */
  function getAllAccountIds() {
    return Object.keys(_state.accountById).sort();
  }

  /**
   * getLoadedState()
   */
  function getLoadedState() {
    return {
      loaded:                _state.loaded,
      accounts_v3_count:     Object.keys(_state.accountById).length,
      sell_cube_companies:   Object.keys(_state.sellCubeById).length,
      sell_cube_rows:        _state.sellCube.length,
      buy_cube_companies:    Object.keys(_state.buyCubeById).length,
      buy_cube_rows:         _state.buyCube.length,
      fees_cube_companies:   Object.keys(_state.feesCubeById).length,
      fees_cube_rows:        _state.feesCube.length,
      gmv_pacing_count:      Object.keys(_state.pacingById).length,
      gmv_external_count:    Object.keys(_state.externalById).length,
      buyers_count:          Object.keys(_state.buyers).length,
      vendors_count:         _state.vendors.length,
      inventory_count:       Object.keys(_state.inventory).length,
      benchmarks_count:      Object.keys(_state.benchmarks).length,
      config_count:          Object.keys(_state.config).length,
      hardgoods_count:       _state.hardgoods.length,
      name_to_id_count:      Object.keys(_state.nameToId).length,
      id_to_name_count:      Object.keys(_state.idToName).length,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
     EXPORT
  ───────────────────────────────────────────────────────────────────────── */

  /**
   * isClientWholesaler(ev) — Canonical filter for the prioritization universe.
   * Returns true if account is a Client + Wholesaler + known product tier.
   * EVERY view that prioritizes wholesalers MUST use this function.
   * Pre-live, Prospect, Unknown tier, non-Wholesaler → excluded.
   */
  function isClientWholesaler(ev) {
    if (!ev || !ev.identity) return false;
    var id = ev.identity;
    return id.account_class === 'Client'
      && id.business_type === 'Wholesaler'
      && id.product_tier
      && id.product_tier !== 'Unknown';
  }

  var EvidenceAdapter = {
    init:               init,
    getAccountEvidence: getAccountEvidence,
    getAccountByName:   getAccountByName,
    getAllAccountIds:    getAllAccountIds,
    getLoadedState:     getLoadedState,
    isClientWholesaler: isClientWholesaler,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EvidenceAdapter;
  } else {
    root.EvidenceAdapter = EvidenceAdapter;
  }

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
