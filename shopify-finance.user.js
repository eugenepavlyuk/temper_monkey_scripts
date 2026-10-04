// ==UserScript==
// @name         Shopify Finance - TaxAdvisor
// @namespace    tax-advisor
// @version      0.3.0
// @description  Adds customer name column and a CSV export to the Shopify payout transactions table
// @match        https://admin.shopify.com/store/*/payments/payouts*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.3.0';
  // Shopify Admin API version. Unsupported versions are served by the oldest supported one,
  // but keep this reasonably current.
  const SHOPIFY_API_VERSION = '2026-01';
  // Parallel order requests (Shopify rate-limits the admin API)
  const CONCURRENCY = 4;
  // Fixed time written into the CSV for every transaction date
  const CSV_TIME = '04:00:00';
  // UTF-8 BOM so Excel / importers read umlauts in customer names correctly
  const CSV_BOM = true;

  // Amount written into the CSV: 'Charge' (what the customer paid) or 'Net' (after Shopify fees)
  const AMOUNT_COLUMN = 'Charge';
  // Column positions of the new payouts table (Date | Type | Order | Charge | Fee | Net),
  // used when the header labels are not English
  const DEFAULT_COLUMNS = { Date: 0, Type: 1, Order: 2, Charge: 3, Fee: 4, Net: 5 };

  const NAME_CELL_ATTR = 'data-tax-advisor-name';
  const STATUS = { loading: '⏳', none: '—', error: '❌' };

  console.log('[TaxAdvisor] Shopify Finance script v' + VERSION + ' loaded');

  // Store handle from the URL: /store/<handle>/payments/payouts/...
  const storeHandle = () => location.pathname.match(/\/store\/([^/]+)/)?.[1];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- Customer Name column ----------
  // New payouts page (/payments/payouts-next): the table is a CSS grid of divs
  // (.Polaris-Table > .Polaris-Table-TableHeadingRow / .Polaris-Table-TableRow, display: contents).

  function findTable() {
    return Array.from(document.querySelectorAll('.Polaris-Table'))
      .find((t) => t.querySelector('s-clickable-chip[href*="/orders/"], a[href*="/orders/"]')) || null;
  }

  const headingRows = (table) => Array.from(table.querySelectorAll('.Polaris-Table-TableHeadingRow'));
  const dataRows = (table) => Array.from(table.querySelectorAll('.Polaris-Table-TableRow'));
  const ownCells = (row) => Array.from(row.children).filter((c) => !c.hasAttribute(NAME_CELL_ATTR));

  // Column index by header label (English UI), else the default position
  function columnIndex(table, name) {
    const headers = ownCells(headingRows(table)[0] || document.createElement('div'));
    const i = headers.findIndex((h) => (h.getAttribute('aria-label') || h.textContent).trim() === name);
    return i >= 0 ? i : DEFAULT_COLUMNS[name];
  }

  function addNameColumn(table) {
    const orderCol = columnIndex(table, 'Order');
    let added = false;

    headingRows(table).forEach((row) => {
      if (row.querySelector(`[${NAME_CELL_ATTR}]`)) return;
      const orderHeader = ownCells(row)[orderCol];
      if (!orderHeader) return;
      const th = document.createElement('div');
      th.setAttribute(NAME_CELL_ATTR, 'header');
      th.setAttribute('role', 'columnheader');
      th.className = orderHeader.className;
      th.style.cssText = 'display:flex;align-items:center;font-weight:600;white-space:nowrap;';
      th.textContent = 'Customer Name';
      orderHeader.after(th);
      added = true;
    });

    dataRows(table).forEach((row) => {
      if (row.querySelector(`[${NAME_CELL_ATTR}]`)) return;
      const orderCell = ownCells(row)[orderCol];
      if (!orderCell) return;
      const td = document.createElement('div');
      td.setAttribute(NAME_CELL_ATTR, 'cell');
      td.setAttribute('role', 'cell');
      td.className = orderCell.className;
      td.style.cssText = 'display:flex;align-items:center;white-space:nowrap;';
      orderCell.after(td);
      added = true;

      const href = orderCell.querySelector('s-clickable-chip[href], a[href]')?.getAttribute('href') || '';
      const orderId = href.match(/\/orders\/(\d+)/)?.[1];
      if (!orderId) {
        td.textContent = STATUS.none;
        return;
      }
      td.textContent = STATUS.loading;
      queue.push({ orderId, td });
    });

    // The grid has a fixed number of columns: add one for our column
    const columns = ownCells(headingRows(table)[0] || dataRows(table)[0]).length + 1;
    const template = `repeat(${columns}, auto)`;
    if (table.style.gridTemplateColumns !== template) table.style.gridTemplateColumns = template;
    if (added) pump();
  }

  // Name from the order: customer, else billing address, else shipping address (guest checkouts)
  function customerNameOf(order) {
    const join = (first, last) => [first, last].filter(Boolean).join(' ').trim();
    return join(order?.customer?.first_name, order?.customer?.last_name)
      || order?.billing_address?.name?.trim() || join(order?.billing_address?.first_name, order?.billing_address?.last_name)
      || order?.shipping_address?.name?.trim() || join(order?.shipping_address?.first_name, order?.shipping_address?.last_name)
      || '';
  }

  async function fetchCustomerName(orderId) {
    const url = `https://admin.shopify.com/store/${storeHandle()}/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      if (res.status === 429) { // rate limited: wait and retry
        await sleep(1000 * attempt);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return customerNameOf((await res.json()).order);
    }
    throw new Error('HTTP 429 (rate limit)');
  }

  function showName(td, name) {
    td.textContent = '';
    td.dataset.customerName = name;
    const copyBtn = document.createElement('span');
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy name';
    copyBtn.style.cursor = 'pointer';
    copyBtn.style.marginRight = '4px';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(name).then(() => {
        copyBtn.textContent = '✅';
        setTimeout(() => (copyBtn.textContent = '📋'), 1500);
      });
    });
    td.appendChild(copyBtn);
    td.appendChild(document.createTextNode(name));
  }

  // Fetch queue with limited concurrency
  const queue = [];
  let activeRequests = 0;
  function pump() {
    while (activeRequests < CONCURRENCY && queue.length) {
      const { orderId, td } = queue.shift();
      activeRequests++;
      fetchCustomerName(orderId)
        .then((name) => (name ? showName(td, name) : (td.textContent = STATUS.none)))
        .catch((err) => {
          console.warn(`[TaxAdvisor] Order ${orderId}: ${err.message || err}`);
          td.textContent = STATUS.error;
          td.title = String(err.message || err);
        })
        .finally(() => {
          activeRequests--;
          pump();
        });
    }
  }

  // ---------- CSV export ----------

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, mär: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8,
    sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12,
  };

  // "Sep 25, 2026" / "25.09.2026" / "25. Sept. 2026" / "2026-09-25" -> { y, m, d } or null
  function parseShopifyDate(text) {
    const t = text.trim();
    let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { y: +m[1], m: +m[2], d: +m[3] };
    m = t.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) return { y: +m[3], m: +m[2], d: +m[1] };
    m = t.match(/([A-Za-zäÄ]{3})[a-zäÄ]*\.?\s+(\d{1,2}),?\s+(\d{4})/); // English: Sep 25, 2026
    if (m && MONTHS[m[1].toLowerCase()]) return { y: +m[3], m: MONTHS[m[1].toLowerCase()], d: +m[2] };
    m = t.match(/(\d{1,2})\.?\s+([A-Za-zäÄ]{3})[a-zäÄ]*\.?\s+(\d{4})/); // German: 25. Sept. 2026
    if (m && MONTHS[m[2].toLowerCase()]) return { y: +m[3], m: MONTHS[m[2].toLowerCase()], d: +m[1] };
    return null;
  }

  // Local UTC offset on that day, e.g. "+0100" in winter, "+0200" in summer (CET/CEST)
  function utcOffset(y, m, d) {
    const minutes = -new Date(y, m - 1, d, 4).getTimezoneOffset();
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(minutes);
    return sign + String(Math.floor(abs / 60)).padStart(2, '0') + String(abs % 60).padStart(2, '0');
  }

  function formatCsvDate(text) {
    const p = parseShopifyDate(text);
    if (!p) return text.trim();
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.y}-${pad(p.m)}-${pad(p.d)} ${CSV_TIME} ${utcOffset(p.y, p.m, p.d)}`;
  }

  // "€1,234.56" / "1.234,56 €" / "-€39.00" / "€ 39,00 EUR" -> "1234.56" (dot decimal, no thousands separator)
  function formatCsvAmount(text) {
    let t = text.replace(/[^\d.,-]/g, '');
    const negative = t.includes('-');
    t = t.replace(/-/g, '');
    const lastSep = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
    // A separator followed by exactly 1-2 digits is the decimal separator
    const hasDecimals = lastSep >= 0 && t.length - lastSep - 1 <= 2;
    const intPart = (hasDecimals ? t.slice(0, lastSep) : t).replace(/[.,]/g, '');
    const decPart = hasDecimals ? t.slice(lastSep + 1) : '';
    const value = parseFloat(`${intPart || '0'}.${decPart || '0'}`);
    if (Number.isNaN(value)) return text.trim();
    return (negative ? -value : value).toFixed(2);
  }

  // Quote every field (commas, quotes and line breaks inside values stay in their column)
  const csvField = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  function exportCsv() {
    const table = findTable();
    if (!table) {
      alert('Payout transactions table not found.');
      return;
    }
    const col = {
      date: columnIndex(table, 'Date'),
      type: columnIndex(table, 'Type'),
      amount: columnIndex(table, AMOUNT_COLUMN),
    };
    const lines = [['Transaction Date', 'Type', 'Customer Name', 'Amount'].map(csvField).join(',')];
    let skipped = 0;
    dataRows(table).forEach((row) => {
      const cells = ownCells(row);
      const name = row.querySelector(`[${NAME_CELL_ATTR}]`)?.dataset.customerName || '';
      if (!name) { // no name (not loaded, no order, guest without address, error)
        skipped++;
        return;
      }
      lines.push([
        formatCsvDate(cells[col.date].textContent),
        cells[col.type].textContent.trim(),
        name,
        formatCsvAmount(cells[col.amount].textContent),
      ].map(csvField).join(','));
    });

    const csv = (CSV_BOM ? '\uFEFF' : '') + lines.join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'tax-advisor-export.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000); // revoking immediately can cancel the download
    console.log(`[TaxAdvisor] Exported ${lines.length - 1} rows, skipped ${skipped} rows without customer name`);
    if (skipped) alert(`Exported ${lines.length - 1} rows.\n${skipped} rows without customer name were skipped.`);
  }

  function addExportButton() {
    if (document.getElementById('tax-advisor-export')) return;
    // Page action "Export" (web component in the light DOM, next to "Tax forms" / "View activity report")
    const exportBtn = Array.from(document.querySelectorAll('s-internal-button, button'))
      .find((b) => b.getRootNode() === document && b.textContent.trim() === 'Export');
    if (!exportBtn) return;

    const btn = document.createElement('button');
    btn.id = 'tax-advisor-export';
    btn.type = 'button';
    btn.textContent = 'Custom Export';
    btn.style.cssText = 'margin-right:8px;padding:6px 12px;border:none;border-radius:8px;' +
      'background:#1565c0;color:#fff;font:600 13px/20px inherit;cursor:pointer;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      exportCsv();
    });
    exportBtn.before(btn);
  }

  // Shopify is an SPA: keep watching for (re-)rendered tables and buttons
  const run = () => {
    const table = findTable();
    if (table) addNameColumn(table);
    addExportButton();
  };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  run();
})();
