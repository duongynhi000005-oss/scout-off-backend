import request from 'supertest';
import app from '../../src/app';

describe('404 fallback handler', () => {
  it('returns 404 JSON for unknown path including correlationId', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(typeof res.body.correlationId).toBe('string');
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id']);
    expect(res.body).toEqual({
      success: false,
      error: 'Not Found',
      code: 'NOT_FOUND',
      path: '/api/does-not-exist',
      correlationId: res.headers['x-correlation-id'],
    });
  });

  it('echoes a caller-provided X-Correlation-ID in the 404 JSON body', async () => {
    const customCorrelationId = 'req-404-correlation-test-123';
    const res = await request(app)
      .get('/api/does-not-exist')
      .set('X-Correlation-ID', customCorrelationId);
    expect(res.status).toBe(404);
    expect(res.headers['x-correlation-id']).toBe(customCorrelationId);
    expect(res.body.correlationId).toBe(customCorrelationId);
  });

  it('returns application/json content-type for unknown path', async () => {
    const res = await request(app).get('/unknown/route');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.status).toBe(404);
  });

  it('includes the requested path in the response body', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not Found', path: '/api/nonexistent' });
  });

  it('known routes still work normally', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
