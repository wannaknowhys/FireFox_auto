import path from 'path';
import fs from 'fs/promises';
import { BiDiClient, safeMoveOrCopy, cleanupStaleFiles, sleep } from './lib/bidi_client.mjs';
import { formatDate, parseDate } from './lib/date_utils.mjs';

const OUTPUT_DIR = path.resolve('clover_export/output/sales_report');

async function getLatestCutoff() {
  const files = await fs.readdir(OUTPUT_DIR);
  const fullPeriodRegex = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_Sales_Report\.csv$/;
  let latestEndDate = null;

  for (const f of files) {
    const m = f.match(fullPeriodRegex);
    if (m) {
      const endDate = m[2];
      if (!latestEndDate || endDate > latestEndDate) {
        latestEndDate = endDate;
      }
    }
  }

  return latestEndDate;
}

function getNextCycle(latestEndDateStr) {
  const [y, m, d] = latestEndDateStr.split('-').map(Number);
  const nextStart = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  const fullEnd = new Date(y, m - 1, d + 14, 23, 59, 59, 0);

  const now = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 0);

  // A 14-day cycle is only complete after day 14 has fully passed (i.e. starting from day 15).
  // If fullEnd is today or in the future, today is still in progress, so it must be PARTIAL.
  const isPartial = fullEnd.getTime() >= todayEnd.getTime();
  const effectiveEnd = isPartial ? todayEnd : fullEnd;

  return {
    startTimestamp: nextStart.getTime(),
    endTimestamp: effectiveEnd.getTime(),
    startDateStr: formatDate(nextStart),
    endDateStr: formatDate(effectiveEnd),
    isPartial,
    nextStartObj: nextStart,
    fullEndStr: formatDate(fullEnd)
  };
}

async function waitForReportFullyLoaded(client, contextId, maxAttempts = 35) {
  const script = `
    (() => {
      const menuBtn = document.querySelector('[data-testid="overflow-menu"]') ||
                      Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Sales Report Menu'));

      const hasMenu = !!menuBtn;

      const skeletons = document.querySelectorAll(
        '[aria-busy="true"], [role="progressbar"], [class*="skeleton"], [class*="Skeleton"], [data-testid*="loading"], [data-testid*="spinner"]'
      );
      const skeletonCount = skeletons.length;

      const bodyText = document.body.innerText || '';
      const netSalesMatch = bodyText.match(/Net\\s+sales[\\s\\S]{0,100}?from\\s+\\d+\\s+transactions?/i) || bodyText.match(/Net\\s+sales\\s+\\$[\\d,]+/i);
      const grossSalesMatch = bodyText.match(/Gross\\s+sales\\s+\\$[\\d,]+/i);
      const zeroSalesMatch = /no\\s+(data|transactions|sales)/i.test(bodyText) || /\\$0(\\.00)?\\s+from\\s+0\\s+transactions?/i.test(bodyText);

      const tbodyRows = Array.from(document.querySelectorAll('tbody tr')).length;

      const dateEl = Array.from(document.querySelectorAll('*')).find(el => {
        if (el.children.length > 0) return false;
        const t = (el.innerText || '').trim();
        return /[A-Za-z]+,\\s+[A-Za-z]+\\s+\\d{1,2},\\s+\\d{4}.*?-[^,]+,\\s+[A-Za-z]+\\s+\\d{1,2},\\s+\\d{4}/.test(t);
      });
      const pageDateText = dateEl ? dateEl.innerText.trim() : null;

      const isDataReady = (!!netSalesMatch && tbodyRows > 0) || zeroSalesMatch || (tbodyRows > 0 && !!grossSalesMatch);
      const fullyLoaded = hasMenu && skeletonCount === 0 && isDataReady;

      return JSON.stringify({
        fullyLoaded,
        hasMenu,
        skeletonCount,
        summary: netSalesMatch ? netSalesMatch[0].replace(/\\s+/g, ' ') : (zeroSalesMatch ? 'Zero sales / No transactions' : null),
        tbodyRows,
        pageDateText
      });
    })()
  `;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(1000);
    try {
      const res = await client.send('script.evaluate', {
        expression: script,
        target: { context: contextId },
        awaitPromise: true
      });

      const raw = res.result?.result?.value;
      if (raw) {
        const info = JSON.parse(raw);
        if (info.fullyLoaded) {
          console.log(`[Loaded in ${attempt}s] Summary: ${info.summary} (Rows: ${info.tbodyRows})`);
          await sleep(1000);
          return info;
        } else {
          process.stdout.write(`  [Waiting ${attempt}s] skeletons: ${info.skeletonCount}, rows: ${info.tbodyRows}, status: ${info.summary || 'fetching'}\r`);
        }
      }
    } catch (_) {}
  }

  throw new Error(`Report load timed out after ${maxAttempts} seconds`);
}

