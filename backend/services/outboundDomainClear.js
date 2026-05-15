/**
 * Deletes every row from outbound-related tables (SQLite FK-safe order).
 * Does NOT touch main_stock, stock_by_rack, users, customers, notifications, etc.
 */

const OUTBOUND_TABLES_ORDER = [
  'pick_change_requests',
  'fifo_suggestions',
  'picked_transactions',
  'picked_orders',
  'pick_suggestions',
  'delivered_outbounds',
  'outbound_bom_requirements',
  'outbound_items',
  'outbound_orders',
];

/** Whitelisted for admin browse endpoint — outbound workflow only */
const BROWSE_WHITELIST = new Set([
  'outbound_orders',
  'outbound_items',
  'outbound_bom_requirements',
  'fifo_suggestions',
  'picked_transactions',
  'picked_orders',
  'pick_change_requests',
  'pick_suggestions',
  'delivered_outbounds',
]);

async function clearOutboundDomain(dbRun) {
  await dbRun('BEGIN IMMEDIATE');
  try {
    for (const table of OUTBOUND_TABLES_ORDER) {
      await dbRun(`DELETE FROM ${table}`);
    }
    await dbRun('COMMIT');
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

module.exports = {
  OUTBOUND_TABLES_ORDER,
  BROWSE_WHITELIST,
  clearOutboundDomain,
};
