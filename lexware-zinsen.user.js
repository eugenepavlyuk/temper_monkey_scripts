// ==UserScript==
// @name         Lexware Zinsen - TaxAdvisor
// @namespace    tax-advisor
// @version      0.3.0
// @description  Adds "Calculate Zinsen" button to Lexware Kontoauszug (AccountStatement) page
// @match        https://app.lexware.de/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'tax-advisor-zinsen';
  const BUTTON_LABEL = 'Calculate Zinsen';
  const BUTTON_COLOR = '#1565c0';
  const BUTTON_HOVER_COLOR = '#0d47a1';
  const VERSION = '0.3.0';

  console.log('[TaxAdvisor] Zinsen script v' + VERSION + ' loaded');

  function isAccountStatementPage() {
    // Hash-routed page: https://app.lexware.de/bookkeeping#!/AccountStatement/...
    return location.pathname.startsWith('/bookkeeping') && location.hash.startsWith('#!/AccountStatement');
  }

  function normalizeText(el) {
    return el.textContent.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Our buttons live in a shared toolbar on the header's second line (next to the
  // account arrows and the account name). The right header box has a fixed width and
  // would overflow into "Druckansicht" if we added buttons there.
  function getToolbar() {
    const line = document.querySelector('button[ng-click="ui.navigateNext()"]')?.parentElement;
    if (!line) return null;
    let bar = document.getElementById('tax-advisor-toolbar');
    if (!bar || !bar.isConnected) {
      bar = document.createElement('span');
      bar.id = 'tax-advisor-toolbar';
      bar.style.cssText = 'position:absolute;top:0;display:inline-flex;gap:8px;';
      line.appendChild(bar);
    }
    // The account name ("Erlöse 19% USt") is absolutely positioned: place the toolbar right after it
    const name = Array.from(line.children)
      .find((el) => el !== bar && el.tagName === 'SPAN' && getComputedStyle(el).position === 'absolute' && el.textContent.trim());
    const left = name ? name.offsetLeft + name.offsetWidth + 24 : 200;
    if (bar.style.left !== `${left}px`) bar.style.left = `${left}px`;
    return bar;
  }

  // ---------- Account statement table ----------

  function getItemRows() {
    // Booking rows only (not "Saldo alt" / "Summe Umsätze")
    return Array.from(document.querySelectorAll('table tr[ng-repeat^="item in accountStatementItems"]'));
  }

  function getColumnIndex(headerText) {
    const th = Array.from(document.querySelectorAll('table th'))
      .find((el) => normalizeText(el) === headerText.toLowerCase());
    return th ? Array.from(th.parentElement.children).indexOf(th) : -1;
  }

  function parseEuro(text) {
    // "9.999,00 €" -> 9999, "-9.999,00 €" -> -9999
    const value = parseFloat(text.replace(/[^\d,-]/g, '').replace(',', '.'));
    return Number.isNaN(value) ? 0 : value;
  }

  function parseDate(text) {
    // "23.01.2026" -> Date
    const m = text.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
  }

  // Read all booking rows of the current Kontoauszug (read-only)
  function readBookings() {
    const col = {
      serviceDate: getColumnIndex('Leistungsdatum'),
      voucherDate: getColumnIndex('Belegdatum'),
      receipt: getColumnIndex('Beleg'),
      text: getColumnIndex('Text'),
      account: getColumnIndex('Gegenkonto'),
      debit: getColumnIndex('Soll'),
      credit: getColumnIndex('Haben'),
    };
    return getItemRows().map((row) => {
      const cell = (i) => (i >= 0 ? row.children[i]?.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim() || '' : '');
      return {
        serviceDate: parseDate(cell(col.serviceDate)),
        voucherDate: parseDate(cell(col.voucherDate)),
        receipt: cell(col.receipt),
        text: cell(col.text),
        account: cell(col.account),
        debit: parseEuro(cell(col.debit)),
        credit: parseEuro(cell(col.credit)),
      };
    });
  }

  // ---------- Zinsen ----------

  // Rows that are included (column "Text")
  const TARGET_TEXT = 'Ticketmate GmbH Einnahmen';
  // Payment term: days after Belegdatum before interest starts
  const PAYMENT_TERM_DAYS = 14;
  // Interest rate per year
  const INTEREST_RATE = 0.08;
  // Base amount: 'net' = Haben column (as in the table), 'gross' = invoice gross amount
  const INTEREST_BASE = 'net';
  // Parallel API requests (Lexware's own read endpoints, nothing is changed)
  const CONCURRENCY = 4;
  const BLINK_MS = 400;

  const COLUMNS = ['Bezahlt am', 'Tage', 'Überfällig', 'Zinsen'];
  const CELL_CLASS = 'tax-advisor-zinsen-cell';
  const DAY_MS = 24 * 60 * 60 * 1000;

  const formatDate = (d) => (d ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
  const formatEuro = (n) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  // Whole calendar days between two dates (ignores time of day and DST)
  const daysBetween = (from, to) => Math.round(
    (Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY_MS);

  const BLINK_KEYFRAMES = [
    { backgroundColor: 'rgba(233, 30, 99, 0.55)' },
    { backgroundColor: 'rgba(233, 30, 99, 0)' },
    { backgroundColor: 'rgba(233, 30, 99, 0.55)' },
  ];
  const flash = (el) => el && el.animate(BLINK_KEYFRAMES, { duration: BLINK_MS / 2, iterations: 2 });

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  // Booking id from the row link: .../AccountStatement/<accountingRecordId>?...
  const recordIdOf = (row) => row.getAttribute('href')?.match(/AccountStatement\/([\w-]+)/i)?.[1] || null;

  // booking -> voucher -> payments. Paid date = latest payment posting date (several part payments possible).
  async function fetchPayment(recordId) {
    const journal = await getJson(`/grld-rest/accountingjournalservice/1/v100/accountingJournalItemDetails/${recordId}`);
    const { voucherType, voucherId } = journal;
    if (!voucherId) return { error: 'No voucher linked', customer: '' };
    const voucher = await getJson(`/grld-rest/voucherservice/1/v100/voucherDetails/${voucherType}/${voucherId}`);
    const payments = (voucher.paymentListItems || []).filter((p) => p.postingDate && p.paymentItemType !== 'balanced');
    const paidDates = payments.map((p) => new Date(p.postingDate)).sort((a, b) => a - b);
    const balanced = (voucher.paymentListItems || []).some((p) => p.paymentItemType === 'balanced');
    return {
      paidAt: balanced && paidDates.length ? paidDates[paidDates.length - 1] : null,
      partPayments: payments.length,
      grossAmount: voucher.totalGrossAmount,
      dueDate: voucher.dueDate ? new Date(voucher.dueDate) : null,
      customer: voucher.contactName || '',
    };
  }

  // Add our 4 columns at the end of the table (header, booking rows, Saldo/Summe rows)
  function addColumns() {
    document.querySelectorAll(`.${CELL_CLASS}`).forEach((el) => el.remove()); // re-run: start clean
    const table = getItemRows()[0]?.closest('table');
    if (!table) return null;
    const headerRow = Array.from(table.querySelectorAll('tr')).find((tr) => tr.querySelector('th'));
    COLUMNS.forEach((title) => {
      const th = document.createElement('th');
      th.className = CELL_CLASS;
      th.textContent = title;
      th.style.cssText = 'text-align:right;white-space:nowrap;padding-left:12px;';
      headerRow?.appendChild(th);
    });
    Array.from(table.querySelectorAll('tbody tr')).forEach((tr) => {
      COLUMNS.forEach(() => {
        const td = document.createElement('td');
        td.className = `${CELL_CLASS} text-right`;
        td.style.cssText = 'text-align:right;white-space:nowrap;padding-left:12px;';
        tr.appendChild(td);
      });
    });
    return table;
  }

  const ourCells = (tr) => Array.from(tr.querySelectorAll(`td.${CELL_CLASS}`));

  async function calculateZinsen() {
    const startedAt = Date.now();
    const textCol = getColumnIndex('Text');
    const dateCol = getColumnIndex('Belegdatum');
    const receiptCol = getColumnIndex('Beleg');
    const creditCol = getColumnIndex('Haben');
    const table = addColumns();
    if (!table) {
      console.log('[TaxAdvisor] Zinsen: no booking rows found');
      return;
    }

    const cellText = (tr, i) => tr.children[i]?.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim() || '';
    const rows = getItemRows().filter((tr) => cellText(tr, textCol) === TARGET_TEXT);
    console.log(`[TaxAdvisor] Zinsen: ${rows.length} rows with Text "${TARGET_TEXT}"`);

    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const tr = rows[next++];
        const [paidCell, daysCell, overdueCell, interestCell] = ourCells(tr);
        const receipt = cellText(tr, receiptCol);
        const voucherDate = parseDate(cellText(tr, dateCol));
        const netAmount = parseEuro(cellText(tr, creditCol));
        paidCell.textContent = '⏳';
        try {
          const pay = await fetchPayment(recordIdOf(tr));
          if (pay.error || !pay.paidAt) {
            // Not (fully) paid yet: leave the cells empty
            paidCell.textContent = '';
            const note = pay.error || (pay.partPayments ? `${pay.partPayments} Teilzahlung(en), noch nicht ausgeglichen` : 'Noch nicht bezahlt');
            results.push({ status: pay.error ? 'error' : 'open', receipt, customer: pay.customer, voucherDate, netAmount, paidAt: null, interest: 0, note });
            continue;
          }
          const days = daysBetween(voucherDate, pay.paidAt);
          const overdue = Math.max(0, days - PAYMENT_TERM_DAYS);
          const base = INTEREST_BASE === 'gross' ? pay.grossAmount : netAmount;
          const interest = Math.round(base * INTEREST_RATE * overdue / 365 * 100) / 100;

          paidCell.textContent = formatDate(pay.paidAt);
          if (pay.partPayments > 1) paidCell.title = `${pay.partPayments} Teilzahlungen, letzte am ${formatDate(pay.paidAt)}`;
          daysCell.textContent = String(days);
          overdueCell.textContent = overdue ? String(overdue) : '–';
          interestCell.textContent = interest ? formatEuro(interest) : '–';
          if (interest) {
            interestCell.style.fontWeight = '600';
            flash(interestCell);
          }
          results.push({ status: 'paid', receipt, customer: pay.customer, voucherDate, netAmount, base, paidAt: pay.paidAt, days, overdue, interest });
        } catch (e) {
          paidCell.textContent = '❌';
          paidCell.title = String(e.message || e);
          console.log(`[TaxAdvisor] Zinsen: ${receipt}: ${e.message || e}`);
          results.push({ status: 'error', receipt, customer: '', voucherDate, netAmount, paidAt: null, interest: 0, note: `Fehler: ${e.message || e}` });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // Total in the "Summe Umsätze" row
    const total = Math.round(results.reduce((sum, r) => sum + r.interest, 0) * 100) / 100;
    const sumRow = Array.from(table.querySelectorAll('tbody tr')).find((tr) => /summe umsätze/i.test(tr.textContent));
    const sumCells = sumRow ? ourCells(sumRow) : [];
    if (sumCells[3]) {
      sumCells[3].textContent = formatEuro(total);
      sumCells[3].style.fontWeight = '700';
      flash(sumCells[3]);
    }

    // Table order (workers finish in any order)
    results.sort((a, b) => (a.voucherDate - b.voucherDate) || a.receipt.localeCompare(b.receipt));

    const report = {
      account: document.querySelector('h1:not(.grld-print-only-visible)')?.textContent.trim() || '',
      reviewed: getItemRows().length,
      target: rows.length,
      paid: results.filter((r) => r.status === 'paid').length,
      open: results.filter((r) => r.status === 'open').length,
      errors: results.filter((r) => r.status === 'error').length,
      withInterest: results.filter((r) => r.interest > 0).length,
      total,
      durationMs: Date.now() - startedAt,
      results,
    };
    console.log(`[TaxAdvisor] Zinsen: reviewed ${report.reviewed}, ${TARGET_TEXT} ${report.target}, paid ${report.paid}, open ${report.open}, errors ${report.errors}, total ${formatEuro(total)}`);
    showSummary(report);
  }

  // ---------- Report ----------

  const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // CSV for Excel (German locale): ";" separator, decimal comma, UTF-8 BOM for umlauts
  function toCsv(headers, rows) {
    const quote = (v) => {
      const text = String(v ?? '');
      return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return '\uFEFF' + [headers, ...rows].map((r) => r.map(quote).join(';')).join('\r\n');
  }

  function exportCsv(report) {
    const num = (n) => (typeof n === 'number' ? n.toFixed(2).replace('.', ',') : '');
    const csv = toCsv(
      ['Belegdatum', 'Beleg', 'Kunde', 'Bezahlt am', 'Tage', 'Überfällig', 'Zinsen'],
      report.results.map((r) => [
        formatDate(r.voucherDate), r.receipt, r.customer, formatDate(r.paidAt),
        r.status === 'paid' ? r.days : '', r.status === 'paid' ? r.overdue : '', r.status === 'paid' ? num(r.interest) : '',
      ]),
    );
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const accountNo = report.account.match(/\d+/)?.[0] || 'konto';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `zinsen_${accountNo}_${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    console.log(`[TaxAdvisor] Zinsen CSV downloaded: ${a.download}`);
  }

  function showSummary(report) {
    const totalSec = Math.round(report.durationMs / 1000);
    const duration = totalSec >= 60 ? `${Math.floor(totalSec / 60)} min ${totalSec % 60} s` : `${(report.durationMs / 1000).toFixed(1)} s`;
    const stat = (label, value, color) => `
      <div style="flex:1;min-width:120px;border:1px solid #e0e0e0;border-radius:6px;padding:12px;text-align:center;">
        <div style="font-size:28px;font-weight:700;color:${color};">${value}</div>
        <div style="color:#555;font-size:13px;">${label}</div>
      </div>`;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);' +
      'display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:24px 28px;width:min(820px,92vw);box-shadow:0 8px 32px rgba(0,0,0,0.3);color:#222;">
        <h2 style="margin:0 0 4px;font-size:22px;">Zinsen calculated</h2>
        <p style="margin:0 0 16px;color:#555;">${escapeHtml(report.account)} · ${INTEREST_RATE * 100} % p.a. after ${PAYMENT_TERM_DAYS} days · base: ${INTEREST_BASE === 'gross' ? 'gross' : 'net (Haben)'}</p>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
          ${stat('Rows reviewed', report.reviewed, '#1976d2')}
          ${stat(escapeHtml(TARGET_TEXT), report.target, '#1565c0')}
          ${stat('Paid', report.paid, '#0e9e57')}
          ${stat('Offen', report.open, '#ef6c00')}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px;">
          ${stat('With Zinsen', report.withInterest, '#6a1b9a')}
          ${stat('Total Zinsen', escapeHtml(formatEuro(report.total)), '#6a1b9a')}
          ${stat('Errors', report.errors, report.errors ? '#c62828' : '#9e9e9e')}
          ${stat('Time', duration, '#455a64')}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button data-export style="padding:8px 20px;border:1px solid #1565c0;border-radius:4px;background:#fff;background-image:none;color:#1565c0;cursor:pointer;font-weight:600;">Export to CSV</button>
          <button data-close style="padding:8px 20px;border:none;border-radius:4px;background:#1565c0;background-image:none;color:#fff;cursor:pointer;font-weight:600;">Close</button>
        </div>
      </div>`;

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-export]')) return exportCsv(report);
      if (e.target === overlay || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close]').focus();
  }

  // ---------- Button ----------

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = BUTTON_LABEL;
    btn.style.cssText = [
      `background-color:${BUTTON_COLOR}`,
      'background-image:none', // Lexware's global button style adds a grey glass image
      'text-shadow:none',
      `border:1px solid ${BUTTON_COLOR}`,
      'color:#fff',
      'border-radius:4px',
      'padding:0 16px',
      'height:32px',
      'font-size:13px',
      'font-family:inherit',
      'font-weight:600',
      'cursor:pointer',
      'white-space:nowrap',
      'flex:0 0 auto',
    ].join(';');
    btn.addEventListener('mouseenter', () => (btn.style.backgroundColor = BUTTON_HOVER_COLOR));
    btn.addEventListener('mouseleave', () => (btn.style.backgroundColor = BUTTON_COLOR));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      calculateZinsen();
    });
    return btn;
  }

  function addButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (!isAccountStatementPage()) {
      existing?.remove(); // hash navigation to another page: keep the button off it
      return;
    }
    const toolbar = getToolbar(); // also re-positions it when the account name changes
    if (!toolbar || existing) return;

    toolbar.appendChild(createButton());
    console.log('[TaxAdvisor] Calculate Zinsen button added');
  }

  // Page renders asynchronously and navigates via the URL hash
  const observer = new MutationObserver(addButton);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', addButton);
  addButton();
})();
