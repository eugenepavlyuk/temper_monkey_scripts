// ==UserScript==
// @name         Shopify Finance - TaxAdvisor
// @namespace    tax-advisor
// @version      0.1.5.1
// @description  Adds extra column to Shopify Finance table
// @match        https://admin.shopify.com/store/soloair-de/payments/payouts/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  function addTableHeader() {
    const headerRow = document.querySelector('table thead tr');
    if (!headerRow || headerRow.dataset.taxAdvisorHeader) return;
    headerRow.dataset.taxAdvisorHeader = 'true';

    const ths = headerRow.querySelectorAll('th');
    if (ths.length < 2) return;

    const newTh = document.createElement('th');
    newTh.className = 'Polaris-IndexTable__TableHeading Polaris-IndexTable__TableHeading--unselectable';
    newTh.setAttribute('data-index-table-heading', 'true');
    newTh.innerHTML = '<span class="Polaris-Text--root Polaris-Text--bodySm Polaris-Text--medium">Customer Name</span>';
    ths[1].after(newTh);
    console.log('[TaxAdvisor] Header added');
  }

  function processTable() {
    console.log('[TaxAdvisor] processTable called');

    const table = document.querySelector('.Polaris-IndexTable');
    console.log('[TaxAdvisor] Found .Polaris-IndexTable:', table);

    const rows = table ? document.querySelectorAll('table tbody tr') : [];
    console.log('[TaxAdvisor] Found rows:', rows.length);

    rows.forEach((tr, i) => {
      if (tr.dataset.taxAdvisorProcessed) return;
      tr.dataset.taxAdvisorProcessed = 'true';

      const cells = tr.querySelectorAll('td.Polaris-IndexTable__TableCell');
      console.log(`[TaxAdvisor] Row ${i}: found ${cells.length} cells`);
      if (cells.length < 2) return;

      const secondTd = cells[1];
      console.log(`[TaxAdvisor] Row ${i}: secondTd innerHTML:`, secondTd.innerHTML);

      const link = secondTd.querySelector('s-internal-link[href]');
      console.log(`[TaxAdvisor] Row ${i}: link element:`, link);

      const href = link ? link.getAttribute('href') : null;
      console.log(`[TaxAdvisor] Row ${i}: href:`, href);

      const newTd = document.createElement('td');
      newTd.className = 'Polaris-IndexTable__TableCell';
      newTd.textContent = '⏳';
      secondTd.after(newTd);

      if (!href) {
        console.log(`[TaxAdvisor] Row ${i}: no href, skipping`);
        newTd.textContent = '—';
        return;
      }

      // Extract order ID from href like /store/soloair-de/orders/12416852558169
      const orderIdMatch = href.match(/\/orders\/(\d+)/);
      if (!orderIdMatch) {
        console.log(`[TaxAdvisor] Row ${i}: no order ID in href`, href);
        newTd.textContent = '—';
        return;
      }

      // Try Shopify admin API endpoint
      const apiUrl = 'https://admin.shopify.com/store/soloair-de/api/2024-01/orders/' + orderIdMatch[1] + '.json';
      console.log(`[TaxAdvisor] Row ${i}: trying API`, apiUrl);

      fetch(apiUrl, { credentials: 'include' })
        .then((r) => {
          console.log(`[TaxAdvisor] Row ${i}: API status`, r.status, 'content-type', r.headers.get('content-type'));
          return r.text();
        })
        .then((body) => {
          console.log(`[TaxAdvisor] Row ${i}: API body length`, body.length);
          console.log(`[TaxAdvisor] Row ${i}: first 3000 chars:`, body.substring(0, 3000));
          try {
            const data = JSON.parse(body);
            const name = data?.order?.customer?.first_name + ' ' + data?.order?.customer?.last_name;
            console.log(`[TaxAdvisor] Row ${i}: customer name:`, name);
            newTd.textContent = '';
            const copyBtn = document.createElement('span');
            copyBtn.textContent = '📋';
            copyBtn.style.cursor = 'pointer';
            copyBtn.style.marginRight = '4px';
            copyBtn.addEventListener('click', () => {
              navigator.clipboard.writeText(name.trim()).then(() => copyBtn.textContent = '✅');
              setTimeout(() => copyBtn.textContent = '📋', 1500);
            });
            newTd.appendChild(copyBtn);
            newTd.appendChild(document.createTextNode(name.trim()));
          } catch (e) {
            console.log(`[TaxAdvisor] Row ${i}: not JSON, trying regex`);
            const match = body.match(/"first_name"\s*:\s*"([^"]+)".*?"last_name"\s*:\s*"([^"]+)"/);
            console.log(`[TaxAdvisor] Row ${i}: regex match:`, match);
            const fallbackName = match ? (match[1] + ' ' + match[2]).trim() : null;
            if (fallbackName) {
              newTd.textContent = '';
              const copyBtn2 = document.createElement('span');
              copyBtn2.textContent = '📋';
              copyBtn2.style.cursor = 'pointer';
              copyBtn2.style.marginRight = '4px';
              copyBtn2.addEventListener('click', () => {
                navigator.clipboard.writeText(fallbackName).then(() => copyBtn2.textContent = '✅');
                setTimeout(() => copyBtn2.textContent = '📋', 1500);
              });
              newTd.appendChild(copyBtn2);
              newTd.appendChild(document.createTextNode(fallbackName));
            } else {
              newTd.textContent = '—';
            }
          }
        })
        .catch((err) => {
          console.error(`[TaxAdvisor] Row ${i}: error`, err);
          newTd.textContent = '❌';
        });
    });
  }

  function addExportButton() {
    const exportBtn = Array.from(document.querySelectorAll('.Polaris-Button'))
      .find((btn) => btn.textContent.trim() === 'Export');
    if (!exportBtn || document.getElementById('tax-advisor-export')) return;

    const customBtn = exportBtn.cloneNode(true);
    customBtn.id = 'tax-advisor-export';
    customBtn.querySelector('span')
      ? (customBtn.querySelector('span').textContent = 'Custom Export')
      : (customBtn.textContent = 'Custom Export');
    customBtn.style.marginLeft = '8px';

    customBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const rows = document.querySelectorAll('table tbody tr');
      const csvRows = ['Transaction Date,Type,Customer Name,Amount'];
      rows.forEach((tr) => {
        const cells = tr.querySelectorAll('td.Polaris-IndexTable__TableCell');
        if (cells.length < 8) return;
        const date = cells[0].textContent.trim();
        const parsedDate = new Date(date);
        const formattedDate = !isNaN(parsedDate)
          ? parsedDate.getFullYear() + '-' +
            String(parsedDate.getMonth() + 1).padStart(2, '0') + '-' +
            String(parsedDate.getDate()).padStart(2, '0') + ' 04:00:00 +0100'
          : date;
        const type = cells[3].textContent.trim();
        const name = cells[2].textContent.replace('📋', '').replace('✅', '').trim();
        const amount = cells[5].textContent.trim().replace(/[€EUR\s]/g, '');
        if (name && name !== '⏳' && name !== '—' && name !== '❌' && name !== '⏰') {
          csvRows.push(formattedDate + ',' + type + ',' + name + ',' + amount);
        }
      });

      const csv = csvRows.join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'tax-advisor-export.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      console.log('[TaxAdvisor] Exported', csvRows.length - 1, 'rows');
    });

    exportBtn.parentNode.insertBefore(customBtn, exportBtn.nextSibling);
    console.log('[TaxAdvisor] Custom Export button added');
  }

  // Delay to let Shopify SPA render the page
  console.log('[TaxAdvisor] Script loaded, waiting 3s...');
  setTimeout(() => {
    console.log('[TaxAdvisor] Starting...');
    const observer = new MutationObserver(() => {
      addTableHeader();
      processTable();
      addExportButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    addTableHeader();
    processTable();
    addExportButton();
  }, 3000);
})();
