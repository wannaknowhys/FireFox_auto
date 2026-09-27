import path from 'path';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { expandDateRange } from './lib/date_utils.mjs';

const SALES_REPORT_DIR = path.resolve('clover_export/output/sales_report');
const TENDER_TYPES_DIR = path.resolve('clover_export/output/tender_types');
const FINAL_OUTPUT_DIR = path.resolve('clover_export/output/final_merged');

/**
 * Remove currency symbols, quotes, commas, and whitespace.
 */
function cleanNumber(val) {
  if (!val) return '0.00';
  const cleaned = String(val).replace(/[\$",\s]/g, '');
  if (!cleaned || isNaN(Number(cleaned))) return '0.00';
  // Normalize formatting to at least 2 decimal places if it looks like currency
  const num = Number(cleaned);
  return num.toFixed(2);
}

/**
 * Standard CSV line parser that respects quotes.
 */
function parseCSVLine(line) {
  const result = [];
  let curr = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(curr);
      curr = '';
    } else {
      curr += c;
    }
  }
  result.push(curr);
  return result;
}

/**
 * Extract Net sales and Tips from a Sales Report CSV.
 */
function extractSalesReportRows(content) {
  const lines = content.split('\n');
  let netSalesRow = [];
  let tipsRow = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('Net sales,')) {
      const cols = parseCSVLine(line);
      // Remove index 0 ('Net sales') and index 1 (Total), keep all daily columns
      netSalesRow = cols.slice(2).map(cleanNumber);
    } else if (line.startsWith('Tips,')) {
      const cols = parseCSVLine(line);
      // Remove index 0 ('Tips') and index 1 (Total), keep all daily columns
      tipsRow = cols.slice(2).map(cleanNumber);
    }
  }

  return { netSalesRow, tipsRow };
}

/**
 * Extract Credit Card and Debit Card Amount Collected from a daily Tender Types CSV.
 * If file does not exist or has no transactions, returns 0.00.
 */
function extractDailyTenderTypes(dateStr) {
  const filePath = path.join(TENDER_TYPES_DIR, `${dateStr}_Tender_Types.csv`);
  let creditCardAmount = '0.00';
  let debitCardAmount = '0.00';

  if (!existsSync(filePath)) {
    return { creditCardAmount, debitCardAmount };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let amountCollectedIdx = -1;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      // Detect header index for 'Amount Collected'
      if (cols.includes('Tender Types') && cols.includes('Amount Collected')) {
        amountCollectedIdx = cols.indexOf('Amount Collected');
        continue;
      }

      const tenderName = (cols[0] || '').trim();
      if (tenderName === 'Credit Card') {
        const rawVal = amountCollectedIdx >= 0 ? cols[amountCollectedIdx] : cols[cols.length - 1];
        creditCardAmount = cleanNumber(rawVal);
      } else if (tenderName === 'Debit Card') {
        const rawVal = amountCollectedIdx >= 0 ? cols[amountCollectedIdx] : cols[cols.length - 1];
        debitCardAmount = cleanNumber(rawVal);
      }
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err.message);
  }

  return { creditCardAmount, debitCardAmount };
}

/**
 * Process a single sales report file and produce the final merged CSV.
 */
async function processReportFile(fileName) {
  const isPartial = fileName.startsWith('PARTIAL_');
  const dateMatch = fileName.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;

  const [_, startDate, endDate] = dateMatch;
  const days = expandDateRange(startDate, endDate);

  const salesReportPath = path.join(SALES_REPORT_DIR, fileName);
  const content = await fs.readFile(salesReportPath, 'utf-8');
  const { netSalesRow, tipsRow } = extractSalesReportRows(content);

  const creditCardRow = [];
  const debitCardRow = [];

  for (const day of days) {
    const { creditCardAmount, debitCardAmount } = extractDailyTenderTypes(day);
    creditCardRow.push(creditCardAmount);
    debitCardRow.push(debitCardAmount);
  }

  // Ensure rows match the day count (fill 0.00 if any column missing)
  const padRow = (row, targetLen) => {
    while (row.length < targetLen) row.push('0.00');
    return row.slice(0, targetLen);
  };

  const finalNetSales = padRow(netSalesRow, days.length);
  const finalTips = padRow(tipsRow, days.length);
  const finalCredit = padRow(creditCardRow, days.length);
  const finalDebit = padRow(debitCardRow, days.length);

  // Construct pure numeric CSV: 4 lines
  const csvLines = [
    finalNetSales.join(','),
    finalTips.join(','),
    finalCredit.join(','),
    finalDebit.join(',')
  ];
  const csvOutput = csvLines.join('\r\n') + '\r\n';

  // Scheme C naming
  const prefix = isPartial ? 'PARTIAL_' : '';
  const outFileName = `${prefix}${startDate}_${endDate}_Final.csv`;
  const outPath = path.join(FINAL_OUTPUT_DIR, outFileName);

  await fs.writeFile(outPath, csvOutput, 'utf-8');
  console.log(`[Generated] ${outFileName} (${days.length} columns, 4 rows)`);

  return { outFileName, columnCount: days.length };
}

/**
 * Main merge pipeline: iterates over all sales report files and generates corresponding final CSVs.
 */
export async function mergeReports() {
  await fs.mkdir(FINAL_OUTPUT_DIR, { recursive: true });

  const files = await fs.readdir(SALES_REPORT_DIR);
  const reportFiles = files
    .filter(f => f.endsWith('_Sales_Report.csv'))
    .sort();

  console.log(`Found ${reportFiles.length} Sales Report file(s) to process.`);
  let count = 0;

  for (const rf of reportFiles) {
    const res = await processReportFile(rf);
    if (res) count++;
  }

  console.log(`\n All done! Successfully merged ${count} final deliverable file(s) into:`);
  console.log(` -> ${FINAL_OUTPUT_DIR}\n`);
}

// Allow direct CLI invocation
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  mergeReports().catch(err => {
    console.error('Fatal error in mergeReports:', err);
    process.exit(1);
  });
}
