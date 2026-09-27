import path from 'path';
import fs from 'fs/promises';
import { BiDiClient, safeMoveOrCopy, cleanupStaleFiles, sleep } from './lib/bidi_client.mjs';
import { expandDateRange, getDayTimestamps, getTodayStr } from './lib/date_utils.mjs';

const SALES_REPORT_DIR = path.resolve('clover_export/output/sales_report');
const TENDER_TYPES_DIR = path.resolve('clover_export/output/tender_types');

/**
 * Scan sales_report output directory to gather all covered dates.
 * Supports both full period and PARTIAL_ in-progress period files.
 */
async function getTargetDailyDates() {
  const files = await fs.readdir(SALES_REPORT_DIR);
  const regex = /^(?:PARTIAL_)?(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_Sales_Report\.csv$/;
  const allDatesSet = new Set();

  for (const f of files) {
    const m = f.match(regex);
    if (m) {
      const [_, startDate, endDate] = m;
      const days = expandDateRange(startDate, endDate);
      for (const d of days) {
        allDatesSet.add(d);
      }
    }
  }

  const todayStr = getTodayStr();
  // Filter out today (since today's data is still in-progress and incomplete)
  const targetDates = Array.from(allDatesSet)
    .filter(d => d < todayStr)
    .sort();

  return { targetDates, todayStr };
}

/**
 * Poll DOM until tender-types table is hydrated and skeletons are gone.
 * Handles both days with transactions (tbodyRows > 0) and zero-transaction days.
 */
async function waitForTenderTypesLoaded(client, contextId, maxAttempts = 30) {
  let sawSkeletons = false;
  let zeroSkeletonCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(1000);
    try {
      const res = await client.send('script.evaluate', {
        expression: `
          (() => {
            const menuBtn = document.querySelector('[aria-label="Reporting overflow menu"]') ||
                            document.querySelector('[data-testid="overflow-menu"]') ||
                            Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('overflow menu'));

            const hasMenu = !!menuBtn;

            const skeletons = document.querySelectorAll(
              '[aria-busy="true"], [role="progressbar"], [class*="skeleton"], [class*="Skeleton"], [data-testid*="loading"], [data-testid*="spinner"]'
            );
            const skeletonCount = skeletons.length;
            const tbodyRows = Array.from(document.querySelectorAll('tbody tr')).length;
            const bodyText = document.body.innerText || '';
            const hasNoResults = /no\s+results\s+found/i.test(bodyText) || /no\s+(transactions|sales|records)/i.test(bodyText);

            return JSON.stringify({
              hasMenu,
              skeletonCount,
              tbodyRows,
              hasNoResults
            });
          })()
        `,
        target: { context: contextId },
        awaitPromise: true
      });

      const raw = res.result?.result?.value;
      if (raw) {
        const info = JSON.parse(raw);
        if (info.skeletonCount > 0) {
          sawSkeletons = true;
          zeroSkeletonCount = 0;
        } else {
          zeroSkeletonCount++;
        }

        const isReady = info.hasMenu && (
          (info.tbodyRows > 0 && info.skeletonCount === 0) ||
          (info.hasNoResults && info.skeletonCount === 0) ||
          (sawSkeletons && info.skeletonCount === 0 && zeroSkeletonCount >= 1) ||
          (attempt >= 4 && info.skeletonCount === 0 && zeroSkeletonCount >= 2)
        );

        if (isReady) {
          await sleep(600);
          return info;
        } else {
          process.stdout.write(`  [Waiting ${attempt}s] skeletons: ${info.skeletonCount}, rows: ${info.tbodyRows}, noResults: ${info.hasNoResults}\r`);
        }
      }
    } catch (_) {}
  }

  throw new Error(`Tender types page load timed out after ${maxAttempts} seconds`);
}