async function exportSinglePeriod(client, contextId, cycle, merchantId) {
  const targetUrl = `https://www.clover.com/reporting/m/${merchantId}/sales-report?startTimestamp=${cycle.startTimestamp}&endTimestamp=${cycle.endTimestamp}&mid=${merchantId}`;
  const prefix = cycle.isPartial ? 'PARTIAL_' : '';
  const label = cycle.isPartial ? `[PARTIAL CYCLE (up to today)]` : `[FULL 14-DAY CYCLE]`;

  console.log(`\nNavigating to ${label}: ${cycle.startDateStr} ~ ${cycle.endDateStr}`);
  console.log(`Target URL: ${targetUrl}`);

  await client.send('browsingContext.navigate', {
    context: contextId,
    url: targetUrl,
    wait: 'none'
  });

  console.log('Polling DOM every second for full data arrival...');
  const loadedInfo = await waitForReportFullyLoaded(client, contextId);
  console.log(`Page verified for date: "${loadedInfo.pageDateText || cycle.startDateStr}"`);

  const beforeFiles = new Set(await fs.readdir(OUTPUT_DIR));

  console.log('Opening export menu...');
  await client.send('script.evaluate', {
    expression: `
      (() => {
        const menuBtn = document.querySelector('[data-testid="overflow-menu"]') ||
                        Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('Sales Report Menu'));
        if (menuBtn && menuBtn.getAttribute('aria-expanded') !== 'true') {
          menuBtn.click();
        }
      })()
    `,
    target: { context: contextId },
    awaitPromise: true
  });

  await sleep(700);

  console.log('Clicking Export button...');
  await client.send('script.evaluate', {
    expression: `
      (() => {
        const dlBtn = document.querySelector('[data-testid="download-button"]') ||
                      Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').trim() === 'Export');
        if (dlBtn) dlBtn.click();
      })()
    `,
    target: { context: contextId },
    awaitPromise: true
  });

  console.log('Waiting for CSV download in sales_report output folder...');
  let newFile = null;
  for (let i = 0; i < 35; i++) {
    await sleep(1000);
    const files = await fs.readdir(OUTPUT_DIR);
    const diff = files.filter(f => !beforeFiles.has(f) && !f.endsWith('.part') && !f.endsWith('.tmp') && !f.endsWith('.crdownload'));
    if (diff.length > 0) {
      newFile = diff[0];
      break;
    }
  }

  if (!newFile) {
    throw new Error('Download detection timed out for period ' + cycle.startDateStr);
  }

  // Clean up any stale partial files for this cycle or older partials
  const existing = await fs.readdir(OUTPUT_DIR);
  for (const f of existing) {
    if (f.startsWith('PARTIAL_') && f.endsWith('.csv')) {
      if (cycle.isPartial || f.startsWith(`PARTIAL_${cycle.startDateStr}_`)) {
        try { await fs.unlink(path.join(OUTPUT_DIR, f)); } catch (_) {}
      }
    }
  }

  const finalName = `${prefix}${cycle.startDateStr}_${cycle.endDateStr}_Sales_Report.csv`;
  const fromPath = path.join(OUTPUT_DIR, newFile);
  const toPath = path.join(OUTPUT_DIR, finalName);

  await safeMoveOrCopy(fromPath, toPath);
  console.log(` Exported and saved: ${finalName}`);
}

export async function exportAllSalesReports() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await cleanupStaleFiles(OUTPUT_DIR, '-Sales Report');

  const client = new BiDiClient();
  const { cloverTab, merchantId } = await client.initialize(OUTPUT_DIR);
  console.log(`Connected to Firefox BiDi. Merchant ID: ${merchantId}`);

  try {
    let latestCutoff = await getLatestCutoff();
    console.log(`Current base cutoff date (latest full cycle CSV): ${latestCutoff || 'None'}`);

    if (!latestCutoff) {
      console.log('No existing full-period CSV found in output/sales_report. Please ensure initial export is present.');
      return;
    }

    const now = Date.now();
    let count = 0;

    while (true) {
      const nextCycle = getNextCycle(latestCutoff);

      if (nextCycle.nextStartObj.getTime() > now) {
        console.log(`\nNext cycle (${nextCycle.startDateStr}) has not started yet. All up to date!`);
        break;
      }

      console.log(`\n======================================================`);
      console.log(`Processing period ${count + 1}: ${nextCycle.startDateStr} ~ ${nextCycle.endDateStr} ${nextCycle.isPartial ? '(Partial up to today)' : '(Full 14 days)'}`);

      await exportSinglePeriod(client, cloverTab.context, nextCycle, merchantId);
      count++;

      if (nextCycle.isPartial) {
        console.log(`\nPartial cycle for the current in-progress period exported. Stopping until full period finishes.`);
        break;
      }

      latestCutoff = nextCycle.endDateStr;
      await sleep(2500);
    }

    console.log(`\n All done! Exported ${count} period(s).`);

  } finally {
    console.log('Closing BiDi session cleanly...');
    try { await client.send('session.end', {}); } catch (_) {}
    client.close();
  }
}

// Allow direct CLI execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  exportAllSalesReports().catch(err => {
    console.error('Fatal error in export_sales_report_biweekly:', err);
    process.exit(1);
  });
}
