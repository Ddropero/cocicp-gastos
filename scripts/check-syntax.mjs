// Chequeo de sintaxis de todos los JS propios (no node_modules).
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SKIP = new Set(['node_modules', '.wrangler', '.git', 'dist-pages', 'documentos-deploy']);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) files.push(p);
  }
}
walk('.');

let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error('SYNTAX FAIL:', f, '\n', String(e.stderr || e).slice(0, 400)); }
}
console.log(`check-syntax: ${files.length} archivos, ${bad} con error`);
process.exit(bad ? 1 : 0);
