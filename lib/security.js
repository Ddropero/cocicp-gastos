// ============================================================
// security.js — CORS por allowlist, request-id, firma Twilio,
// anti-SSRF de medios, validación de uploads. Compatible con Workers.
// ============================================================

// ── CORS por lista permitida ────────────────────────────────
const DEFAULT_ALLOWED = [
  'https://cocicp.davidduque.com',
];
const DEV_ALLOWED = [
  'http://localhost:8787', 'http://localhost:3000', 'http://127.0.0.1:8787',
];

export function allowedOrigins(env) {
  const extra = (env && env.CORS_ORIGINS ? String(env.CORS_ORIGINS) : '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const isDev = env && env.ENVIRONMENT && env.ENVIRONMENT !== 'production';
  return new Set([...DEFAULT_ALLOWED, ...extra, ...(isDev ? DEV_ALLOWED : [])]);
}

// Devuelve headers CORS acotados al Origin de la petición si está permitido.
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allow = allowedOrigins(env);
  const h = {
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allow.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}

// ── Request-id + error genérico (no filtrar err.message) ────
export function newRequestId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
}
export function logError(reqId, where, err) {
  try {
    console.error(JSON.stringify({
      level: 'error', reqId, where,
      msg: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack).slice(0, 800) : undefined,
    }));
  } catch { console.error('logError', reqId, where, err); }
}

// ── Firma Twilio X-Twilio-Signature (HMAC-SHA1) ─────────────
// Expected = base64(HMAC-SHA1(authToken, url + sorted(k+v)...))
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
export async function twilioExpectedSignature(authToken, fullUrl, params) {
  const keys = Object.keys(params).sort();
  let data = fullUrl;
  for (const k of keys) data += k + params[k];
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64(sig);
}
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export async function verifyTwilioSignature(authToken, fullUrl, params, headerSignature) {
  if (!authToken || !headerSignature) return false;
  const expected = await twilioExpectedSignature(authToken, fullUrl, params);
  return timingSafeEqual(expected, headerSignature);
}

// ── Anti-SSRF: solo medios de Twilio por HTTPS ──────────────
const MEDIA_HOST_SUFFIXES = ['.twilio.com', '.api.twilio.com'];
const MEDIA_HOST_EXACT = ['api.twilio.com', 'media.twiliocdn.com', 'mcs.us1.twilio.com'];
export function isAllowedMediaUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (MEDIA_HOST_EXACT.includes(host)) return true;
  return MEDIA_HOST_SUFFIXES.some(suf => host.endsWith(suf));
}

// ── Validación de uploads (MIME + extensión + tamaño) ───────
export const MAX_UPLOAD_BYTES_DEFAULT = 10 * 1024 * 1024; // 10 MB
const MIME_EXT = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'application/pdf': ['pdf'],
};
export function validateUpload(file, { maxBytes = MAX_UPLOAD_BYTES_DEFAULT } = {}) {
  if (!file || typeof file !== 'object') return { ok: false, error: 'Archivo faltante' };
  const mime = String(file.type || '').toLowerCase();
  const name = String(file.name || '');
  const size = Number(file.size || 0);
  if (!MIME_EXT[mime]) return { ok: false, error: 'Tipo no permitido (solo JPEG, PNG, PDF)' };
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!MIME_EXT[mime].includes(ext)) return { ok: false, error: 'La extensión no coincide con el tipo' };
  if (size > maxBytes) return { ok: false, error: `Archivo excede ${Math.round(maxBytes / 1048576)} MB` };
  return { ok: true, mime, ext };
}
export function r2KeyForUpload(ext) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  const safeExt = /^[a-z0-9]{1,5}$/.test(String(ext)) ? ext : 'bin';
  return `soportes/${id}.${safeExt}`;
}

// ── Escape HTML (referencia testeable; index.html tiene copia inline idéntica) ──
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Roles ───────────────────────────────────────────────────
const ROLE_LEVEL = { captura: 1, revision: 2, tesoreria: 3, admin: 4 };
export function roleAtLeast(userRol, minRol) {
  return (ROLE_LEVEL[userRol] || 0) >= (ROLE_LEVEL[minRol] || 99);
}
