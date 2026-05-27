/**
 * Stock Comparison Report — column labels, tooltips (data source), and default widths (px).
 */

export const COL_TOOLTIPS = {
  part_number: 'Main stock · part_number (warehouse master record)',
  sap_part_number: 'Main stock · sap_part_number (SAP/reg. number on the master row)',
  sap_lookup_material: 'SAP upload · material # matched for this line from the latest processed batch',
  description: 'Main stock · description',
  vendor_number: 'Main stock · vendor_number (or SAP row vendor when comparing from SAP)',
  vendor_name: 'Main stock · vendor_name',
  main_stock_available_qty: 'Main stock · available_qty (source of truth quantity)',
  picked_not_delivered_qty:
    'Outbound · SUM(picked qty) on orders not yet delivered (no delivered_outbounds row; status not Delivered/Cancelled)',
  main_stock_compare_qty:
    'Computed · main_stock_available_qty − picked_not_delivered_qty (must equal stock upload qty to match)',
  compare_result_qty: 'Computed · Main stock total − Picked not delivered',
  adjusted_main_qty: 'Same as Result (main stock total − picked not delivered)',
  stock_upload_qty:
    'SAP Stock Excel upload · latest processed batch, sum of unrestricted/stock qty for ticked storage locations',
  sap_qty_on_main: 'Main stock · sap_qty (1004+1007 physical total copied from last SAP refresh)',
  sap_physical_qty:
    'SAP upload · sum of unrestricted/stock qty for the selected storage locations only (same batch); per-SL columns show full batch buckets',
  sap_transit_1002: 'SAP upload · unrestricted qty in storage location 1002',
  sap_qty_1003: 'SAP upload · unrestricted qty in storage location 1003',
  sap_qty_1004: 'SAP upload · unrestricted qty in storage location 1004',
  sap_qty_1007: 'SAP upload · unrestricted qty in storage location 1007',
  main_vs_sap_difference: 'Computed · Main for SAP − SAP physical (same as Adj − SAP)',
  difference: 'Computed · Result − SAP stock (0 = Matching; less or excess = Mismatching)',
  sap_balance:
    'Computed · OK when quantities match or both zero; Excess when main quantity is higher; Less when main quantity is lower',
  stock_by_rack_available_qty: 'Stock by rack · SUM(available_qty) over rows matching this part or SAP part',
  main_vs_rack_difference: 'Computed · main_stock_available_qty − rack_sum',
  rack_balance: 'Computed · OK / Excess / Less for main quantity versus summed rack quantity',
  comparison_result: 'Matching only when SAP diff and rack diff are both zero; otherwise Mismatching',
  sap_qty: 'Main stock · sap_qty (reference on rack-only report)',
  difference: 'Computed · depends on report mode',
  status: 'Computed · depends on report mode',
  sap_material: 'SAP upload · material number (SAP-led comparison)',
  main_stock_qty: 'Main stock · matched available_qty for this SAP material',
  material_group: 'SAP upload · material_group',
};

/** Default widths when nothing saved in localStorage */
export const DEFAULT_COL_WIDTHS = {
  part_number: 118,
  sap_part_number: 132,
  sap_lookup_material: 124,
  description: 240,
  vendor_number: 92,
  vendor_name: 156,
  main_stock_available_qty: 78,
  picked_not_delivered_qty: 88,
  main_stock_compare_qty: 88,
  compare_result_qty: 72,
  adjusted_main_qty: 72,
  stock_upload_qty: 96,
  sap_qty_on_main: 96,
  sap_physical_qty: 92,
  sap_transit_1002: 78,
  sap_qty_1003: 64,
  sap_qty_1004: 64,
  sap_qty_1007: 64,
  main_vs_sap_difference: 84,
  sap_balance: 88,
  stock_by_rack_available_qty: 82,
  main_vs_rack_difference: 84,
  rack_balance: 88,
  comparison_result: 104,
  sap_qty: 84,
  difference: 84,
  status: 104,
  sap_material: 124,
  main_stock_qty: 84,
  material_group: 104,
};

export const WIDTH_STORAGE_KEY = 'godam_stock_comparison_col_widths_v1';

/** Unified mode: second header row group titles + colSpans */
export const UNIFIED_GROUP_HEADER = [
  { title: 'Identification (main stock master)', colSpan: 6 },
  { title: 'Main stock', colSpan: 3 },
  { title: 'SAP upload (latest batch)', colSpan: 6 },
  { title: 'Compare vs SAP', colSpan: 2 },
  { title: 'Stock by rack (summed)', colSpan: 3 },
  { title: 'Line result', colSpan: 1 },
];
