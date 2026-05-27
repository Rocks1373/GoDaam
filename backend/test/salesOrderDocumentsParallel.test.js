const { computeParallelBundleStatus } = require('../services/salesOrderDocumentsService');

describe('computeParallelBundleStatus', () => {
  it('returns complete when no trio uploaded', () => {
    const s = computeParallelBundleStatus([]);
    expect(s.parallel_complete).toBe(true);
    expect(s.counts.invoice).toBe(0);
    expect(s.reminders.length).toBe(0);
  });

  it('returns complete when counts match', () => {
    const s = computeParallelBundleStatus([
      { upload_status: 'UPLOADED', document_type: 'INVOICE' },
      { upload_status: 'UPLOADED', document_type: 'DELIVERY_NOTE' },
      { upload_status: 'UPLOADED', document_type: 'ACCOUNTING_DOCUMENT' },
    ]);
    expect(s.parallel_complete).toBe(true);
    expect(s.counts.invoice).toBe(1);
    expect(s.counts.delivery_note).toBe(1);
    expect(s.counts.accounting_document).toBe(1);
  });

  it('flags incomplete when two invoices but one DN', () => {
    const s = computeParallelBundleStatus([
      { upload_status: 'UPLOADED', document_type: 'INVOICE' },
      { upload_status: 'UPLOADED', document_type: 'INVOICE' },
      { upload_status: 'UPLOADED', document_type: 'DELIVERY_NOTE' },
      { upload_status: 'UPLOADED', document_type: 'ACCOUNTING_DOCUMENT' },
    ]);
    expect(s.parallel_complete).toBe(false);
    expect(s.reminders.length).toBeGreaterThan(0);
    expect(s.counts.invoice).toBe(2);
    expect(s.counts.delivery_note).toBe(1);
    expect(s.missing.some((m) => m.document_type === 'DELIVERY_NOTE' && m.severity === 'MISSING')).toBe(true);
  });

  it('marks MISSING delivery note when invoice uploaded alone', () => {
    const s = computeParallelBundleStatus([
      { upload_status: 'UPLOADED', document_type: 'INVOICE' },
    ]);
    expect(s.missing).toHaveLength(2);
    expect(s.missing[0].message).toMatch(/MISSING.*delivery note/i);
  });

  it('reminds about customer PO when trio exists but no PO', () => {
    const s = computeParallelBundleStatus([
      { upload_status: 'UPLOADED', document_type: 'INVOICE' },
      { upload_status: 'UPLOADED', document_type: 'DELIVERY_NOTE' },
      { upload_status: 'UPLOADED', document_type: 'ACCOUNTING_DOCUMENT' },
    ]);
    expect(s.parallel_complete).toBe(true);
    expect(s.customer_po_reminder).toBeTruthy();
  });
});
