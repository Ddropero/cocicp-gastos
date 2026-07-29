import { describe, it, expect } from 'vitest';
import {
  isAllowedMediaUrl, validateUpload, r2KeyForUpload,
  twilioExpectedSignature, verifyTwilioSignature, roleAtLeast,
  allowedOrigins, corsHeaders, escapeHtml,
} from '../lib/security.js';

describe('escapeHtml — XSS', () => {
  it('neutraliza <script>', () => expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;'));
  it('escapa comillas de atributo', () => expect(escapeHtml('" onmouseover="alert(1)')).toBe('&quot; onmouseover=&quot;alert(1)'));
  it('escapa img onerror', () => expect(escapeHtml('<img src=x onerror=alert(1)>')).toContain('&lt;img'));
  it('texto normal intacto', () => expect(escapeHtml('EDS El Bosque S.A.S')).toBe('EDS El Bosque S.A.S'));
  it('null → cadena vacía', () => expect(escapeHtml(null)).toBe(''));
  it('no deja < ni > sin escapar', () => {
    const out = escapeHtml('a<b>c&d"e\'f');
    expect(out).not.toMatch(/[<>]/);
  });
});

describe('isAllowedMediaUrl — anti-SSRF', () => {
  it('acepta api.twilio.com https', () => expect(isAllowedMediaUrl('https://api.twilio.com/2010-04-01/x.jpg')).toBe(true));
  it('acepta subdominio twilio', () => expect(isAllowedMediaUrl('https://mcs.us1.twilio.com/Media/abc')).toBe(true));
  it('rechaza host hostil', () => expect(isAllowedMediaUrl('https://evil.example.com/x.jpg')).toBe(false));
  it('rechaza http (no TLS)', () => expect(isAllowedMediaUrl('http://api.twilio.com/x.jpg')).toBe(false));
  it('rechaza IP interna', () => expect(isAllowedMediaUrl('http://169.254.169.254/latest/meta-data')).toBe(false));
  it('rechaza twilio.com.evil.com', () => expect(isAllowedMediaUrl('https://api.twilio.com.evil.com/x')).toBe(false));
  it('rechaza basura', () => expect(isAllowedMediaUrl('not a url')).toBe(false));
});

describe('validateUpload — MIME/extensión/tamaño', () => {
  it('jpeg válido', () => expect(validateUpload({ type: 'image/jpeg', name: 'f.jpg', size: 1000 }).ok).toBe(true));
  it('png válido', () => expect(validateUpload({ type: 'image/png', name: 'f.png', size: 1000 }).ok).toBe(true));
  it('pdf válido', () => expect(validateUpload({ type: 'application/pdf', name: 'f.pdf', size: 1000 }).ok).toBe(true));
  it('rechaza ejecutable', () => expect(validateUpload({ type: 'application/x-msdownload', name: 'v.exe', size: 10 }).ok).toBe(false));
  it('rechaza mime/ext desalineados', () => expect(validateUpload({ type: 'image/png', name: 'v.exe', size: 10 }).ok).toBe(false));
  it('rechaza > 10MB', () => expect(validateUpload({ type: 'image/png', name: 'f.png', size: 11 * 1048576 }).ok).toBe(false));
  it('r2KeyForUpload usa UUID, no el nombre original', () => {
    const k = r2KeyForUpload('jpg');
    expect(k).toMatch(/^soportes\/[0-9a-f-]+\.jpg$/i);
    expect(k).not.toContain('..');
  });
});

describe('firma Twilio', () => {
  // Vector oficial de la doc de Twilio
  const token = '12345';
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' };
  const expected = 'GvWf1cFY/Q7PnoempGyD5oXAezc='; // verificado contra node:crypto HMAC-SHA1
  it('genera la firma esperada (vector oficial)', async () => {
    expect(await twilioExpectedSignature(token, url, params)).toBe(expected);
  });
  it('verifica firma válida', async () => {
    expect(await verifyTwilioSignature(token, url, params, expected)).toBe(true);
  });
  it('rechaza firma inválida', async () => {
    expect(await verifyTwilioSignature(token, url, params, 'AAAA')).toBe(false);
  });
  it('rechaza sin firma', async () => {
    expect(await verifyTwilioSignature(token, url, params, '')).toBe(false);
  });
});

describe('roles', () => {
  it('admin >= tesoreria', () => expect(roleAtLeast('admin', 'tesoreria')).toBe(true));
  it('captura < tesoreria', () => expect(roleAtLeast('captura', 'tesoreria')).toBe(false));
  it('rol desconocido < cualquiera', () => expect(roleAtLeast('x', 'captura')).toBe(false));
});

describe('CORS allowlist', () => {
  it('incluye producción', () => expect(allowedOrigins({ ENVIRONMENT: 'production' }).has('https://cocicp.davidduque.com')).toBe(true));
  it('no incluye localhost en prod', () => expect(allowedOrigins({ ENVIRONMENT: 'production' }).has('http://localhost:8787')).toBe(false));
  it('incluye localhost en dev', () => expect(allowedOrigins({ ENVIRONMENT: 'development' }).has('http://localhost:8787')).toBe(true));
  it('no refleja origin no permitido', () => {
    const h = corsHeaders({ headers: { get: () => 'https://evil.com' } }, { ENVIRONMENT: 'production' });
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
  });
  it('refleja origin permitido', () => {
    const h = corsHeaders({ headers: { get: () => 'https://cocicp.davidduque.com' } }, { ENVIRONMENT: 'production' });
    expect(h['Access-Control-Allow-Origin']).toBe('https://cocicp.davidduque.com');
  });
});