async function exportSingleDay(client, contextId, dateStr, merchantId) {
  const { startTimestamp, endTimestamp } = getDayTimestamps(dateStr);
  const targetUrl = `https://www.clover.com/reporting/m/${merchantId}/tender-types?startTimestamp=${startTimestamp}&endTimestamp=${endTimestamp}&mid=${merchantId}`;

  console.log(`\nNavigating to Date: ${dateStr}`);
  console.log(`Target URL: ${targetUrl}`);

  await client.send('browsingContext.navigate', {
    context: contextId,
    url: targetUrl,
    wait: 'none'
  });

  process.stdout.write('Polling DOM for table hydration...\n');
  const info = await waitForTenderTypesLoaded(client, contextId);
  console.log(`[Loaded] Table rows: ${info.tbodyRows} (No results: ${info.hasNoResults})`);

  const beforeFiles = new Set(await fs.readdir(TENDER_TYPES_DIR));

  // Click overflow menu
  console.log('Opening Reporting overflow menu...');
  await client.send('script.evaluate', {
    expression: `
      (() => {
        const menuBtn = document.querySelector('[aria-label="Reporting overflow menu"]') ||
                        document.querySelector('[data-testid="overflow-menu"]') ||
                        Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('overflow menu'));
        if (menuBtn && menuBtn.getAttribute('aria-expanded') !== 'true') {
          menuBtn.click();
        }
      })()
    `,
    target: { context: contextId },
    awaitPromise: true
  });

  await sleep(700);

  // Click Export
  console.log('Clicking Export button...');
  const clickRes = await client.send('script.evaluate', {
    expression: `
      (() => {
        const dlBtn = document.querySelector('[data-testid="exportTestId"]') ||
                      Array.from(document.querySelectorAll('button, a, [role="menuitem"]')).find(b => (b.innerText || '').trim() === 'Export');
        if (dlBtn && !dlBtn.disabled) {
          dlBtn.click();
          return JSON.stringify({ clicked: true });
        }
        return JSON.stringify({ clicked: false, reason: dlBtn ? 'disabled' : 'not_found' });
      })()
    `,
    target: { context: contextId },
    awaitPromise: true
  });

  let clickData = {};
  try {
    clickData = clickRes.result?.result?.value ? JSON.parse(clickRes.result.result.value) : {};
  } catch (_) {}

  // Wait for file download
  console.log('Waiting for CSV download in tender_types output folder...');
  let newFile = null;
  const maxDownloadWait = info.hasNoResults ? 6 : 30; // Shorter wait if day has no results

  for (let i = 0; i < maxDownloadWait; i++) {
    await sleep(1000);
    const files = await fs.readdir(TENDER_TYPES_DIR);
    const diff = files.filter(f => !beforeFiles.has(f) && !f.endsWith('.part') && !f.endsWith('.tmp') && !f.endsWith('.crdownload'));
    if (diff.length > 0) {
      newFile = diff[0];
      break;
    }
  }

  const finalName = `${dateStr}_Tender_Types.csv`;
  const toPath = path.join(TENDER_TYPES_DIR, finalName);

  if (newFile) {
    const fromPath = path.join(TENDER_TYPES_DIR, newFile);
    await safeMoveOrCopy(fromPath, toPath);
    console.log(` Exported and saved: ${finalName}`);
  } else if (info.hasNoResults || clickData.reason === 'disabled') {
    // If Clover didn't generate a download file because there are 0 transactions, write standard zero-sales CSV
    console.log(`Note: No transactions for ${dateStr}. Generating standard zero-sales CSV placeholder.`);
    const emptyCsvContent = [
      'Tender Types',
      `"${dateStr}, 12:00 a.m.  - ${dateStr}, 11:59 p.m. "`,
      'Filters: none',
      '',
      'Tender Types',
      'Tender Types,Card types,Transactions,Sales Total,Transaction Refunds,Manual Refunds,Amount Collected',
      'Total,,0,$0.00,$0.00,$0.00,$0.00'
    ].join('\r\n') + '\r\n';

    await fs.writeFile(toPath, emptyCsvContent, 'utf-8');
    console.log(` Saved zero-sales record: ${finalName}`);
  } else {
    throw new Error(`Download detection timed out for date: ${dateStr}`);
  }
}

export async function exportAllTenderTypesDaily() {
  await fs.mkdir(TENDER_TYPES_DIR, { recursive: true });
  await cleanupStaleFiles(TENDER_TYPES_DIR, '-Tender Types');

  const { targetDates, todayStr } = await getTargetDailyDates();
  console.log(`Found ${targetDates.length} total target date(s) across sales report files.`);
  console.log(`Excluding today (${todayStr}) as specified.`);

  if (targetDates.length === 0) {
    console.log('No historical dates to export.');
    return;
  }

  // Filter out dates that already have CSV in output/tender_types
  const existingFiles = new Set(await fs.readdir(TENDER_TYPES_DIR));
  const pendingDates = targetDates.filter(d => !existingFiles.has(`${d}_Tender_Types.csv`));

  console.log(`Pending dates to export: ${pendingDates.length} of ${targetDates.length}`);
  if (pendingDates.length === 0) {
    console.log('All daily tender types are already up to date!');
    return;
  }

  const client = new BiDiClient();
  const { cloverTab, merchantId } = await client.initialize(TENDER_TYPES_DIR);
  console.log(`Connected to Firefox BiDi. Merchant ID: ${merchantId}`);

  try {
    let count = 0;
    for (const dateStr of pendingDates) {
      console.log(`\n======================================================`);
      console.log(`[${count + 1}/${pendingDates.length}] Exporting Daily Tender Types for: ${dateStr}`);

      await exportSingleDay(client, cloverTab.context, dateStr, merchantId);
      count++;

      // Wait 1.8s between days to avoid rate limits
      await sleep(1800);
    }

    console.log(`\n All done! Successfully exported ${count} daily tender types report(s).`);

  } finally {
    console.log('Closing BiDi session cleanly...');
    try { await client.send('session.end', {}); } catch (_) {}
    client.close();
  }
}

// Allow direct CLI execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  exportAllTenderTypesDaily().catch(err => {
    console.error('Fatal error in export_tender_types_daily:', err);
    process.exit(1);
  });
}
