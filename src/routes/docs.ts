/**
 * OpenAPI documentation routes.
 *
 * GET /api/docs        → OpenAPI 3.0 spec as JSON
 * GET /api/docs/ui     → Swagger UI (if swagger-ui-dist is installed)
 * GET /api/docs/yaml   → OpenAPI 3.0 spec as YAML (raw)
 */

import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import config from '../config';
import { requireRole } from '../middleware/auth';
import { ErrorCode } from '../utils/errorCodes';

const router = Router();

const adminRoleMiddleware = requireRole('admin');

/**
 * Guard middleware enforcing `config.apiDocs.mode`:
 * - `'disabled'`: returns 404 Not Found for every docs route and asset
 * - `'admin'`: requires an authenticated admin JWT (`requireRole('admin')`)
 * - `'public'`: allows unauthenticated access
 */
function apiDocsGuard(req: Request, res: Response, next: NextFunction): void {
  const mode = config.apiDocs?.mode ?? 'public';
  if (mode === 'disabled') {
    res.status(404).json({
      success: false,
      error: 'API documentation is disabled',
      code: ErrorCode.NOT_FOUND,
    });
    return;
  }
  if (mode === 'admin') {
    adminRoleMiddleware(req, res, next);
    return;
  }
  next();
}

router.use(apiDocsGuard);

// Resolve the spec files relative to this source file
const SPEC_YAML_PATH = path.join(__dirname, '..', 'openapi.yaml');
const SPEC_JSON_PATH = path.join(__dirname, '..', 'openapi.json');

/** Parse YAML into a JS object without external runtime dependencies. */
function parseYamlSpec(yamlText: string): Record<string, unknown> {
  // Use js-yaml if available, otherwise fall back to require()'ing the pre-built JSON
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml') as typeof import('js-yaml');
    return yaml.load(yamlText) as Record<string, unknown>;
  } catch {
    // js-yaml not installed — return the pre-built JSON instead
    return JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
  }
}

/** Serialize a spec object back to YAML. */
function dumpYamlSpec(spec: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require('js-yaml') as typeof import('js-yaml');
  return yaml.dump(spec, { noRefs: true, lineWidth: 120 });
}

const ADMIN_PATH_REGEX = /^(?:\/api(?:\/v\d+)?)?\/admin(?:\/|$)/i;

export function isAdminSpecPath(pathKey: string): boolean {
  return ADMIN_PATH_REGEX.test(pathKey);
}

function collectComponentRefs(node: unknown, refs: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectComponentRefs(item, refs);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#/components/')) {
    refs.add(record.$ref);
  }
  for (const val of Object.values(record)) {
    collectComponentRefs(val, refs);
  }
}

/**
 * Returns a deep-cloned OpenAPI spec with `/admin/*` paths, the `'admin'` tag,
 * and admin-only components removed.
 */
export function filterAdminSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
  const adminRefs = new Set<string>();

  if (cloned.paths && typeof cloned.paths === 'object') {
    const pathsObj = cloned.paths as Record<string, unknown>;
    for (const [pathKey, pathItem] of Object.entries(pathsObj)) {
      if (isAdminSpecPath(pathKey)) {
        collectComponentRefs(pathItem, adminRefs);
        delete pathsObj[pathKey];
      }
    }
  }

  if (Array.isArray(cloned.tags)) {
    cloned.tags = cloned.tags.filter((tag) => {
      if (tag && typeof tag === 'object' && 'name' in tag) {
        return String((tag as { name: unknown }).name).toLowerCase() !== 'admin';
      }
      return true;
    });
  }

  if (cloned.components && typeof cloned.components === 'object') {
    const remainingRefs = new Set<string>();
    collectComponentRefs(cloned.paths, remainingRefs);

    const componentsObj = cloned.components as Record<string, Record<string, unknown>>;
    for (const [section, entries] of Object.entries(componentsObj)) {
      if (!entries || typeof entries !== 'object') continue;
      for (const [compName, compVal] of Object.entries(entries)) {
        const refKey = `#/components/${section}/${compName}`;
        const isExplicitAdminComp =
          /^admin/i.test(compName) ||
          Boolean(
            compVal &&
              typeof compVal === 'object' &&
              (compVal as Record<string, unknown>)['x-admin-only'] === true,
          );
        if (!remainingRefs.has(refKey) && (adminRefs.has(refKey) || isExplicitAdminComp)) {
          delete entries[compName];
        }
      }
    }
  }

  return cloned;
}

/** Lazily parsed and filtered specs — computed once and cached. */
let cachedFullSpec: Record<string, unknown> | null = null;
let cachedFilteredSpec: Record<string, unknown> | null = null;
let cachedFullYaml: string | null = null;
let cachedFilteredYaml: string | null = null;

export function resetDocsSpecCache(): void {
  cachedFullSpec = null;
  cachedFilteredSpec = null;
  cachedFullYaml = null;
  cachedFilteredYaml = null;
}

