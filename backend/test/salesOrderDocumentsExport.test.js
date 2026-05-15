const { PDFDocument } = require('pdf-lib');

jest.mock('../services/cloudStorage/cloudStorageProvider', () => ({
  downloadDocument: jest.fn(),
}));

jest.mock('../db', () => ({
  dialect: 'sqlite',
  all: jest.fn(),
}));

const cloudStorage = require('../services/cloudStorage/cloudStorageProvider');
const db = require('../db');
const { buildCombinedPdfForSalesOrder } = require('../services/salesOrderDocumentsExport');

describe('salesOrderDocumentsExport', () => {
  let singlePagePdf;

  beforeAll(async () => {
    const p = await PDFDocument.create();
    p.addPage([120, 120]);
    singlePagePdf = Buffer.from(await p.save());
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('buildCombinedPdfForSalesOrder merges multiple PDFs', async () => {
    db.all.mockImplementation((sql, params, cb) =>
      cb(null, [
        {
          id: 2,
          cloud_file_id: 'file-b',
          mime_type: 'application/pdf',
          document_type: 'POD',
          uploaded_at: '2024-01-02T00:00:00Z',
        },
        {
          id: 1,
          cloud_file_id: 'file-a',
          mime_type: 'application/pdf',
          document_type: 'INVOICE',
          uploaded_at: '2024-01-01T00:00:00Z',
        },
      ])
    );
    cloudStorage.downloadDocument.mockResolvedValue(singlePagePdf);

    const { buffer, mergedCount } = await buildCombinedPdfForSalesOrder(99, 'SO-UNIT');

    expect(mergedCount).toBe(2);
    expect(buffer.slice(0, 4).toString()).toBe('%PDF');
    expect(cloudStorage.downloadDocument).toHaveBeenCalledTimes(2);
    expect(cloudStorage.downloadDocument.mock.calls[0][0]).toBe('file-a');
    expect(cloudStorage.downloadDocument.mock.calls[1][0]).toBe('file-b');
  });

  it('buildCombinedPdfForSalesOrder throws NO_DOCS when list empty', async () => {
    db.all.mockImplementation((sql, params, cb) => cb(null, []));
    await expect(buildCombinedPdfForSalesOrder(1, 'NONE')).rejects.toMatchObject({ code: 'NO_DOCS' });
  });
});
