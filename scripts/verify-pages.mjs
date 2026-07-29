// Verifica que dist-pages/ NO contenga archivos internos/sensibles.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist-pages';
if (!existsSync(OUT)) { console.error('dist-pages/ no existe; corre build:pages primero'); process.exit(1); }

const FORBIDDEN = [
  /^worker\.js$/, /^auth\.js$/, /^telegram\.js$/, /^finandina-dispersion\.js$/,
  /^report-pdf\.js$/, /^recurrentes\.js$/, /^ocr-.*\.js$/, /^agent.*\.js$/,
  /\.sql$/, /\.md$/, /\.zip$/, /^package.*\.json$/, /^wrangler\.toml$/,
  /^node_modules$/, /^\.wrangler$/, /^lib$/, /-integration\.txt$/, /\.dev\.vars/, /\.env/,
];

const bad = [];
function walk(dir, rel = '') {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (FORBIDDEN.some(re => re.test(name))) bad.push(r);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, r);
  }
}
walk(OUT);

if (bad.length) {
  console.error('❌ dist-pages contiene archivos PROHIBIDOS:\n  ' + bad.join('\n  '));
  process.exit(1);
}
console.log('✅ verify:pages OK — dist-pages solo contiene assets públicos');
