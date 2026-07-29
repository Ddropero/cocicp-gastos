// Compila dist-pages/ con LISTA POSITIVA (allowlist).
// Solo assets públicos entran; nada de código de servidor, secretos ni SQL.
import { rmSync, mkdirSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';

const OUT = 'dist-pages';

// Únicos archivos que pueden ser públicos (frontend Pages).
const ALLOW = [
  'index.html',
  'app.html',
  'login.html',
  'styles.css',
  'sw.js',
  'manifest.json',
  'manifest-captura.json',
];
// Extensiones de iconos/estáticos permitidas si existen (sueltas o en /assets, /icons).
const ALLOW_EXT = ['.png', '.svg', '.ico', '.webmanifest', '.css', '.woff2'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const f of ALLOW) {
  if (existsSync(f)) { copyFileSync(f, `${OUT}/${f}`); copied++; }
}

// _headers para Cloudflare Pages (cabeceras de seguridad públicas)
// CSP compatible con el sitio actual (fonts, SheetJS, API). 'unsafe-inline' es
// temporal hasta extraer los scripts/estilos inline (Fase 2.5/2.6). Pendiente: SRI en CDNs.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.sheetjs.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cocicp-gastos.ddropero.workers.dev",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');
writeFileSync(`${OUT}/_headers`, [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: geolocation=(), microphone=(), camera=()',
  '  Content-Security-Policy: ' + CSP,
  '',
].join('\n'));

console.log(`build:pages → ${OUT}/ (${copied} assets + _headers)`);
