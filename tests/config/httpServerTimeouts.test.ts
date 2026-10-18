import http from 'http';

describe('HTTP server timeout configuration (#1593)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS;
    delete process.env.HTTP_HEADERS_TIMEOUT_MS;
    delete process.env.HTTP_REQUEST_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('defaults keepAliveTimeoutMs=65000, headersTimeoutMs=66000, requestTimeoutMs=120000', () => {
    const config = require('../../src/config').default;
    expect(config.http).toEqual({
      keepAliveTimeoutMs: 65000,
      headersTimeoutMs: 66000,
      requestTimeoutMs: 120000,
    });
  });

  it('parses custom HTTP server timeouts when headersTimeout > keepAliveTimeout', () => {
    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS = '70000';
    process.env.HTTP_HEADERS_TIMEOUT_MS = '75000';
    process.env.HTTP_REQUEST_TIMEOUT_MS = '90000';

    const config = require('../../src/config').default;
    expect(config.http).toEqual({
      keepAliveTimeoutMs: 70000,
      headersTimeoutMs: 75000,
      requestTimeoutMs: 90000,
    });
  });

  it('throws when HTTP_HEADERS_TIMEOUT_MS <= HTTP_KEEP_ALIVE_TIMEOUT_MS', () => {
    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS = '65000';
    process.env.HTTP_HEADERS_TIMEOUT_MS = '65000';

    expect(() => require('../../src/config')).toThrow(
      /HTTP_HEADERS_TIMEOUT_MS \(65000\) must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS \(65000\)/,
    );
  });

  it('applies timeouts to an http.Server and allows long-lived SSE streams beyond requestTimeout', async () => {
    const config = require('../../src/config').default;
    const server = http.createServer((req, res) => {
      if (req.url === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('data: ping1\n\n');
        setTimeout(() => {
          res.write('data: ping2\n\n');
          res.end();
        }, 80);
      }
    });

    server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
    server.headersTimeout = config.http.headersTimeoutMs;
    // Set a short requestTimeout (30ms) to verify an active SSE stream stays open past 80ms
    server.requestTimeout = 30;

    expect(server.keepAliveTimeout).toBe(65000);
    expect(server.headersTimeout).toBe(66000);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        http
          .get(`http://127.0.0.1:${addr.port}/sse`, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              try {
                expect(body).toContain('data: ping1');
                expect(body).toContain('data: ping2');
                server.close(() => resolve());
              } catch (err) {
                server.close(() => reject(err));
              }
            });
          })
          .on('error', (err) => {
            server.close(() => reject(err));
          });
      });
    });
  });
});