function loadBaseSpec(): Record<string, unknown> {
  if (cachedFullSpec) return cachedFullSpec;
  if (fs.existsSync(SPEC_YAML_PATH)) {
    const raw = fs.readFileSync(SPEC_YAML_PATH, 'utf8');
    cachedFullYaml = raw;
    cachedFullSpec = parseYamlSpec(raw);
  } else if (fs.existsSync(SPEC_JSON_PATH)) {
    cachedFullSpec = JSON.parse(fs.readFileSync(SPEC_JSON_PATH, 'utf8')) as Record<string, unknown>;
  } else {
    throw new Error('OpenAPI spec not found. Expected openapi.yaml or openapi.json in the project root.');
  }
  return cachedFullSpec;
}

function shouldHideAdmin(): boolean {
  const mode = config.apiDocs?.mode ?? 'public';
  return mode === 'public' && Boolean(config.apiDocs?.hideAdmin);
}

function loadSpec(): Record<string, unknown> {
  const base = loadBaseSpec();
  if (!shouldHideAdmin()) {
    return base;
  }
  if (!cachedFilteredSpec) {
    cachedFilteredSpec = filterAdminSpec(base);
  }
  return cachedFilteredSpec;
}

function loadYaml(): string {
  if (!shouldHideAdmin()) {
    if (!cachedFullYaml) {
      cachedFullYaml = fs.readFileSync(SPEC_YAML_PATH, 'utf8');
    }
    return cachedFullYaml;
  }
  if (!cachedFilteredYaml) {
    const filtered = loadSpec();
    cachedFilteredYaml = dumpYamlSpec(filtered);
  }
  return cachedFilteredYaml;
}

/**
 * Content-Security-Policy for the Swagger UI page.
 * `src/middleware/securityHeaders.ts` sets `default-src 'none'` by default for
 * JSON API endpoints; the `/ui` HTML page needs to load its own stylesheet,
 * script bundle, inline initializer, data-URI icons, and OpenAPI spec URL.
 */
export const SWAGGER_UI_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/**
 * GET /api/docs
 * Returns the OpenAPI 3.0 specification as JSON.
 *
 * @response 200 OpenAPI 3.0 document (application/json)
 * @response 500 { success: false, error: string } - Spec file missing or unparsable
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const spec = loadSpec();
    res.json(spec);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec' });
  }
});

/**
 * GET /api/docs/yaml
 * Returns the raw OpenAPI YAML source.
 *
 * @response 200 Raw OpenAPI YAML (text/yaml)
 * @response 500 { success: false, error: string } - Spec file missing
 */
router.get('/yaml', (_req: Request, res: Response) => {
  try {
    const raw = loadYaml();
    res.type('text/yaml').send(raw);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load OpenAPI spec YAML' });
  }
});

/**
 * GET /api/docs/ui
 * Serves embedded Swagger UI.
 * Requires `swagger-ui-dist` to be installed:
 *   npm install swagger-ui-dist
 *
 * @response 200 Swagger UI HTML page (text/html)
 * @response 501 { success: false, error: string } - swagger-ui-dist not installed
 */
router.get('/ui', (req: Request, res: Response) => {
  const assetRoot = req.baseUrl;
  const assetDir = path.dirname(require.resolve('swagger-ui-dist/swagger-ui.css'));
  const cssPath = path.join(assetDir, 'swagger-ui.css');
  const bundlePath = path.join(assetDir, 'swagger-ui-bundle.js');

  const assetFiles = [
    ['swagger-ui.css', cssPath],
    ['swagger-ui-bundle.js', bundlePath],
  ];

  for (const [name, filePath] of assetFiles) {
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(assetDir))) {
      res.status(500).json({ success: false, error: `Invalid asset path for ${name}` });
      return;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ScoutOff API Docs</title>
  <link rel="stylesheet" href="${assetRoot}/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${assetRoot}/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${req.baseUrl}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
    });
  </script>
</body>
</html>`;

  res.setHeader('Content-Security-Policy', SWAGGER_UI_CSP);
  res.type('html').send(html);
});

/**
 * GET /api/docs/swagger-ui.css
 * Serves the Swagger UI stylesheet from swagger-ui-dist for the /ui page.
 *
 * @response 200 Swagger UI stylesheet (text/css)
 */
router.get('/swagger-ui.css', (_req: Request, res: Response) => {
  const cssPath = require.resolve('swagger-ui-dist/swagger-ui.css');
  res.type('text/css').sendFile(cssPath);
});

/**
 * GET /api/docs/swagger-ui-bundle.js
 * Serves the Swagger UI JavaScript bundle from swagger-ui-dist for the /ui page.
 *
 * @response 200 Swagger UI JavaScript bundle (text/javascript)
 */
router.get('/swagger-ui-bundle.js', (_req: Request, res: Response) => {
  const jsPath = require.resolve('swagger-ui-dist/swagger-ui-bundle.js');
  res.type('text/javascript').sendFile(jsPath);
});

export default router;
