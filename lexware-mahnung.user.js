// ==UserScript==
// @name         Lexware Mahnung Automation - TaxAdvisor
// @namespace    tax-advisor
// @version      0.8.1
// @description  Adds "Start Mahnung Automation" button to Lexware Finanzen page
// @match        https://app.lexware.de/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'tax-advisor-mahnung-automation';
  const BUTTON_LABEL = 'Start Mahnung Automation';
  const VERSION = '0.8.1';

  // Pause between automation steps (tab, filter, rows, panel). Increase for debugging.
  const STEP_DELAY_MS = 500;
  // Number of assignments (Zuordnen with Mahngebühr) for the "Test run" option in the start dialog
  const TEST_ASSIGNMENTS = 3;
  // Blink duration for elements the script reads or clicks (so a reviewer can follow it)
  const BLINK_MS = 600;
  // Max wait for the voucher list in the "Umsatz zuordnen" panel; empty after that = no match
  const PANEL_LIST_TIMEOUT_MS = 5000;
  // Max wait for "Zu viel erhalten" after ticking the voucher; not shown after that = skip
  const SUMMARY_TIMEOUT_MS = 3000;
  // Overpayment amounts (EUR) that mean the customer paid a Mahnung fee
  const MAHNUNG_FEES = [2.9, 5];
  // Rows with these names (sender/recipient) are skipped right away, case-insensitive
  const SKIP_NAMES = ['Deutsche Flotten Dienstleistungen GmbH'];

  console.log('[TaxAdvisor] Mahnung script v' + VERSION + ' loaded');

  function isTransactionsPage() {
    return location.pathname.startsWith('/fis/app/transactions');
  }

  function findRefreshButton() {
    return Array.from(document.querySelectorAll('button'))
      .find((btn) => btn.textContent.replace(/\u200B/g, '').trim().toLowerCase() === 'aktualisieren');
  }

  // Classes MUI adds while the refresh button is syncing; they make the text transparent
  const STATE_CLASSES = ['Mui-disabled', 'MuiButton-loading', 'MuiButton-loadingPositionCenter'];

  function setLabel(btn, label) {
    // Button colors come from the MUI classes; only text and sizing are set here
    const span = document.createElement('span');
    span.textContent = label;
    span.style.whiteSpace = 'nowrap';
    btn.replaceChildren(span);
    btn.style.width = 'auto';
    btn.style.minWidth = 'auto';
    btn.style.backgroundColor = '#d32f2f';
    btn.style.borderColor = '#d32f2f';
    btn.style.color = '#fff';
    btn.addEventListener('mouseenter', () => (btn.style.backgroundColor = '#b71c1c'));
    btn.addEventListener('mouseleave', () => (btn.style.backgroundColor = '#d32f2f'));
  }

  function normalizeText(el) {
    return el.textContent.replace(/\u200B/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function findAssignTab() {
    // Filter tab "Umsätze zuordnen 291" above the transactions list
    return Array.from(document.querySelectorAll('button'))
      .find((btn) => normalizeText(btn).startsWith('umsätze zuordnen'));
  }

  async function selectAssignTab() {
    const tab = findAssignTab();
    if (!tab) {
      console.log('[TaxAdvisor] "Umsätze zuordnen" tab not found');
      return false;
    }
    if (tab.getAttribute('aria-pressed') === 'true') {
      console.log('[TaxAdvisor] "Umsätze zuordnen" tab already selected');
      return true;
    }
    await flash(tab);
    tab.click(); // same as a user click, triggers Lexware's own handler
    console.log('[TaxAdvisor] "Umsätze zuordnen" tab selected');
    return true;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Blink keyframes. Uses the Web Animations API, not a <style> tag: Lexware disables
  // stylesheets it does not own, so CSS classes stop working.
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

  // Range covering `text` inside el (can span several text nodes); whole element text if text is empty
  function findTextRange(el, text) {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    let full = '';
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: full.length });
      full += node.nodeValue;
    }
    if (!nodes.length) return null;
    const norm = (t) => t.replace(/\u00A0/g, ' ');
    const start = text ? norm(full).indexOf(norm(text)) : 0;
    if (start < 0) return null;
    const end = text ? start + text.length : full.length;
    const locate = (pos) => {
      const n = nodes.filter((x) => x.start <= pos).pop();
      return [n.node, Math.min(pos - n.start, n.node.nodeValue.length)];
    };
    const range = document.createRange();
    range.setStart(...locate(start));
    range.setEnd(...locate(end));
    return range;
  }

  // Blink only the given texts (all at the same time), without changing Lexware's DOM:
  // pink boxes are drawn on top of the text's screen position (CSS.highlights does not
  // paint from Tampermonkey's isolated script context).
  // targets: [{ el, text }]; text omitted = the element's whole text
  async function flashText(targets) {
    const ranges = targets.filter((t) => t.el).map((t) => findTextRange(t.el, t.text)).filter(Boolean);
    if (ranges.length < targets.length) {
      console.log('[TaxAdvisor] flashText: text not found for', targets.filter((t) => t.el && !findTextRange(t.el, t.text)).map((t) => t.text || t.el.textContent));
    }
    if (!ranges.length) return;

    // Re-position every frame: the text may still move (row scrolling into view, panel sliding in)
    const boxes = [];
    let running = true;
    const update = () => {
      const rects = ranges.flatMap((range) => Array.from(range.getClientRects()));
      while (boxes.length < rects.length) {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;z-index:2147483001;pointer-events:none;border-radius:2px;';
        document.body.appendChild(box);
        blink(box);
        boxes.push(box);
      }
      boxes.forEach((box, i) => {
        const rect = rects[i];
        box.style.display = rect ? '' : 'none';
        if (!rect) return;
        box.style.left = `${rect.left - 2}px`;
        box.style.top = `${rect.top - 1}px`;
        box.style.width = `${rect.width + 4}px`;
        box.style.height = `${rect.height + 2}px`;
      });
      if (running) requestAnimationFrame(update);
    };
    update();
    await sleep(BLINK_MS);
    running = false;
    boxes.forEach((box) => box.remove());
  }


  async function waitFor(findFn, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = findFn();
      if (el) return el;
      await sleep(100);
    }
    return null;
  }

  function findTypeSelect() {
    // MUI Select "Umsatztyp" (role=combobox), identified by its form label
    return Array.from(document.querySelectorAll('[role="combobox"]')).find((el) => {
      const label = el.closest('.MuiFormControl-root')?.querySelector('label');
      return label && /umsatztyp/i.test(label.textContent);
    });
  }

  function findPositiveOption() {
    return Array.from(document.querySelectorAll('[role="option"]'))
      .find((opt) => /^positive ums/.test(normalizeText(opt)));
  }

  async function selectPositiveType() {
    const select = findTypeSelect();
    if (!select) {
      console.log('[TaxAdvisor] "Umsatztyp" dropdown not found');
      return false;
    }
    if (/positive ums/.test(normalizeText(select))) {
      console.log('[TaxAdvisor] "Positive Umsätze" already selected');
      return true;
    }

    // MUI Select opens on mousedown, not on click
    await flash(select);
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));

    const option = await waitFor(findPositiveOption);
    if (!option) {
      console.log('[TaxAdvisor] "Positive Umsätze" option not found');
      return false;
    }
    await flash(option);
    option.click();
    console.log('[TaxAdvisor] "Positive Umsätze" selected');

    // Close the menu if it stays open (multi-select)
    await sleep(200);
    const listbox = document.querySelector('[role="listbox"]');
    if (listbox) listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }

  // Invoice number like 2026-006583 (not part of a longer number)
  const INVOICE_REGEX = /(?<!\d)202\d-\d{6}(?!\d)/g;

  const HIGHLIGHT = {
    current: 'rgba(255, 213, 79, 0.45)', // yellow: being processed
    eligible: 'rgba(129, 199, 132, 0.35)', // green: first panel voucher matches the invoice number
    skipped: 'rgba(189, 189, 189, 0.35)', // grey: skipped (no single invoice number or no matching voucher)
  };

  function getRows() {
    return Array.from(document.querySelectorAll('.MuiDataGrid-main [role="row"].MuiDataGrid-row'));
  }

  function extractItem(row) {
    const cell = (field) => row.querySelector(`[data-field="${field}"]`);
    // recipientOrSenderName cell: <p>name</p> <div><p>date</p><p>purpose</p></div>
    const paragraphs = Array.from(cell('recipientOrSenderName')?.querySelectorAll('p') || []);
    const texts = paragraphs.map((p) => p.textContent.trim());
    const amountText = cell('amount')?.textContent.replace(/\u00A0/g, ' ').trim() || '';
    const purpose = texts[2] || '';
    return {
      id: row.dataset.id,
      account: cell('account')?.querySelector('[aria-label]')?.getAttribute('aria-label') || '',
      name: texts[0] || '',
      date: texts[1] || '',
      purpose,
      purposeEl: paragraphs[2],
      amountText,
      amount: parseFloat(amountText.replace(/[^\d,-]/g, '').replace(',', '.')),
      // "TPR-2026-006094 INV-2026-006094" counts as one invoice number
      invoiceNumbers: [...new Set(purpose.match(INVOICE_REGEX) || [])],
    };
  }

  // Full mouse sequence, like a real user click (some handlers listen to mousedown/pointerdown)
  function simulateUserClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function findAssignPanel() {
    // Right side drawer with title <h2>Umsatz zuordnen</h2>
    return Array.from(document.querySelectorAll('.MuiDrawer-paper[role="dialog"]'))
      .find((el) => /umsatz zuordnen/i.test(el.querySelector('h2')?.textContent || ''));
  }

  function getPanelVouchers(panel) {
    // Suggested vouchers: table rows with data-testid="vouchers-*" fields
    return Array.from(panel.querySelectorAll('tbody tr')).map((tr) => {
      const field = (id) => tr.querySelector(`[data-testid="${id}"]`)?.textContent.replace(/\u00A0/g, ' ').trim() || '';
      return {
        tr,
        numberEl: tr.querySelector('[data-testid="vouchers-number"]'),
        name: field('vouchers-contact-name'),
        number: field('vouchers-number'),
        date: field('vouchers-date'),
        amountText: field('vouchers-amount'),
      };
    }).filter((v) => v.number);
  }

  async function tickVoucher(tr) {
    const checkbox = tr.querySelector('input[type="checkbox"]');
    if (!checkbox || checkbox.checked) return;
    await flash(checkbox.closest('.MuiCheckbox-root'));
    checkbox.click(); // same as a user click on the checkbox
  }

  function parseEuro(text) {
    // "2,90 €" -> 2.9, "1.234,50 €" -> 1234.5
    const value = parseFloat(text.replace(/[^\d,-]/g, '').replace(',', '.'));
    return Number.isNaN(value) ? null : value;
  }

  function findOverpaymentElements(panel) {
    // Label "Zu viel erhalten:" and its amount "2,90 €"
    const label = panel.querySelector('[data-testid="assignment-amount-text"]');
    return { label, amount: label?.parentElement.querySelector('h4:not([data-testid])') };
  }

  function readOverpayment(panel) {
    // Summary under the voucher list: "Zu viel erhalten:" + "2,90 €" + "(14,50%)"
    const label = panel.querySelector('[data-testid="assignment-amount-text"]');
    if (!label || !/zu viel erhalten/i.test(label.textContent)) return null;
    const amount = label.parentElement.querySelector('h4:not([data-testid])');
    return amount ? parseEuro(amount.textContent) : null;
  }

  async function clickZuordnen(panel) {
    // Green Zuordnen in the panel footer (same button position in both steps)
    const btn = Array.from(panel.querySelectorAll('.MuiDialogActions-root button'))
      .find((b) => b.textContent.trim().toLowerCase() === 'zuordnen');
    if (!btn || btn.disabled) {
      console.log('[TaxAdvisor] Zuordnen button not found or disabled');
      return false;
    }
    await flash(btn);
    btn.click(); // same as a user click on the green Zuordnen button
    return true;
  }

  function findDunningRadio(panel) {
    // "Differenz festgestellt" form, option "Mahngebühr"
    return panel.querySelector('input[type="radio"][value="DUNNING_COST"]');
  }

  function findDifferenceText(panel) {
    // "Wie möchtest du mit der Differenz von 2,90 € umgehen?"
    return Array.from(panel.querySelectorAll('p')).find((p) => /differenz von/i.test(p.textContent));
  }

  function readDifference(panel) {
    const text = findDifferenceText(panel)?.textContent;
    const match = text?.replace(/\u00A0/g, ' ').match(/differenz von ([\d.,]+)/i);
    return match ? parseEuro(match[1]) : null;
  }

  const isMahnungFee = (amount) => amount !== null && MAHNUNG_FEES.some((fee) => Math.abs(amount - fee) < 0.005);

  // Zuordnen -> "Differenz festgestellt" -> Mahngebühr -> Zuordnen. Returns true when assigned.
  async function assignWithDunningFee(panel) {
    if (!(await clickZuordnen(panel))) return false;

    const radio = await waitFor(() => findDunningRadio(panel) || (!findAssignPanel() && 'closed'), 10000);
    if (radio === 'closed') {
      console.log('[TaxAdvisor] WARNING: panel closed without "Differenz festgestellt" step');
      return true;
    }
    if (!radio) {
      console.log('[TaxAdvisor] "Differenz festgestellt" did not appear');
      return false;
    }

    const difference = readDifference(panel);
    await flash(findDifferenceText(panel));
    if (!isMahnungFee(difference)) {
      console.log(`[TaxAdvisor] Differenz ${difference} € is not a Mahnung fee, not assigning`);
      return false;
    }
    await sleep(STEP_DELAY_MS);

    await flash(radio.closest('label'));
    radio.click(); // same as a user click on "Mahngebühr"
    console.log(`[TaxAdvisor] Differenz ${difference.toFixed(2)} € -> Mahngebühr selected`);
    await sleep(STEP_DELAY_MS);

    if (!radio.checked || !(await clickZuordnen(panel))) return false;
    const closed = await waitFor(() => !findAssignPanel(), 10000);
    console.log(closed ? '[TaxAdvisor] Assigned with Mahngebühr, panel closed' : '[TaxAdvisor] Zuordnen pressed, panel still open');
    return closed;
  }

  async function closeAssignPanel(panel) {
    const closeBtn = panel.querySelector('button[aria-label="Schließen"]');
    if (!closeBtn) {
      console.log('[TaxAdvisor] Panel close button not found');
      return false;
    }
    await flash(closeBtn);
    closeBtn.click(); // same as a user click on the X
    const closed = await waitFor(() => !findAssignPanel(), 5000);
    console.log(closed ? '[TaxAdvisor] Panel closed' : '[TaxAdvisor] Panel did not close');
    return closed;
  }

  async function openAssignPanel(row) {
    // "Manuell zuordnen" in the Zuordnung column opens the panel
    const cell = row.querySelector('[data-field="assignment"]');
    const target = cell?.querySelector('h4') || cell;
    if (!target) {
      console.log('[TaxAdvisor] Zuordnung cell not found');
      return null;
    }
    await flash(target);
    simulateUserClick(target);
    const panel = await waitFor(findAssignPanel, 5000);
    console.log(panel ? '[TaxAdvisor] "Umsatz zuordnen" panel opened' : '[TaxAdvisor] Panel did not open');
    return panel;
  }

  function getPagerButtons() {
    // Pager of the main transactions grid (not the one inside the assignment panel)
    return Array.from(document.querySelectorAll('.MuiDataGrid-root .MuiDataGrid-footerContainer button'));
  }

  function findNextPageButton() {
    // German label: "Zur nächsten Seite"
    return getPagerButtons()
      .find((btn) => /nächsten? seite|next page/i.test(btn.getAttribute('aria-label') || btn.title || ''));
  }

  async function goToNextPage() {
    const nextBtn = findNextPageButton();
    if (!nextBtn) {
      console.log('[TaxAdvisor] Next page button not found. Pager buttons:',
        getPagerButtons().map((b) => b.getAttribute('aria-label') || b.title || b.textContent.trim()));
      return false;
    }
    if (nextBtn.disabled) {
      console.log('[TaxAdvisor] Last page reached');
      return false;
    }
    await flash(nextBtn);
    const firstIdBefore = getRows()[0]?.dataset.id;
    nextBtn.click(); // same as a user click on the pager arrow
    return !!(await waitFor(() => {
      const firstId = getRows()[0]?.dataset.id;
      return firstId && firstId !== firstIdBefore;
    }, 10000));
  }

  // Options: maxAssignments (number/Infinity), currentPageOnly (only rows visible at start, no paging)
  async function processAllItems({ maxAssignments, currentPageOnly }) {
    const seen = new Set();
    // Rows moving up from the next page after an assignment are ignored in "current page" mode
    const pageIds = currentPageOnly ? new Set(getRows().map((r) => r.dataset.id)) : null;
    const isCandidate = (r) => !seen.has(r.dataset.id) && (!pageIds || pageIds.has(r.dataset.id));
    const assigned = [];
    const skipped = [];
    let page = 1;
    const result = (stopReason) => ({ assigned, skipped, checked: seen.size, stopReason });

    const skip = (item, row, reason) => {
      item.skipReason = reason;
      skipped.push(item);
      row.style.backgroundColor = HIGHLIGHT.skipped;
      console.log(`[TaxAdvisor] #${seen.size} SKIP ${item.name} | ${item.amountText}: ${reason}`);
    };

    while (true) {
      const row = getRows().find(isCandidate);

      if (!row) {
        // Rows may be rendered lazily: scroll to the end and look again
        const rows = getRows();
        rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
        await sleep(500);
        if (getRows().some(isCandidate)) continue;

        if (currentPageOnly) return result('All items on the current page were checked');
        if (!(await goToNextPage())) break;
        page++;
        console.log(`[TaxAdvisor] Page ${page}`);
        continue;
      }

      seen.add(row.dataset.id);
      row.scrollIntoView({ block: 'center' });
      row.style.backgroundColor = HIGHLIGHT.current;

      const item = extractItem(row);
      if (SKIP_NAMES.some((name) => name.toLowerCase() === item.name.trim().toLowerCase())) {
        skip(item, row, 'Name is on the skip list');
        await sleep(STEP_DELAY_MS);
        continue;
      }
      if (item.invoiceNumbers.length > 0) {
        await flashText(item.invoiceNumbers.map((text) => ({ el: item.purposeEl, text })));
      }
      if (item.invoiceNumbers.length !== 1) {
        skip(item, row, item.invoiceNumbers.length
          ? `Several invoice numbers: ${item.invoiceNumbers.join(', ')}`
          : 'No invoice number (202X-XXXXXX) in purpose');
        await sleep(STEP_DELAY_MS);
        continue;
      }

      item.invoiceNumber = item.invoiceNumbers[0];
      console.log(`[TaxAdvisor] #${seen.size} Invoice ${item.invoiceNumber} | ${item.name} | ${item.amountText}`);
      await sleep(STEP_DELAY_MS);

      const panel = await openAssignPanel(row);
      if (!panel) {
        skip(item, row, 'Assignment panel did not open');
        await sleep(STEP_DELAY_MS);
        continue;
      }

      // The voucher list loads with a delay (1-2 s)
      const vouchers = await waitFor(() => {
        const list = getPanelVouchers(panel);
        return list.length ? list : null;
      }, PANEL_LIST_TIMEOUT_MS) || [];
      const first = vouchers[0];
      const firstNumber = first?.number.match(INVOICE_REGEX)?.[0];

      let skipReason = null;
      if (firstNumber && firstNumber === item.invoiceNumber) {
        // Match: blink the number in the main table and in the panel together
        await flashText([
          { el: item.purposeEl, text: item.invoiceNumber },
          { el: first.numberEl, text: item.invoiceNumber },
        ]);
        item.voucher = first;
        first.tr.style.backgroundColor = HIGHLIGHT.eligible;
        console.log(`[TaxAdvisor] MATCH ${item.invoiceNumber}: ${first.number} | ${first.name} | ${first.amountText}`);
        await sleep(STEP_DELAY_MS);

        await tickVoucher(first.tr);
        const overpaid = await waitFor(() => readOverpayment(panel), SUMMARY_TIMEOUT_MS);
        const overpayment = findOverpaymentElements(panel);
        await flashText([{ el: overpayment.label }, { el: overpayment.amount }]);

        if (isMahnungFee(overpaid)) {
          item.overpaid = overpaid;
          row.style.backgroundColor = HIGHLIGHT.eligible;
          console.log(`[TaxAdvisor] Zu viel erhalten: ${overpaid.toFixed(2)} € -> Mahnung fee, pressing Zuordnen`);
          await sleep(STEP_DELAY_MS);

          if (!(await assignWithDunningFee(panel))) {
            return result(`Assignment of ${item.invoiceNumber} (${item.name}) did not complete, please check the panel`);
          }
          assigned.push(item);

          // The assigned row disappears and the list re-orders (rows from the next page move up).
          // Rows are tracked by id, so waiting for the refresh keeps the order safe.
          const removed = await waitFor(() => !getRows().some((r) => r.dataset.id === item.id), 10000);
          if (!removed) {
            return result(`Assigned row ${item.invoiceNumber} is still in the list (list did not refresh)`);
          }
          console.log(`[TaxAdvisor] Assigned ${assigned.length}: ${item.invoiceNumber} | ${item.name}`);

          if (assigned.length >= maxAssignments) {
            return result(`Reached the limit of ${maxAssignments} assignments`);
          }
          await sleep(STEP_DELAY_MS);
          continue;
        }

        skipReason = overpaid === null
          ? 'No "Zu viel erhalten" shown after ticking the voucher'
          : `Zu viel erhalten ${overpaid.toFixed(2).replace('.', ',')} € is not a Mahnung fee`;
      } else {
        await flash(first?.numberEl);
        skipReason = first
          ? `First suggested voucher is ${first.number}, not ${item.invoiceNumber}`
          : 'No suggested vouchers in the panel';
      }

      // Skip: close the panel without assigning (a ticked voucher is discarded)
      await sleep(STEP_DELAY_MS);
      await closeAssignPanel(panel);
      skip(item, row, skipReason);
      await sleep(STEP_DELAY_MS);
    }

    return result('All items in the list were checked');
  }

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

  function downloadFile(filename, content) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function downloadReportCsv({ assigned, skipped }) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const num = (n) => (typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(2).replace('.', ',') : '');

    downloadFile(`mahnung-assigned_${stamp}.csv`, toCsv(
      ['Date', 'Invoice number', 'Name', 'Account', 'Amount', 'Mahngebuehr', 'Voucher', 'Voucher contact', 'Voucher amount', 'Purpose', 'Transaction ID'],
      assigned.map((i) => [i.date, i.invoiceNumber, i.name, i.account, num(i.amount), num(i.overpaid),
        i.voucher?.number, i.voucher?.name, i.voucher?.amountText, i.purpose, i.id]),
    ));
    await sleep(500); // two downloads in a row: give the browser a moment between them
    downloadFile(`mahnung-skipped_${stamp}.csv`, toCsv(
      ['Date', 'Name', 'Account', 'Amount', 'Purpose', 'Reason', 'Transaction ID'],
      skipped.map((i) => [i.date, i.name, i.account, num(i.amount), i.purpose, i.skipReason, i.id]),
    ));
    console.log(`[TaxAdvisor] CSV downloaded: mahnung-assigned_${stamp}.csv, mahnung-skipped_${stamp}.csv`);
  }

  // Final report: stats, assigned items, skipped items with reasons
  function showSummary(report) {
    const { assigned, skipped, checked, stopReason, durationMs } = report;
    const totalSec = Math.round(durationMs / 1000);
    const duration = `${Math.floor(totalSec / 60)} min ${totalSec % 60} s`;
    const euro = (n) => `${n.toFixed(2).replace('.', ',')} €`;
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
      'display:flex;align-items:center;justify-content:center;font-family:inherit;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:24px 28px;width:min(1000px,92vw);max-height:88vh;
                  display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <h2 style="margin:0 0 4px;font-size:22px;">Mahnung Automation finished</h2>
        <p style="margin:0 0 16px;color:#555;">${escapeHtml(stopReason)}</p>
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          ${stat('Assigned', assigned.length, '#0e9e57')}
          ${stat('Skipped', skipped.length, '#757575')}
          ${stat('Checked', checked, '#1976d2')}
          ${stat('Time', duration, '#6a1b9a')}
        </div>
        <div style="overflow:auto;flex:1;">
          <h3 style="margin:8px 0 4px;font-size:16px;">Assigned (${assigned.length})</h3>
          ${table(['Invoice', 'Name', 'Amount', 'Mahngebühr', 'Voucher'],
            assigned.map((i) => [i.invoiceNumber, i.name, i.amountText, euro(i.overpaid), i.voucher?.number]))}
          <h3 style="margin:16px 0 4px;font-size:16px;">Skipped (${skipped.length})</h3>
          ${table(['Name', 'Amount', 'Purpose', 'Reason'],
            skipped.map((i) => [i.name, i.amountText, i.purpose.length > 80 ? i.purpose.slice(0, 80) + '…' : i.purpose, i.skipReason]))}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
          <button data-download style="padding:8px 20px;border:1px solid #0e9e57;border-radius:4px;background:#fff;color:#0e9e57;cursor:pointer;font-weight:600;">Download CSV</button>
          <button data-close style="padding:8px 20px;border:none;border-radius:4px;background:#0e9e57;color:#fff;cursor:pointer;font-weight:600;">Close</button>
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

  // Start dialog: resolves with { maxAssignments, currentPageOnly }, or null when cancelled
  function askRunMode() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);' +
        'display:flex;align-items:center;justify-content:center;font-family:inherit;';
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:8px;padding:24px 28px;max-width:440px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
          <h2 style="margin:0 0 12px;font-size:20px;">Start Mahnung Automation</h2>
          <p style="margin:0 0 20px;line-height:1.5;">
            The script assigns payments with a Mahnung fee (2,90 € / 5,00 €) to their invoices using
            <b>Mahngebühr</b>. What should it process?
          </p>
          <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
            <button data-choice="cancel" style="padding:8px 16px;border:1px solid #bbb;border-radius:4px;background:#fff;cursor:pointer;">Cancel</button>
            <button data-choice="test" style="padding:8px 16px;border:1px solid #0e9e57;border-radius:4px;background:#fff;color:#0e9e57;cursor:pointer;font-weight:600;">Test run (${TEST_ASSIGNMENTS} items)</button>
            <button data-choice="page" style="padding:8px 16px;border:1px solid #1976d2;border-radius:4px;background:#fff;color:#1976d2;cursor:pointer;font-weight:600;">Current page</button>
            <button data-choice="all" style="padding:8px 16px;border:1px solid #d32f2f;border-radius:4px;background:#d32f2f;color:#fff;cursor:pointer;font-weight:600;">All items</button>
          </div>
        </div>`;

      const close = (value) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(null);
        }
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) return close(null); // click outside the dialog
        const choice = e.target.closest('button')?.dataset.choice;
        if (choice === 'test') close({ maxAssignments: TEST_ASSIGNMENTS, currentPageOnly: false });
        else if (choice === 'page') close({ maxAssignments: Infinity, currentPageOnly: true });
        else if (choice === 'all') close({ maxAssignments: Infinity, currentPageOnly: false });
        else if (choice === 'cancel') close(null);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      overlay.querySelector('[data-choice="test"]').focus();
    });
  }

  let running = false;

  async function startMahnungAutomation() {
    if (running) {
      console.log('[TaxAdvisor] Automation already running');
      return;
    }
    running = true; // also blocks a second dialog while this one is open
    try {
      const mode = await askRunMode();
      if (!mode) {
        console.log('[TaxAdvisor] Start cancelled');
        return;
      }
      const modeLabel = mode.currentPageOnly ? 'current page'
        : mode.maxAssignments === Infinity ? 'all items' : `test run, ${mode.maxAssignments} items`;
      console.log(`[TaxAdvisor] Start Mahnung Automation (${modeLabel})`);
      if (!(await selectAssignTab())) return;
      await sleep(STEP_DELAY_MS);
      if (!(await selectPositiveType())) return;
      await sleep(STEP_DELAY_MS);
      if (!(await waitFor(() => getRows().length > 0, 10000))) {
        console.log('[TaxAdvisor] No items in the list');
        return;
      }
      const startedAt = Date.now();
      const report = await processAllItems(mode);
      report.durationMs = Date.now() - startedAt;
      console.log(`[TaxAdvisor] Finished: ${report.stopReason}. Assigned ${report.assigned.length}, skipped ${report.skipped.length}`);
      showSummary(report);
    } finally {
      running = false;
    }
  }

  function addMahnungButton() {
    if (!isTransactionsPage() || document.getElementById(BUTTON_ID)) return;

    const refreshBtn = findRefreshButton();
    if (!refreshBtn) return;

    // cloneNode copies markup and classes only, not Lexware's click handlers
    const customBtn = refreshBtn.cloneNode(true);
    customBtn.id = BUTTON_ID;
    customBtn.classList.remove(...STATE_CLASSES);
    customBtn.disabled = false;
    customBtn.removeAttribute('aria-disabled');
    customBtn.removeAttribute('data-testid'); // don't impersonate Lexware's ButtonStartSync
    customBtn.tabIndex = 0;
    setLabel(customBtn, BUTTON_LABEL);
    customBtn.style.marginRight = '8px';

    customBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startMahnungAutomation();
    });

    refreshBtn.parentNode.insertBefore(customBtn, refreshBtn);
    console.log('[TaxAdvisor] Mahnung Automation button added');
  }

  // Lexware is an SPA: keep watching for re-renders and route changes
  const observer = new MutationObserver(addMahnungButton);
  observer.observe(document.body, { childList: true, subtree: true });
  addMahnungButton();
})();
