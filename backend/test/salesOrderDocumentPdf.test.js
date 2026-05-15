const fs = require('fs');
const os = require('os');
const path = require('path');
const { finalizePodAsPdf } = require('../services/salesOrderDocumentPdf');

describe('finalizePodAsPdf', () => {
  it('rejects image/webp (policy: PDF, JPEG, PNG only)', async () => {
    const tmp = path.join(os.tmpdir(), `pod-t-${Date.now()}.webp`);
    fs.writeFileSync(tmp, Buffer.from('not-really-webp'));
    const dest = `${tmp}.pdf`;
    await expect(finalizePodAsPdf(tmp, 'image/webp', dest)).rejects.toThrow(/JPEG|PNG|PDF/);
    expect(fs.existsSync(tmp)).toBe(true);
    fs.unlinkSync(tmp);
  });
});
