import request from 'supertest';
import jwt from 'jsonwebtoken';
import yaml from 'js-yaml';
import app from '../../src/app';
import config, { parseApiDocsMode } from '../../src/config';
import {
  filterAdminSpec,
  isAdminSpecPath,
  resetDocsSpecCache,
  SWAGGER_UI_CSP,
} from '../../src/routes/docs';
import { ErrorCode } from '../../src/utils/errorCodes';

function signToken(role: 'admin' | 'scout' | 'player' = 'admin'): string {
  return jwt.sign(
    {
      wallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      role,
    },
    config.jwtSecret,
    { expiresIn: '1h' },
  );
}

describe('OpenAPI docs routes & API_DOCS_MODE (#1552)', () => {
  const originalMode = config.apiDocs.mode;
  const originalHideAdmin = config.apiDocs.hideAdmin;

  beforeEach(() => {
    config.apiDocs.mode = 'public';
    config.apiDocs.hideAdmin = false;
    resetDocsSpecCache();
  });

  afterAll(() => {
    config.apiDocs.mode = originalMode;
    config.apiDocs.hideAdmin = originalHideAdmin;
    resetDocsSpecCache();
  });

  describe('parseApiDocsMode()', () => {
    it('defaults to "public" outside production and "admin" in production', () => {
      expect(parseApiDocsMode(undefined, 'development')).toBe('public');
      expect(parseApiDocsMode('', 'test')).toBe('public');
      expect(parseApiDocsMode('   ', 'staging')).toBe('public');
      expect(parseApiDocsMode(undefined, 'production')).toBe('admin');
      expect(parseApiDocsMode('', 'production')).toBe('admin');
    });

    it('accepts public, admin, and disabled (case-insensitive)', () => {
      expect(parseApiDocsMode('public', 'production')).toBe('public');
      expect(parseApiDocsMode('ADMIN', 'development')).toBe('admin');
      expect(parseApiDocsMode('Disabled', 'development')).toBe('disabled');
    });

    it('throws on invalid mode values', () => {
      expect(() => parseApiDocsMode('internal', 'production')).toThrow(/Invalid API_DOCS_MODE/);
      expect(() => parseApiDocsMode('none', 'development')).toThrow(/Must be one of: public, admin, disabled/);
    });
  });

  describe('API_DOCS_MODE=public', () => {
    it('serves JSON spec, YAML spec, and Swagger UI publicly across /api/docs, /api/v1/docs, and /api/v2/docs', async () => {
      for (const prefix of ['/api/docs', '/api/v1/docs', '/api/v2/docs']) {
        const jsonRes = await request(app).get(prefix);
        expect(jsonRes.status).toBe(200);
        expect(jsonRes.body.openapi).toMatch(/^3\./);
        expect(jsonRes.body.paths['/players']).toBeDefined();
        expect(jsonRes.body.paths['/admin/stats']).toBeDefined();
      }

      const yamlRes = await request(app).get('/api/docs/yaml');
      expect(yamlRes.status).toBe(200);
      expect(yamlRes.headers['content-type']).toMatch(/yaml/);
      expect(yamlRes.text).toContain('/admin/stats:');

      const uiRes = await request(app).get('/api/docs/ui');
      expect(uiRes.status).toBe(200);
      expect(uiRes.headers['content-type']).toMatch(/text\/html/);
      expect(uiRes.headers['content-security-policy']).toBe(SWAGGER_UI_CSP);
      expect(uiRes.text).toContain('SwaggerUIBundle');

      const cssRes = await request(app).get('/api/docs/swagger-ui.css');
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers['content-type']).toMatch(/text\/css/);
    });

    it('strips all /admin/* paths and the admin tag from JSON and YAML when API_DOCS_HIDE_ADMIN=true', async () => {
      config.apiDocs.mode = 'public';
      config.apiDocs.hideAdmin = true;

      const jsonRes = await request(app).get('/api/docs');
      expect(jsonRes.status).toBe(200);
      const jsonPaths = Object.keys(jsonRes.body.paths ?? {});
      expect(jsonPaths.length).toBeGreaterThan(0);
      expect(jsonPaths.some((p) => isAdminSpecPath(p))).toBe(false);
      expect(jsonRes.body.paths['/players']).toBeDefined();

      const tags = (jsonRes.body.tags ?? []) as Array<{ name: string }>;
      expect(tags.some((t) => t.name.toLowerCase() === 'admin')).toBe(false);

      const yamlRes = await request(app).get('/api/docs/yaml');
      expect(yamlRes.status).toBe(200);
      const parsedYaml = yaml.load(yamlRes.text) as Record<string, unknown>;
      const yamlPaths = Object.keys((parsedYaml.paths as Record<string, unknown>) ?? {});
      expect(yamlPaths.some((p) => isAdminSpecPath(p))).toBe(false);
      expect((parsedYaml.paths as Record<string, unknown>)['/players']).toBeDefined();
    });

    it('filterAdminSpec removes admin-only components while preserving shared components', () => {
      const sampleSpec: Record<string, unknown> = {
        openapi: '3.0.3',
        tags: [{ name: 'players' }, { name: 'admin' }],
        paths: {
          '/players': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/SharedEnvelope' },
                    },
                  },
                },
              },
            },
          },
          '/admin/secret': {
            post: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/AdminSecretPayload' },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            SharedEnvelope: { type: 'object' },
            AdminSecretPayload: { type: 'object' },
            UnreferencedAdminModel: { type: 'object', 'x-admin-only': true },
          },
        },
      };

      const filtered = filterAdminSpec(sampleSpec);
      const paths = filtered.paths as Record<string, unknown>;
      expect(paths['/players']).toBeDefined();
      expect(paths['/admin/secret']).toBeUndefined();

      const schemas = (filtered.components as { schemas: Record<string, unknown> }).schemas;
      expect(schemas.SharedEnvelope).toBeDefined();
      expect(schemas.AdminSecretPayload).toBeUndefined();
      expect(schemas.UnreferencedAdminModel).toBeUndefined();
    });
  });

  describe('API_DOCS_MODE=admin', () => {
    beforeEach(() => {
      config.apiDocs.mode = 'admin';
    });

    it('rejects unauthenticated requests with 401', async () => {
      for (const path of ['/api/docs', '/api/v1/docs', '/api/v2/docs', '/api/docs/yaml', '/api/docs/ui']) {
        const res = await request(app).get(path);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    });

    it('rejects non-admin authenticated users with 403', async () => {
      const scoutToken = signToken('scout');
      const res = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${scoutToken}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('allows authenticated admin users to access JSON, YAML, and Swagger UI', async () => {
      const adminToken = signToken('admin');

      const jsonRes = await request(app)
        .get('/api/docs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.body.paths['/admin/stats']).toBeDefined();

      const yamlRes = await request(app)
        .get('/api/docs/yaml')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(yamlRes.status).toBe(200);
      expect(yamlRes.text).toContain('/admin/stats:');

      const uiRes = await request(app)
        .get('/api/docs/ui')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(uiRes.status).toBe(200);
      expect(uiRes.headers['content-security-policy']).toBe(SWAGGER_UI_CSP);
    });
  });

  describe('API_DOCS_MODE=disabled', () => {
    beforeEach(() => {
      config.apiDocs.mode = 'disabled';
    });

    it('returns 404 for all docs endpoints even with an admin token', async () => {
      const adminToken = signToken('admin');
      for (const path of [
        '/api/docs',
        '/api/v1/docs',
        '/api/v2/docs',
        '/api/docs/yaml',
        '/api/docs/ui',
        '/api/docs/swagger-ui.css',
        '/api/docs/swagger-ui-bundle.js',
      ]) {
        const res = await request(app)
          .get(path)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          success: false,
          code: ErrorCode.NOT_FOUND,
        });
      }
    });
  });
});
