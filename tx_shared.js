/**
 * TX Dashboard — Shared Module
 * Provides: nav bar, filter bar, localStorage filter sync, adapter init, Supabase client
 * Used by: changes.html, issues.html, opportunities.html, activation.html
 * Does NOT modify index_v3.html — loaded separately by each new tab.
 *
 * Version: 1.0.0 (2026-08-25)
 */

const TXShared = (() => {
  'use strict';

  // ─── CONFIGURATION ───────────────────────────────
  const TABS = [
    { id: 'portfolio',     label: 'Portfolio',      href: 'index_v3.html' },
    { id: 'changes',       label: 'Qué Cambió',    href: 'changes.html' },
    { id: 'issues',        label: 'Data Issues',    href: 'issues.html' },
    { id: 'opportunities', label: 'Opportunities',  href: 'opportunities.html' },
    { id: 'activation',    label: 'Activación',     href: 'activation.html' },
  ];

  const FILTER_STORAGE_KEY = 'tx_dashboard_filters';

  const DESIGN_TOKENS = {
    bg: '#f8fafc', surface: '#ffffff', border: '#e2e8f0',
    textPrimary: '#0f172a', textSecondary: '#475569', textMuted: '#94a3b8',
    green: '#16a34a', greenBg: '#f0fdf4',
    amber: '#d97706', amberBg: '#fffbeb',
    red: '#dc2626', redBg: '#fef2f2',
    blue: '#2563eb', blueBg: '#eff6ff',
  };

  // ─── NAV BAR ─────────────────────────────────────
  function renderNavBar(currentTabId) {
    const nav = document.createElement('nav');
    nav.className = 'tx-nav';
    nav.innerHTML = TABS.map(t => {
      const active = t.id === currentTabId ? ' tx-nav-active' : '';
      return `<a class="tx-nav-tab${active}" href="${t.href}" data-tab="${t.id}">${t.label}</a>`;
    }).join('');
    return nav;
  }

  function injectNavBar(currentTabId, targetSelector) {
    const target = document.querySelector(targetSelector || 'body');
    const nav = renderNavBar(currentTabId);
    target.insertBefore(nav, target.firstChild);
  }

  // ─── FILTER STATE (localStorage) ─────────────────
  function saveFilterState(state) {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* quota exceeded — ignore */ }
  }

  function loadFilterState() {
    try {
      const raw = localStorage.getItem(FILTER_STORAGE_KEY);
      return raw ? JSON.parse(raw) : getDefaultFilters();
    } catch (e) {
      return getDefaultFilters();
    }
  }

  function getDefaultFilters() {
    return {
      accountClass: 'Client',
      businessType: 'Wholesaler',
      productTier: '',
      gmvBand: '',
      sellChannel: '',
      potentialTier: '',
      priority: [],
      impl: [],
      search: '',
    };
  }

  // ─── FILTER BAR RENDERING ────────────────────────
  function renderFilterBar(containerId, onChange) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const state = loadFilterState();

    container.innerHTML = `
      <div class="tx-filter-bar">
        <div class="tx-filter-row">
          <select class="tx-select" id="txf-account-class">
            <option value="">All Classes</option>
            <option value="Client"${state.accountClass === 'Client' ? ' selected' : ''}>Client</option>
            <option value="Pre-live"${state.accountClass === 'Pre-live' ? ' selected' : ''}>Pre-live</option>
            <option value="Prospect"${state.accountClass === 'Prospect' ? ' selected' : ''}>Prospect</option>
          </select>
          <select class="tx-select" id="txf-business-type">
            <option value="">All Business Types</option>
            <option value="Wholesaler"${state.businessType === 'Wholesaler' ? ' selected' : ''}>Wholesaler</option>
            <option value="Importer"${state.businessType === 'Importer' ? ' selected' : ''}>Importer</option>
            <option value="Grower"${state.businessType === 'Grower' ? ' selected' : ''}>Grower</option>
            <option value="Retailer"${state.businessType === 'Retailer' ? ' selected' : ''}>Retailer</option>
          </select>
          <select class="tx-select" id="txf-product-tier">
            <option value="">All Product Tiers</option>
            <option value="Core+"${state.productTier === 'Core+' ? ' selected' : ''}>Core+</option>
            <option value="eSuite"${state.productTier === 'eSuite' ? ' selected' : ''}>eSuite</option>
            <option value="Procurement"${state.productTier === 'Procurement' ? ' selected' : ''}>Procurement</option>
            <option value="K2K"${state.productTier === 'K2K' ? ' selected' : ''}>K2K</option>
          </select>
          <select class="tx-select" id="txf-gmv-band">
            <option value="">All GMV Bands</option>
            <option value=">=10M"${state.gmvBand === '>=10M' ? ' selected' : ''}>&ge;$10M</option>
            <option value="$2-10M"${state.gmvBand === '$2-10M' ? ' selected' : ''}>$2-10M</option>
            <option value="$500K-2M"${state.gmvBand === '$500K-2M' ? ' selected' : ''}>$500K-2M</option>
            <option value="<$500K"${state.gmvBand === '<$500K' ? ' selected' : ''}>&lt;$500K</option>
          </select>
          <input class="tx-search" id="txf-search" type="text" placeholder="Search account…" value="${state.search || ''}">
        </div>
        <div class="tx-filter-row tx-chip-row">
          <span class="tx-chip-label">Priority:</span>
          ${['P1','IMPL','TA','CS_TRACKED','CS_P2','WATCH','NEEDS_REVIEW','ECOSYSTEM'].map(v => {
            const label = v === 'CS_TRACKED' ? 'CS' : v === 'NEEDS_REVIEW' ? 'REVIEW' : v === 'ECOSYSTEM' ? 'ECO' : v;
            const active = (state.priority || []).includes(v) ? ' tx-chip-active' : '';
            return `<button class="tx-chip${active}" data-filter="priority" data-value="${v}">${label}</button>`;
          }).join('')}
          <span class="tx-chip-label" style="margin-left:12px">Impl:</span>
          ${['active-pmt','go-live-growth','Recently live (2026)','Recently live (H2 2025)','Established'].map(v => {
            const label = v === 'active-pmt' ? 'Active PMT' : v === 'go-live-growth' ? 'Go-Live & Growth' : v.replace('Recently live ','Live ');
            const active = (state.impl || []).includes(v) ? ' tx-chip-active' : '';
            return `<button class="tx-chip${active}" data-filter="impl" data-value="${v}">${label}</button>`;
          }).join('')}
        </div>
      </div>
    `;

    // Bind events
    const selects = container.querySelectorAll('.tx-select');
    selects.forEach(sel => sel.addEventListener('change', () => {
      const s = collectFilterState(container);
      saveFilterState(s);
      if (onChange) onChange(s);
    }));

    const chips = container.querySelectorAll('.tx-chip');
    chips.forEach(chip => chip.addEventListener('click', () => {
      chip.classList.toggle('tx-chip-active');
      const s = collectFilterState(container);
      saveFilterState(s);
      if (onChange) onChange(s);
    }));

    const searchInput = container.querySelector('#txf-search');
    if (searchInput) {
      let debounce;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          const s = collectFilterState(container);
          saveFilterState(s);
          if (onChange) onChange(s);
        }, 300);
      });
    }

    return state;
  }

  function collectFilterState(container) {
    const g = id => { const el = container.querySelector('#' + id); return el ? el.value : ''; };
    const activeChips = (filterName) => {
      return Array.from(container.querySelectorAll(`.tx-chip-active[data-filter="${filterName}"]`))
        .map(c => c.dataset.value);
    };
    return {
      accountClass: g('txf-account-class'),
      businessType: g('txf-business-type'),
      productTier: g('txf-product-tier'),
      gmvBand: g('txf-gmv-band'),
      sellChannel: '',
      potentialTier: '',
      priority: activeChips('priority'),
      impl: activeChips('impl'),
      search: g('txf-search'),
    };
  }

  // ─── FILTER APPLICATION ──────────────────────────
  function applyFilters(accounts, filterState) {
    let filtered = accounts;
    const s = filterState;

    if (s.accountClass) {
      filtered = filtered.filter(a => a.account_class === s.accountClass);
    }
    if (s.businessType) {
      filtered = filtered.filter(a => a.business_type === s.businessType);
    }
    if (s.productTier) {
      filtered = filtered.filter(a => a.product_tier === s.productTier);
    }
    if (s.gmvBand) {
      filtered = filtered.filter(a => a.gmv_band === s.gmvBand);
    }
    if (s.priority && s.priority.length > 0) {
      filtered = filtered.filter(a => s.priority.includes(a.priority_level));
    }
    if (s.search) {
      const q = s.search.toLowerCase();
      filtered = filtered.filter(a => (a.company_name || '').toLowerCase().includes(q));
    }
    return filtered;
  }

  // ─── DATA LOADING ────────────────────────────────
  async function loadJSON(path) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`Failed to load ${path}: ${resp.status}`);
    return resp.json();
  }

  async function loadAllData() {
    const [accounts, sellMonthly, buyMonthly, feesMonthly, manifest] = await Promise.all([
      loadJSON('data/accounts_v3.json'),
      loadJSON('data/current/sell_monthly.json'),
      loadJSON('data/current/buy_monthly.json'),
      loadJSON('data/current/fees_monthly.json'),
      loadJSON('data/current/_manifest.json'),
    ]);
    return { accounts, sellMonthly, buyMonthly, feesMonthly, manifest };
  }

  // ─── FORMATTING HELPERS ──────────────────────────
  function fmtDollar(val) {
    if (val == null || isNaN(val)) return '—';
    if (Math.abs(val) >= 1e6) return '$' + (val / 1e6).toFixed(1) + 'M';
    if (Math.abs(val) >= 1e3) return '$' + (val / 1e3).toFixed(0) + 'K';
    return '$' + val.toFixed(0);
  }

  function fmtPct(val) {
    if (val == null || isNaN(val)) return '—';
    return (val >= 0 ? '+' : '') + val.toFixed(1) + '%';
  }

  function fmtDelta(val) {
    if (val == null || isNaN(val)) return '';
    const cls = val > 0 ? 'tx-delta-up' : val < 0 ? 'tx-delta-down' : 'tx-delta-flat';
    const arrow = val > 0 ? '▲' : val < 0 ? '▼' : '—';
    return `<span class="${cls}">${arrow} ${fmtPct(val)}</span>`;
  }

  function daysSince(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    const now = new Date();
    return Math.floor((now - d) / (1000 * 60 * 60 * 24));
  }

  // ─── CSS INJECTION ───────────────────────────────
  function injectStyles() {
    if (document.getElementById('tx-shared-styles')) return;
    const style = document.createElement('style');
    style.id = 'tx-shared-styles';
    style.textContent = `
      /* ─── NAV BAR ─── */
      .tx-nav {
        display: flex;
        gap: 0;
        background: #ffffff;
        border-bottom: 2px solid #e2e8f0;
        padding: 0 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
      }
      .tx-nav-tab {
        padding: 10px 18px;
        font-size: 13px;
        font-weight: 500;
        color: #475569;
        text-decoration: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -2px;
        transition: all 0.15s;
      }
      .tx-nav-tab:hover { color: #0f172a; background: #f8fafc; }
      .tx-nav-tab.tx-nav-active {
        color: #2563eb;
        border-bottom-color: #2563eb;
        font-weight: 600;
      }

      /* ─── FILTER BAR ─── */
      .tx-filter-bar {
        background: #ffffff;
        border-bottom: 1px solid #e2e8f0;
        padding: 8px 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
      }
      .tx-filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        padding: 4px 0;
      }
      .tx-select {
        font-size: 11px;
        padding: 4px 8px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        background: #ffffff;
        color: #0f172a;
        cursor: pointer;
      }
      .tx-search {
        font-size: 11px;
        padding: 4px 8px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        width: 160px;
      }
      .tx-chip-label {
        font-size: 10px;
        color: #94a3b8;
        align-self: center;
        margin-right: 4px;
      }
      .tx-chip {
        font-size: 10px;
        padding: 2px 8px;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        background: #ffffff;
        color: #475569;
        cursor: pointer;
        transition: all 0.1s;
      }
      .tx-chip:hover { border-color: #94a3b8; }
      .tx-chip-active {
        background: #2563eb;
        color: #ffffff;
        border-color: #2563eb;
      }
      .tx-chip-row { padding-top: 2px; }

      /* ─── CONTENT AREA ─── */
      .tx-content {
        max-width: 1400px;
        margin: 0 auto;
        padding: 16px 24px;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
        font-size: 11px;
        color: #0f172a;
      }

      /* ─── TABLES ─── */
      .tx-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .tx-table th {
        text-align: left;
        font-weight: 600;
        font-size: 10px;
        text-transform: uppercase;
        color: #64748b;
        padding: 6px 8px;
        border-bottom: 2px solid #e2e8f0;
        cursor: pointer;
        white-space: nowrap;
      }
      .tx-table th:hover { color: #0f172a; }
      .tx-table td {
        padding: 6px 8px;
        border-bottom: 1px solid #f1f5f9;
        white-space: nowrap;
      }
      .tx-table tr:hover { background: #f8fafc; }

      /* ─── BADGES ─── */
      .tx-badge {
        display: inline-block;
        font-size: 9px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 3px;
        text-transform: uppercase;
      }
      .tx-badge-red { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
      .tx-badge-amber { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
      .tx-badge-green { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
      .tx-badge-blue { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
      .tx-badge-gray { background: #f8fafc; color: #64748b; border: 1px solid #e2e8f0; }

      /* ─── DELTAS ─── */
      .tx-delta-up { color: #16a34a; font-weight: 600; }
      .tx-delta-down { color: #dc2626; font-weight: 600; }
      .tx-delta-flat { color: #94a3b8; }

      /* ─── CARDS (for opportunities) ─── */
      .tx-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        padding: 12px 16px;
        margin-bottom: 8px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      }
      .tx-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .tx-card-actions {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      .tx-btn {
        font-size: 11px;
        padding: 4px 12px;
        border: 1px solid #e2e8f0;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.1s;
      }
      .tx-btn-approve { background: #f0fdf4; color: #16a34a; border-color: #bbf7d0; }
      .tx-btn-approve:hover { background: #16a34a; color: #fff; }
      .tx-btn-reject { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
      .tx-btn-reject:hover { background: #dc2626; color: #fff; }
      .tx-btn-investigate { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
      .tx-btn-investigate:hover { background: #2563eb; color: #fff; }

      /* ─── SUMMARY BAR ─── */
      .tx-summary {
        display: flex;
        gap: 24px;
        padding: 12px 0;
        border-bottom: 1px solid #e2e8f0;
        margin-bottom: 16px;
      }
      .tx-summary-item {
        text-align: center;
      }
      .tx-summary-value {
        font-size: 18px;
        font-weight: 700;
      }
      .tx-summary-label {
        font-size: 10px;
        color: #64748b;
        text-transform: uppercase;
      }

      /* ─── SECTION HEADERS ─── */
      .tx-section-header {
        font-size: 14px;
        font-weight: 600;
        color: #0f172a;
        padding: 16px 0 8px;
        border-bottom: 1px solid #e2e8f0;
        margin-bottom: 12px;
      }

      /* ─── LOADING ─── */
      .tx-loading {
        text-align: center;
        padding: 48px;
        color: #94a3b8;
        font-size: 13px;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── SUPABASE CLIENT ──────────────────────────────
  const Supabase = (() => {
    const SUPABASE_URL = 'https://ehmhnfoxezrcfuzesaca.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVobWhuZm94ZXpyY2Z1emVzYWNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2MTI0MjMsImV4cCI6MjEwMTE4ODQyM30.1n-U9nWpi85DKSprZZtgGbJOP-q7b9UKaBM_cb_0EtQ';

    const headers = () => ({
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    });

    async function getDecisions() {
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/tx_opportunity_decisions?select=*`, { headers: headers() });
        if (!resp.ok) throw new Error(resp.status);
        const rows = await resp.json();
        const map = {};
        rows.forEach(r => { map[r.opportunity_key] = r; });
        return map;
      } catch (e) {
        console.warn('Supabase unavailable, falling back to localStorage:', e.message);
        return null;
      }
    }

    async function saveDecision(oppData) {
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/tx_opportunity_decisions`, {
          method: 'POST',
          headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({
            opportunity_key: oppData.opportunity_key,
            company_id: oppData.company_id || '',
            company_name: oppData.company_name || '',
            opportunity_type: oppData.opportunity_type || '',
            potential_amount: oppData.potential_amount || 0,
            decision: oppData.decision || 'open',
            comment: oppData.comment || null,
            decided_by: 'facu',
            decided_at: oppData.decision !== 'open' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          }),
        });
        if (!resp.ok) throw new Error(resp.status);
        return await resp.json();
      } catch (e) {
        console.warn('Supabase save failed, using localStorage only:', e.message);
        return null;
      }
    }

    async function isAvailable() {
      try {
        const resp = await fetch(`${SUPABASE_URL}/rest/v1/tx_opportunity_decisions?limit=1`, { headers: headers() });
        return resp.ok;
      } catch { return false; }
    }

    return { getDecisions, saveDecision, isAvailable };
  })();

  // ─── INIT ────────────────────────────────────────
  function init(currentTabId, filterContainerId, onFilterChange) {
    injectStyles();
    injectNavBar(currentTabId, 'body');
    if (filterContainerId) {
      return renderFilterBar(filterContainerId, onFilterChange);
    }
    return loadFilterState();
  }

  // ─── PUBLIC API ──────────────────────────────────
  return {
    init,
    loadFilterState,
    saveFilterState,
    applyFilters,
    loadJSON,
    loadAllData,
    fmtDollar,
    fmtPct,
    fmtDelta,
    daysSince,
    renderFilterBar,
    injectNavBar,
    injectStyles,
    Supabase,
    TABS,
    DESIGN_TOKENS,
  };
})();
