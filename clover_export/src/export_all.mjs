import { exportAllSalesReports } from './export_sales_report_biweekly.mjs';
import { exportAllTenderTypesDaily } from './export_tender_types_daily.mjs';
import { mergeReports } from './merge_reports.mjs';

async function main() {
  console.log('================================================================');
  console.log('       Clover Automated Export & Processing Pipeline');
  console.log('================================================================\n');

  console.log('>>> Step 1: Exporting Bi-Weekly Sales Reports (Incremental)...');
  await exportAllSalesReports();

  console.log('\n>>> Step 2: Exporting Daily Tender & Card Types (Historical Days)...');
  await exportAllTenderTypesDaily();

  console.log('\n>>> Step 3: Merging & Generating Final Deliverables (Scheme C)...');
  await mergeReports();

  console.log('\n================================================================');
  console.log('       Pipeline Execution Completed Successfully');
  console.log('================================================================');
}

main().catch(err => {
  console.error('\nFatal error in pipeline:', err);
  process.exit(1);
});
