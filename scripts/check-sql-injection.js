const fs = require('fs');
const path = require('path');

const DEFAULT_SRC_DIR = path.join(__dirname, '../src');

// Line-comment markers that suppress a match on the line immediately below them.
// Only use these for interpolation of pre-built query fragments (WHERE/ORDER BY
// clauses, column names, driver-specific SQL snippets) that are themselves
// assembled from hardcoded strings and `?` placeholders — never for raw
// values, which must always be passed as query parameters.
const SUPPRESS_MARKER = 'sql-injection-check-ignore';
const SUPPRESS_MARKERS = [SUPPRESS_MARKER, 'sql-injection-ok:'];

function isSuppressed(precedingLine) {
  return SUPPRESS_MARKERS.some((marker) => precedingLine.includes(marker));
}

function collectTypeScriptFiles(rootDir, results = []) {
  if (!fs.existsSync(rootDir)) {
    return results;
  }
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'frontend') {
        continue;
      }
      collectTypeScriptFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  // Look for backticks containing SQL statements followed by string interpolation ${
  const sqlInterpolationRegex =
    /`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b[^`]*\$\{.*?\}[^`]*`/gi;

  const findings = [];
  let match;
  while ((match = sqlInterpolationRegex.exec(content)) !== null) {
    const matchStartLine = content.slice(0, match.index).split(/\r?\n/).length; // 1-indexed
    const precedingLine = lines[matchStartLine - 2] || ''; // line immediately above the match
    if (isSuppressed(precedingLine)) {
      continue;
    }
    findings.push({
      filePath,
      line: matchStartLine,
      snippet: match[0],
    });
  }
  return findings;
}

function scanDirectory(rootDir = DEFAULT_SRC_DIR) {
  const files = collectTypeScriptFiles(rootDir);
  const findings = [];
  for (const file of files) {
    findings.push(...scanFile(file));
  }
  return findings;
}

if (require.main === module) {
  const targetDir = process.env.SQL_INJECTION_SCAN_DIR
    ? path.resolve(process.env.SQL_INJECTION_SCAN_DIR)
    : DEFAULT_SRC_DIR;
  const findings = scanDirectory(targetDir);

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`[FAIL] SQL string interpolation found in ${finding.filePath}:\n${finding.snippet}\n`);
    }
    process.exit(1);
  } else {
    console.log('[PASS] No SQL string interpolation detected.');
  }
}

module.exports = {
  SUPPRESS_MARKER,
  SUPPRESS_MARKERS,
  collectTypeScriptFiles,
  scanFile,
  scanDirectory,
};
