// ==UserScript==
// @name         Lexware Account Change - TaxAdvisor
// @namespace    tax-advisor
// @version      0.8.2
// @description  Adds "Start Changing Account" button to Lexware Kontoauszug (AccountStatement) page
// @match        https://app.lexware.de/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'tax-advisor-account-change';
  const BUTTON_LABEL = 'Start Changing Account';
  const VERSION = '0.8.2';

  // Rows whose Gegenkonto equals this account are selected
  const TARGET_ACCOUNT = '10001';
  // Pause between actions on a matching row; increase for debugging
  const STEP_DELAY_MS = 250;
  // Short pause per non-matching row, so the reviewer can follow the scan
  const ROW_DELAY_MS = 50;
  // Konto (Kategorisierung) is changed to this account on vouchers with "zu erhalten"
  const NEW_ACCOUNT = '4830';
  const ACCOUNT_FIELD_ID = 'editor_category_0_field';
  // Bearbeiten: wait before the first click, wait per attempt, number of attempts, backoff step
  const EDIT_CLICK_DELAY_MS = 1000;
  const EDIT_OPEN_TIMEOUT_MS = 6000;
  const EDIT_ATTEMPTS = 3;
  const EDIT_BACKOFF_MS = 2000;
  // Stop after this many saved vouchers. Infinity = no limit; set a number to test.
  const MAX_SAVES = Infinity;
  // Pause after a voucher is finished, before the window is emptied
  const VOUCHER_VIEW_MS = 300;
  // Blink duration for elements the script detects or clicks
  const BLINK_MS = 400;

  const HIGHLIGHT = {
    current: 'rgba(255, 213, 79, 0.45)', // yellow: being checked
    done: 'rgba(129, 199, 132, 0.35)', // green: Gegenkonto matched, row selected
  };

  // Log to the console and keep the last lines in localStorage, so a run can be analysed
  // even after the console was cleared (read with: localStorage.getItem('taxAdvisorAccountChangeLog'))
  const LOG_KEY = 'taxAdvisorAccountChangeLog';
  const LOG_MAX_LINES = 2000;
  function log(...args) {
    console.log(...args);
    try {
      const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      const lines = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      lines.push(`${new Date().toISOString()} ${text}`);
      localStorage.setItem(LOG_KEY, JSON.stringify(lines.slice(-LOG_MAX_LINES)));
    } catch (e) {
      // storage full or unavailable: console only
    }
  }

  log('[TaxAdvisor] Account Change script v' + VERSION + ' loaded');

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

  // ---------- Highlighting (same approach as lexware-mahnung.user.js) ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(findFn, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = findFn();
      if (result) return result;
      await sleep(100);
    }
    return null;
  }

  // Web Animations API, not a <style> tag: Lexware disables stylesheets it does not own
  const BLINK_KEYFRAMES = [
    { backgroundColor: 'rgba(233, 30, 99, 0.55)', outline: '2px solid rgba(233, 30, 99, 1)' },
    { backgroundColor: 'rgba(233, 30, 99, 0)', outline: '2px solid rgba(233, 30, 99, 0)' },
    { backgroundColor: 'rgba(233, 30, 99, 0.55)', outline: '2px solid rgba(233, 30, 99, 1)' },
  ];
  const blink = (el) => el.animate(BLINK_KEYFRAMES, { duration: BLINK_MS / 4, iterations: 4 });

  // Blink an element (pink) for BLINK_MS: shows what the script detected or is about to click
  async function flash(el) {
    if (!el) return;
    await blink(el).finished.catch(() => {});
  }

  // Full mouse sequence, like a real user click
  function simulateUserClick(el) {
    const view = el.ownerDocument.defaultView; // element may live in the voucher window
    const opts = { bubbles: true, cancelable: true, view, button: 0 };
    el.dispatchEvent(new view.PointerEvent('pointerdown', opts));
    el.dispatchEvent(new view.MouseEvent('mousedown', opts));
    el.dispatchEvent(new view.PointerEvent('pointerup', opts));
    el.dispatchEvent(new view.MouseEvent('mouseup', opts));
    el.dispatchEvent(new view.MouseEvent('click', opts));
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

  const setRowColor = (row, color) => row.querySelectorAll('td').forEach((td) => (td.style.backgroundColor = color));

  // Stable key per row: the accountingRecordId from the row's href, else its text.
  // Rows are tracked by key, not by position: a saved booking leaves account 1370 and its
  // row can disappear, which would make position-based iteration skip its neighbours.
  const rowKey = (row) => row.getAttribute('href')?.match(/AccountStatement\/([\w-]+)/i)?.[1]
    || row.textContent.replace(/\s+/g, ' ').trim();
  const findRowByKey = (key) => getItemRows().find((r) => rowKey(r) === key) || null;

  // ---------- Voucher window ----------
  // One extra browser window, opened on the button click (pop-up blockers only allow
  // window.open directly in a user click) and reused for every voucher.

  function openVoucherWindow() {
    const width = Math.round(screen.availWidth * 0.5);
    const features = `popup,width=${width},height=${screen.availHeight},left=${screen.availWidth - width},top=0`;
    return window.open('about:blank', 'taxAdvisorVoucher', features);
  }

  function findVoucherLink() {
    // Voucher preview in the right detail panel: <a href="vouchers#!/VoucherView/...">
    return document.querySelector('.grld-component-detail-view-scroll a[href*="VoucherView"]');
  }

  // Load url in the voucher window and wait until the page is ready (same origin: readable)
  async function loadInVoucherWindow(win, url) {
    win.location.href = url;
    return !!(await waitFor(() => {
      try {
        return win.location.href === url && win.document.readyState === 'complete' && win.document.querySelector('h1');
      } catch (e) {
        return false; // window is between two pages
      }
    }, 20000));
  }

  // ---------- Inside the voucher window ----------

  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  function findToReceive(doc) {
    // Right info panel, "Zahlungen" section: "zu erhalten   39,00 €"
    return Array.from(doc.querySelectorAll('span, div, dt, td, label, p'))
      .find((el) => el.children.length === 0 && normalizeText(el) === 'zu erhalten' && isVisible(el));
  }

  function findEditButton(win) {
    const doc = win.document;
    const candidates = Array.from(doc.querySelectorAll('a, button, [role="button"], [ng-click]')).filter(isVisible);
    const label = (el) => [el.textContent, el.getAttribute('title'), el.getAttribute('aria-label'),
      el.getAttribute('uib-tooltip'), el.getAttribute('lx-tooltip-content'), el.getAttribute('data-original-title')]
      .filter(Boolean).join(' ').toLowerCase();

    // 1. Visible text or tooltip "Bearbeiten"
    const byLabel = candidates.find((el) => /bearbeiten/.test(label(el)));
    if (byLabel) return byLabel;

    // 2. Toolbar action whose Angular scope names it "Bearbeiten" / edit (icon-only buttons)
    const ng = win.angular;
    if (ng) {
      const byScope = candidates.find((el) => {
        const action = ng.element(el).scope()?.secAction;
        return action && /bearbeiten|edit/i.test(JSON.stringify(action, (k, v) => (k.startsWith('$') ? undefined : v)) || '');
      });
      if (byScope) return byScope;
    }

    // 3. Pencil / edit icon
    return candidates.find((el) => el.querySelector('[class*="pencil"], [class*="edit"]')) || null;
  }

  function logEditCandidates(win) {
    const items = Array.from(win.document.querySelectorAll('a, button, [ng-click]')).filter(isVisible).slice(0, 25)
      .map((el) => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 30), cls: String(el.className).slice(0, 60),
        icon: el.querySelector('i, span[class*="icon"]')?.className }));
    log('[TaxAdvisor] "Bearbeiten" not found. Clickable elements in the voucher window:', items);
  }

  // ---------- Edit view (embedded voucher editor) ----------
  // The editor is an iframe (/capsa/voucher-editor-embeddable) inside the shadow root of <lx-include>.

  function findEditorDoc(win) {
    try {
      const frame = Array.from(win.document.querySelectorAll('lx-include'))
        .map((host) => host.shadowRoot?.querySelector('iframe[src*="voucher-editor"]'))
        .find(Boolean);
      const doc = frame?.contentDocument;
      return doc?.getElementById(ACCOUNT_FIELD_ID) ? doc : null;
    } catch (e) {
      return null;
    }
  }

  // Type into a React-controlled input: native setter + input event, like real typing
  function setReactInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
  }

  const visibleIn = (doc, selector) => Array.from(doc.querySelectorAll(selector)).filter(isVisible);

  // Konto: empty -> type NEW_ACCOUNT -> pick the suggestion with "(NEW_ACCOUNT)".
  // Returns { ok, reason?, oldAccount, newAccount? }
  async function changeAccount(doc, receipt) {
    if (doc.getElementById('editor_category_1_field')) {
      log(`[TaxAdvisor] ${receipt}: several Konto lines (split amount), skipping`);
      return { ok: false, reason: 'Several Konto lines (split amount)' };
    }
    const input = doc.getElementById(ACCOUNT_FIELD_ID);
    const oldAccount = input.value;
    await flash(input.closest('.MuiAutocomplete-root') || input);
    log(`[TaxAdvisor] ${receipt}: Konto is "${oldAccount}"`);
    if (oldAccount.includes(`(${NEW_ACCOUNT})`)) {
      log(`[TaxAdvisor] ${receipt}: Konto is already ${NEW_ACCOUNT}, nothing to save`);
      return { ok: false, reason: `Konto is already ${NEW_ACCOUNT}`, oldAccount };
    }

    // Empty the field with the X (Leeren) button, else clear the text
    const clearBtn = input.closest('.MuiAutocomplete-root')?.querySelector('button[aria-label="Leeren"]');
    input.focus();
    if (clearBtn) clearBtn.click();
    if (input.value) setReactInputValue(input, '');
    await sleep(STEP_DELAY_MS);

    input.focus();
    setReactInputValue(input, NEW_ACCOUNT);
    const option = await waitFor(() => {
      const options = visibleIn(doc, '[role="option"]');
      return options.find((o) => o.textContent.includes(`(${NEW_ACCOUNT})`))
        || options.find((o) => o.textContent.includes(NEW_ACCOUNT));
    }, 5000);
    if (!option) {
      log(`[TaxAdvisor] ${receipt}: no suggestion for ${NEW_ACCOUNT}`);
      return { ok: false, reason: `No suggestion for ${NEW_ACCOUNT}`, oldAccount };
    }
    await flash(option);
    option.click(); // same as a user click on the suggestion
    const selected = await waitFor(() => input.value.includes(NEW_ACCOUNT), 3000);
    log(selected ? `[TaxAdvisor] ${receipt}: Konto set to "${input.value}"` : `[TaxAdvisor] ${receipt}: Konto not set`);
    return selected
      ? { ok: true, oldAccount, newAccount: input.value }
      : { ok: false, reason: 'Konto could not be set', oldAccount };
  }

  // Split button: arrow (openMenuButton) -> menu item "Speichern + Schließen".
  // Returns { ok, reason? }; ok = the editor closed, i.e. saved.
  async function saveAndClose(win, doc, receipt) {
    const arrow = doc.querySelector('[data-testid="openMenuButton"]');
    if (!arrow) {
      log(`[TaxAdvisor] ${receipt}: save menu arrow not found`);
      return { ok: false, reason: 'Save menu arrow not found' };
    }
    await flash(arrow);
    arrow.click();
    // Menu entries: "Speichern + Neu", "Speichern + Schließen" (data-testid = label)
    const item = await waitFor(() => visibleIn(doc, '[data-testid="Speichern + Schließen"]')[0]
      || visibleIn(doc, '[role="menuitem"]').find((el) => /speichern\s*\+\s*schlie(ß|ss)en/i.test(el.textContent)), 3000);
    if (!item) {
      log(`[TaxAdvisor] ${receipt}: "Speichern + Schließen" not found in the menu`,
        visibleIn(doc, '[role="menuitem"]').map((el) => el.textContent.trim()));
      return { ok: false, reason: '"Speichern + Schließen" not in the menu' };
    }
    await flash(item);
    item.click(); // same as a user click on "Speichern + Schließen"
    const closed = await waitFor(() => !findEditorDoc(win), 15000);
    log(closed ? `[TaxAdvisor] ${receipt}: saved (Speichern + Schließen)` : `[TaxAdvisor] ${receipt}: editor still open after saving`);
    return closed ? { ok: true } : { ok: false, reason: 'Editor still open after saving' };
  }

  // Press Bearbeiten until the edit view appears: the voucher page is often not ready for the
  // first click although it looks loaded. Returns the editor document, null, or 'no-button'.
  async function openEditView(win, receipt) {
    await sleep(EDIT_CLICK_DELAY_MS);
    for (let attempt = 1; attempt <= EDIT_ATTEMPTS; attempt++) {
      if (findEditorDoc(win)) return findEditorDoc(win); // opened late from the previous click
      const editBtn = findEditButton(win);
      if (!editBtn) {
        logEditCandidates(win);
        return 'no-button';
      }
      await flash(editBtn);
      simulateUserClick(editBtn);
      log(`[TaxAdvisor] ${receipt}: Bearbeiten pressed (attempt ${attempt}/${EDIT_ATTEMPTS})`,
        { tag: editBtn.tagName, cls: String(editBtn.className).slice(0, 60), text: editBtn.textContent.trim().slice(0, 30) });
      const doc = await waitFor(() => findEditorDoc(win), EDIT_OPEN_TIMEOUT_MS);
      if (doc) return doc;
      log(`[TaxAdvisor] ${receipt}: edit view did not open, retrying in ${attempt * EDIT_BACKOFF_MS} ms`);
      await sleep(attempt * EDIT_BACKOFF_MS); // backoff: 2 s, 4 s, ...
    }
    return findEditorDoc(win); // last chance: it may have opened during the final backoff
  }

  // Returns { ok, reason?, oldAccount?, newAccount? }; ok = voucher saved with the new Konto
  async function handleVoucher(win, receipt) {
    const toReceive = await waitFor(() => findToReceive(win.document), 5000);
    if (!toReceive) {
      log(`[TaxAdvisor] ${receipt}: no "zu erhalten" in the voucher, skipping`);
      return { ok: false, reason: 'No "zu erhalten" in the voucher' };
    }
    await flash(toReceive);
    log(`[TaxAdvisor] ${receipt}: "zu erhalten" found`);
    await sleep(STEP_DELAY_MS);

    const doc = await openEditView(win, receipt);
    if (doc === 'no-button') return { ok: false, reason: '"Bearbeiten" button not found' };
    if (!doc) return { ok: false, reason: `Edit view did not open after ${EDIT_ATTEMPTS} attempts` };
    await sleep(STEP_DELAY_MS);
    // Not saved: the window is emptied afterwards, so the change is discarded
    const changed = await changeAccount(doc, receipt);
    if (!changed.ok) return changed;
    await sleep(STEP_DELAY_MS);
    const savedResult = await saveAndClose(win, doc, receipt);
    return { ...savedResult, oldAccount: changed.oldAccount, newAccount: changed.newAccount };
  }

  async function processRows(voucherWin) {
    const accountCol = getColumnIndex('Gegenkonto');
    const receiptCol = getColumnIndex('Beleg');
    const dateCol = getColumnIndex('Belegdatum');
    const textCol = getColumnIndex('Text');
    const creditCol = getColumnIndex('Haben');
    const seen = new Set();
    const saved = [];
    const skipped = [];
    let matched = 0;
    let lastVoucherUrl = null;
    const result = (stopReason) => ({ saved, skipped, checked: seen.size, matched, stopReason });

    if (accountCol < 0) {
      log('[TaxAdvisor] Column "Gegenkonto" not found');
      return result('Column "Gegenkonto" not found');
    }
    log(`[TaxAdvisor] ${getItemRows().length} rows, looking for Gegenkonto ${TARGET_ACCOUNT}`);

    while (true) {
      const row = getItemRows().find((r) => !seen.has(rowKey(r)));
      if (!row) break;
      const key = rowKey(row);
      seen.add(key);
      const cells = row.children;
      const accountCell = cells[accountCol];
      const cellText = (i) => (i >= 0 ? cells[i]?.textContent.replace(/\u00A0/g, ' ').trim() || '' : '');
      const receipt = cellText(receiptCol);
      const item = { receipt, date: cellText(dateCol), text: cellText(textCol), amount: cellText(creditCol) };
      const skip = (reason) => {
        item.skipReason = reason;
        skipped.push(item);
      };

      row.scrollIntoView({ block: 'center' });
      setRowColor(row, HIGHLIGHT.current);

      if (accountCell?.textContent.trim() !== TARGET_ACCOUNT) {
        setRowColor(row, '');
        await sleep(ROW_DELAY_MS);
        continue;
      }

      matched++;
      log(`[TaxAdvisor] #${seen.size} ${receipt}: Gegenkonto ${TARGET_ACCOUNT} -> selecting row`);
      await flash(accountCell);
      await sleep(STEP_DELAY_MS);

      simulateUserClick(accountCell); // bubbles to the row's ui-sref click handler, like a user click
      const selected = await waitFor(() => findRowByKey(key)?.classList.contains('active'), 5000);
      const current = findRowByKey(key);
      if (current) setRowColor(current, HIGHLIGHT.done);
      log(selected ? `[TaxAdvisor] ${receipt} selected` : `[TaxAdvisor] ${receipt}: row did not become active`);

      // The detail panel updates after the selection: wait for this booking's voucher link
      const link = await waitFor(() => {
        const a = findVoucherLink();
        return a && a.href !== lastVoucherUrl ? a : null;
      }, 5000) || findVoucherLink();
      if (!link) {
        log(`[TaxAdvisor] ${receipt}: no voucher link in the detail panel, skipping`);
        skip('No voucher link in the detail panel');
        await sleep(STEP_DELAY_MS);
        continue;
      }
      await flash(link);

      if (voucherWin.closed) {
        log('[TaxAdvisor] Voucher window was closed, stopping');
        return result('Voucher window was closed');
      }
      lastVoucherUrl = link.href;
      const loaded = await loadInVoucherWindow(voucherWin, link.href);
      log(loaded ? `[TaxAdvisor] ${receipt}: voucher opened` : `[TaxAdvisor] ${receipt}: voucher did not load in time`);

      if (!loaded) {
        skip('Voucher did not load in time');
      } else {
        let outcome;
        try {
          outcome = await handleVoucher(voucherWin, receipt);
        } catch (e) {
          // Never let one voucher end the whole run: record it and continue with the next row
          log(`[TaxAdvisor] ${receipt}: ERROR ${e && e.stack || e}`);
          outcome = { ok: false, reason: `Script error: ${e && e.message || e}` };
        }
        if (outcome.ok) {
          Object.assign(item, { oldAccount: outcome.oldAccount, newAccount: outcome.newAccount });
          saved.push(item);
        } else {
          skip(outcome.reason || 'Unknown reason');
          if (outcome.oldAccount) item.oldAccount = outcome.oldAccount;
        }
      }
      await sleep(VOUCHER_VIEW_MS);
      if (!voucherWin.closed) voucherWin.location.href = 'about:blank'; // "close" it until the next voucher

      if (saved.length >= MAX_SAVES) {
        log(`[TaxAdvisor] Stopped: reached the limit of ${MAX_SAVES} saved vouchers`);
        return result(`Reached the limit of ${MAX_SAVES} saved vouchers`);
      }
      await sleep(STEP_DELAY_MS);
    }

    return result('All rows on this page were checked');
  }

  // ---------- Report ----------

  const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // CSV for Excel (German locale): ";" separator, UTF-8 BOM for umlauts
  function toCsv(headers, rows) {
    const quote = (v) => {
      const text = String(v ?? '');
      return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return '\uFEFF' + [headers, ...rows].map((r) => r.map(quote).join(';')).join('\r\n');
  }

  function downloadFile(filename, content) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function downloadReportCsv({ saved, skipped }) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;

    downloadFile(`account-change-saved_${stamp}.csv`, toCsv(
      ['Belegdatum', 'Beleg', 'Text', 'Betrag', 'Konto alt', 'Konto neu'],
      saved.map((i) => [i.date, i.receipt, i.text, i.amount, i.oldAccount, i.newAccount]),
    ));
    await sleep(500); // two downloads in a row: give the browser a moment between them
    downloadFile(`account-change-skipped_${stamp}.csv`, toCsv(
      ['Belegdatum', 'Beleg', 'Text', 'Betrag', 'Konto alt', 'Grund'],
      skipped.map((i) => [i.date, i.receipt, i.text, i.amount, i.oldAccount, i.skipReason]),
    ));
    log(`[TaxAdvisor] CSV downloaded: account-change-saved_${stamp}.csv, account-change-skipped_${stamp}.csv`);
  }

  // Final report: stats, saved vouchers, skipped ones with reasons
  function showSummary(report) {
    const { saved, skipped, checked, stopReason, durationMs } = report;
    const totalSec = Math.round(durationMs / 1000);
    const duration = `${Math.floor(totalSec / 60)} min ${totalSec % 60} s`;
    const cell = 'padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top;';
    const head = 'padding:6px 8px;border-bottom:2px solid #ccc;text-align:left;position:sticky;top:0;background:#fff;';
    const table = (headers, rows) => rows.length ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr>${headers.map((h) => `<th style="${head}">${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td style="${cell}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>` : '<p style="color:#777;margin:4px 0 0;">None</p>';
    const stat = (label, value, color) => `
      <div style="flex:1;border:1px solid #e0e0e0;border-radius:6px;padding:12px;text-align:center;">
        <div style="font-size:32px;font-weight:700;color:${color};">${value}</div>
        <div style="color:#555;">${label}</div>
      </div>`;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);' +
      'display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:24px 28px;width:min(1000px,92vw);max-height:88vh;
                  display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);color:#222;">
        <h2 style="margin:0 0 4px;font-size:22px;">Account Change finished</h2>
        <p style="margin:0 0 16px;color:#555;">${escapeHtml(stopReason)}</p>
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          ${stat(`Saved (Konto ${NEW_ACCOUNT})`, saved.length, '#0e9e57')}
          ${stat('Skipped', skipped.length, '#757575')}
          ${stat('Rows checked', checked, '#1976d2')}
          ${stat('Time', duration, '#6a1b9a')}
        </div>
        <div style="overflow:auto;flex:1;">
          <h3 style="margin:8px 0 4px;font-size:16px;">Saved (${saved.length})</h3>
          ${table(['Belegdatum', 'Beleg', 'Betrag', 'Konto alt', 'Konto neu'],
            saved.map((i) => [i.date, i.receipt, i.amount, i.oldAccount, i.newAccount]))}
          <h3 style="margin:16px 0 4px;font-size:16px;">Skipped (${skipped.length})</h3>
          ${table(['Belegdatum', 'Beleg', 'Betrag', 'Grund'],
            skipped.map((i) => [i.date, i.receipt, i.amount, i.skipReason]))}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button data-download style="padding:8px 20px;border:1px solid #0e9e57;border-radius:4px;background:#fff;background-image:none;color:#0e9e57;cursor:pointer;font-weight:600;">Download CSV</button>
          <button data-close style="padding:8px 20px;border:none;border-radius:4px;background:#0e9e57;background-image:none;color:#fff;cursor:pointer;font-weight:600;">Close</button>
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
      if (e.target.closest('[data-download]')) return downloadReportCsv(report);
      if (e.target === overlay || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-close]').focus();
  }

  let running = false;

  async function startChangingAccount() {
    if (running) {
      log('[TaxAdvisor] Already running');
      return;
    }
    // Must happen synchronously in the click, before any await, or the pop-up blocker stops it
    const voucherWin = openVoucherWindow();
    if (!voucherWin) {
      alert('Please allow pop-ups for app.lexware.de, then press "Start Changing Account" again.');
      return;
    }
    running = true;
    try {
      log('[TaxAdvisor] Start Changing Account clicked');
      window.focus(); // keep the Kontoauszug in front so its timers are not throttled
      const startedAt = Date.now();
      let report;
      try {
        report = await processRows(voucherWin);
      } catch (e) {
        log(`[TaxAdvisor] Run aborted: ${e && e.stack || e}`);
        report = { saved: [], skipped: [], checked: 0, matched: 0, stopReason: `Run aborted by a script error: ${e && e.message || e}` };
      }
      report.durationMs = Date.now() - startedAt;
      log(`[TaxAdvisor] Finished: ${report.stopReason}. Saved ${report.saved.length}, skipped ${report.skipped.length}, rows checked ${report.checked}`);
      showSummary(report);
    } finally {
      running = false;
      if (!voucherWin.closed) voucherWin.close();
    }
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = BUTTON_LABEL;
    btn.style.cssText = [
      'background-color:#d32f2f',
      'background-image:none', // Lexware's global button style adds a grey glass image
      'text-shadow:none',
      'border:1px solid #d32f2f',
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
    btn.addEventListener('mouseenter', () => (btn.style.backgroundColor = '#b71c1c'));
    btn.addEventListener('mouseleave', () => (btn.style.backgroundColor = '#d32f2f'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startChangingAccount();
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
    log('[TaxAdvisor] Start Changing Account button added');
  }

  // Page renders asynchronously and navigates via the URL hash
  const observer = new MutationObserver(addButton);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', addButton);
  addButton();
})();
