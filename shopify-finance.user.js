// ==UserScript==
// @name         Shopify Finance - TaxAdvisor
// @namespace    tax-advisor
// @version      0.1
// @description  Adds extra column to Shopify Finance table
// @match        https://admin.shopify.com/store/soloair-de/payments/payouts/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

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
            newTd.textContent = name && name !== 'undefined undefined' ? name.trim() : '—';
          } catch (e) {
            console.log(`[TaxAdvisor] Row ${i}: not JSON, trying regex`);
            const match = body.match(/"first_name"\s*:\s*"([^"]+)".*?"last_name"\s*:\s*"([^"]+)"/);
            console.log(`[TaxAdvisor] Row ${i}: regex match:`, match);
            newTd.textContent = match ? (match[1] + ' ' + match[2]).trim() : '—';
          }
        })
        .catch((err) => {
          console.error(`[TaxAdvisor] Row ${i}: error`, err);
          newTd.textContent = '❌';
        });
    });
  }

  // Delay to let Shopify SPA render the page
  console.log('[TaxAdvisor] Script loaded, waiting 3s...');
  setTimeout(() => {
    console.log('[TaxAdvisor] Starting...');
    const observer = new MutationObserver(processTable);
    observer.observe(document.body, { childList: true, subtree: true });
    processTable();
  }, 3000);
})();
