[English](README.md) | [简体中文](README.zh-CN.md)

# Clover 数据导出与处理流水线

基于原生 Firefox WebDriver BiDi 协议构建的自动化数据导出工程，支持两周销售总览报表与每日支付方式明细报表的增量下载与数据对齐，并自动生成下游处理专用的纯数字 4 行报表。

## 系统架构与模块划分

整体代码划分为三个高内聚、低耦合的核心模块：

```text
clover_export/
├── src/
│   ├── lib/
│   │   ├── bidi_client.mjs                # 公共 BiDi WebSocket 客户端、Session 生命周期管理、下载路径配置
│   │   └── date_utils.mjs                 # 日期格式化、加减计算、区间展开与整秒时间戳计算
│   ├── export_sales_report_biweekly.mjs   # 模块 1：两周销售总览增量导出（严格 14 天切口对齐）
│   ├── export_tender_types_daily.mjs      # 模块 2：每日支付方式明细增量导出（严格排除今日）
│   ├── merge_reports.mjs                  # 模块 3：汇总合并最终纯数字产物（方案 C 命名）
│   └── export_all.mjs                     # 全流水线统一调度入口
├── output/
│   ├── sales_report/                      # 两周销售总览报表 CSV
│   │   ├── 2026-06-29_2026-07-12_Sales_Report.csv
│   │   └── PARTIAL_2026-09-21_2026-09-27_Sales_Report.csv
│   ├── tender_types/                      # 每日支付方式明细报表 CSV（90 个文件）
│   │   ├── 2026-06-29_Tender_Types.csv
│   │   └── ...
│   └── final_merged/                      # 最终 4 行纯数字合并产物
│       ├── 2026-06-29_2026-07-12_Final.csv（14 列纯数字）
│       ├── ...
│       └── PARTIAL_2026-09-21_2026-09-27_Final.csv（7 列纯数字，今日自动补 0）
├── README.md
└── README.zh-CN.md
```

## 最终合并产物规范 (`output/final_merged/`)

每个合并生成的 CSV 文件严格由 **4 行纯数字**构成，逗号分隔，没有任何列头、行头或货币符号（`$`、`,` 全部剔除）：

* **第 1 行**：每日 `Net sales`（净销售额）
* **第 2 行**：每日 `Tips`（小费）
* **第 3 行**：每日 `Credit Card` 的 `Amount Collected`（信用卡收款总额）
* **第 4 行**：每日 `Debit Card` 的 `Amount Collected`（借记卡收款总额）

### 半周期处理规则：
* 采用 `PARTIAL_` 前缀（如 `PARTIAL_2026-09-21_2026-09-27_Final.csv`）；
* 覆盖该半周期真实经过的天数（如 7 列）；
* 缺失的单日数据（如未下载的今日）自动补齐为 `0.00`，绝不报错或位移。

## 使用方法

### 一键执行全流水线（步骤 1 + 步骤 2 + 步骤 3）：
```powershell
node clover_export/src/export_all.mjs
```

### 或单独执行各个模块：
- **步骤 1 - 导出两周销售总览**：
  ```powershell
  node clover_export/src/export_sales_report_biweekly.mjs
  ```
- **步骤 2 - 导出每日支付方式明细**：
  ```powershell
  node clover_export/src/export_tender_types_daily.mjs
  ```
- **步骤 3 - 合并生成最终产物**：
  ```powershell
  node clover_export/src/merge_reports.mjs
  ```
