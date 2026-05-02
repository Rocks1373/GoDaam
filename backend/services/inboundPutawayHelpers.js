const { promisify } = require('util');
const db = require('../db');

const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));

async function updateInboundBatchStatus(batchId) {
  const row = await dbGet(
    `SELECT
       SUM(CASE WHEN remaining_qty > 1e-9 THEN 1 ELSE 0 END) AS open_items,
       COALESCE(SUM(putaway_qty), 0) AS putsum
     FROM inbound_items WHERE inbound_batch_id = ?`,
    [batchId]
  );
  const openItems = Number(row?.open_items) || 0;
  const putsum = Number(row?.putsum) || 0;
  let status = 'Pending';
  if (openItems === 0 && putsum > 0) status = 'Completed';
  else if (putsum > 0) status = 'In Progress';
  await dbRun(`UPDATE inbound_batches SET status = ? WHERE id = ?`, [status, batchId]);
}

module.exports = { updateInboundBatchStatus };
