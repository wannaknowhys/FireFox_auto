[English](README.md) | [简体中文](README.zh-CN.md)

# Clover Data Pipeline & Exporter

An automated, resilient export pipeline built on native Firefox WebDriver BiDi to extract two-week sales summaries and daily tender & card types from Clover Dashboard, and produce clean 4-row numeric deliverables for downstream processing.

## Architecture

The project is structured into three clean, decoupled modules:

```text
clover_export/
├── src/
│   ├── lib/
│   │   ├── bidi_client.mjs                # Shared BiDi WebSocket client, session lifecycle, download dir management
│   │   └── date_utils.mjs                 # Date parsing, expansion, and exact timestamp calculation
│   ├── export_sales_report_biweekly.mjs   # Module 1: Incremental 14-day Sales Report exporter
│   ├── export_tender_types_daily.mjs      # Module 2: Daily Tender & Card Types exporter (historical days only)
│   ├── merge_reports.mjs                  # Module 3: Aggregation & Final Deliverable Merging
│   └── export_all.mjs                     # Unified pipeline orchestrator
├── output/
│   ├── sales_report/                      # Two-week Sales Report CSV deliverables
│   │   ├── 2026-06-29_2026-07-12_Sales_Report.csv
│   │   └── PARTIAL_2026-09-21_2026-09-27_Sales_Report.csv
│   ├── tender_types/                      # Daily Tender & Card Types CSV deliverables (90 files)
│   │   ├── 2026-06-29_Tender_Types.csv
│   │   └── ...
│   └── final_merged/                      # Pure numeric final deliverables
│       ├── 2026-06-29_2026-07-12_Final.csv (14 columns x 4 rows)
│       ├── ...
│       └── PARTIAL_2026-09-21_2026-09-27_Final.csv (7 columns x 4 rows)
├── README.md
└── README.zh-CN.md
```

## Final Deliverable Format (`output/final_merged/`)

Each final CSV contains exactly **4 rows of pure comma-separated numbers** without headers or currency symbols:

* **Row 1**: Daily `Net sales` (from Sales Report)
* **Row 2**: Daily `Tips` (from Sales Report)
* **Row 3**: Daily `Credit Card Amount Collected` (from Daily Tender Types)
* **Row 4**: Daily `Debit Card Amount Collected` (from Daily Tender Types)

### Partial Periods
* Named with `PARTIAL_` prefix (e.g. `PARTIAL_2026-09-21_2026-09-27_Final.csv`).
* Covers as many columns as elapsed days in the period (e.g. 7 columns).
* Missing dates (like today, which is not downloaded) automatically default to `0.00`.

## Usage

### Run the entire pipeline (Steps 1, 2, and 3):
```powershell
node clover_export/src/export_all.mjs
```

### Or run modules independently:
- **Module 1 - Export bi-weekly sales reports**:
  ```powershell
  node clover_export/src/export_sales_report_biweekly.mjs
  ```
- **Module 2 - Export daily tender & card types**:
  ```powershell
  node clover_export/src/export_tender_types_daily.mjs
  ```
- **Module 3 - Merge into final deliverables**:
  ```powershell
  node clover_export/src/merge_reports.mjs
  ```
