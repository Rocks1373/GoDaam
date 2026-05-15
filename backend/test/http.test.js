const request = require('supertest');

const describeHttp = process.env.DATABASE_URL ? describe : describe.skip;

describeHttp('HTTP API', () => {
  let app;
  beforeAll(() => {
    app = require('../server');
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /api/auth/login rejects invalid body', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: '', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
