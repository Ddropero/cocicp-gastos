// ============================================================
// COCICP Gastos — Worker Cloudflare
// 3 agentes en paralelo con Promise.all()
// Bindings: DB (D1) | BUCKET (R2) | ANTHROPIC_API_KEY (secret)
// ============================================================

import { runAgent1 } from './agent1-fiscal.js';
import { runAgent2 } from './agent2-provider.js';
import { runAgent3 } from './agent3-classification.js';
import { runUnifiedAgent } from './agent-unified.js';
import { runOcrAgent } from './agent-router.js';
import { checkRecurrentes } from './recurrentes.js';
import { generateReport } from './report-pdf.js';
import {
  hashPassword, verifyPassword,
  generateTotpSecret, verifyTotp, totpUri, qrCodeUrl,
  createSession, deleteSession, verifyRequest, sha256Hex
} from './auth.js';
import { handleTelegramUpdate, setupWebhook, checkWebhookHealth, healWebhook } from './telegram.js';
import {
  generarArchivoDispersion,
  sugerirNombreArchivo,
  contentToLatin1Bytes,
  BANCO_A_FINANDINA,
  BANCOS_FINANDINA,
} from './finandina-dispersion.js';
import { extraerCertificadoBancario, splitTitular } from './ocr-certificado-bancario.js';
import {
  corsHeaders, newRequestId, logError,
  verifyTwilioSignature, isAllowedMediaUrl,
  validateUpload, r2KeyForUpload, roleAtLeast, timingSafeEqual,
} from './lib/security.js';
import {
  validateGastoPayload, sanitizePayAmount, parseMoneyCO,
  anioActualBogota, fechaBogotaISO, isPositiveId, isValidDateStr, csvCell,
  matchDianFila,
} from './lib/finance-utils.js';

// Cabeceras internas (respuestas no-CORS: cron, errores tempranos). NO usa '*'.
const CORS_HEADERS = {
  'Vary': 'Origin',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Access-Control-Max-Age': '86400'
};

// json() de módulo (fallback para scheduled). Los endpoints usan el json local con CORS por origen.
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

// ── Merge de los 3 resultados ────────────────────────────────
function mergeAgents(a1, a2, a3, usuario) {
  const errores = [a1, a2, a3]
    .filter(a => a.error)
    .map(a => `Agente ${a.agent}: ${a.error}`);

  const nit = a2.emisor?.nit || null;
  const nitSinDv = a2.emisor?.nit_sin_dv || null;
  const nombreProveedor = a2.catalogo_match?.nombre_corto
    || a2.emisor?.nombre_comercial
    || a2.emisor?.razon_social
    || 'Proveedor desconocido';

  const categoria = a3.categoria
    || a2.catalogo_match?.categoria_default
    || 'Misceláneos';

  const confianzaMap = { alta: 3, media: 2, baja: 1 };
  const confianzaMin = Math.min(
    confianzaMap[a1.confianza] || 1,
    confianzaMap[a2.confianza] || 1,
    confianzaMap[a3.confianza] || 1
  );
  const confianza = Object.keys(confianzaMap).find(k => confianzaMap[k] === confianzaMin);
  const estado = (confianza === 'baja' || errores.length > 0) ? 'revision' : 'confirmado';

  return {
    proveedor_nit:            nit,
    proveedor_nit_sin_dv:     nitSinDv,
    proveedor_nombre:         nombreProveedor,
    proveedor_razon_social:   a2.emisor?.razon_social || null,
    en_catalogo:              !!a2.catalogo_match,
    numero_documento:         a1.numero_documento || null,
    tipo_documento:           a1.tipo_documento || 'otro',
    es_documento_electronico: a2.es_documento_electronico || false,
    cufe_cude:                a2.cufe_cude || null,
    fecha:                    a1.fecha_pago || a1.fecha_emision || null,
    fecha_emision:            a1.fecha_emision || null,
    categoria,
    concepto:                 a3.concepto || 'Sin concepto',
    deducible_cocicp:         a3.deducible_cocicp ?? true,
    es_viatico:               a3.es_viatico || false,
    municipio_gasto:          a3.municipio_gasto || null,
    valor_base:               a1.valores?.subtotal || 0,
    iva:                      a1.valores?.iva || 0,
    inc:                      a1.valores?.inc || 0,
    otros_impuestos:          (a1.valores?.impo_consumo || 0) + (a1.valores?.otros_impuestos || 0),
    descuentos:               a1.valores?.descuentos || 0,
    total:                    a1.valores?.total || 0,
    es_nota_credito:          a1.es_nota_credito || false,
    moneda:                   a1.moneda || 'COP',
    medio_pago:               a1.medio_pago || null,
    referencia_pago:          a1.referencia_pago || null,
    usuario,
    estado,
    confianza_global:         confianza,
    errores_parciales:        errores.length > 0 ? errores : null,
    notas:                    a3.notas_clasificacion || null,
    _agents_raw:              { a1, a2, a3 }
  };
}

// Detector de duplicados.
//   hard  = bloqueo definitivo (mismo nº de documento + mismo proveedor)
//   soft  = aviso para revisión, confirmable con autorización explícita (forzar)
async function checkDuplicate(db, numeroDocumento, total, fecha, proveedorNit) {
  if (!db) return null;
  // 1. HARD: mismo numero_documento + mismo proveedor (verdadero duplicado)
  if (numeroDocumento && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ? AND proveedor_nit = ?'
    ).bind(numeroDocumento, proveedorNit).first();
    if (row) return { tipo: 'numero_documento', severidad: 'hard', registro: row };
  } else if (numeroDocumento) {
    // Sin NIT: mismo número, se marca como aviso (no bloqueo definitivo)
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ?'
    ).bind(numeroDocumento).first();
    if (row) return { tipo: 'numero_documento_sin_nit', severidad: 'soft', registro: row };
  }
  // 2. SOFT: mismo total + fecha + proveedor
  if (total && fecha && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND proveedor_nit = ?'
    ).bind(total, fecha, proveedorNit).first();
    if (row) return { tipo: 'total_fecha_proveedor', severidad: 'soft', registro: row };
  }
  // 3. SOFT: mismo total + fecha (sin proveedor) — nunca bloqueo definitivo
  if (total && fecha) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ?'
    ).bind(total, fecha).first();
    if (row) return { tipo: 'total_fecha', severidad: 'soft', registro: row };
  }
  return null;
}

// ── Formato COP sin decimales ───────────────────────────────
function formatCOP(value) {
  if (!value && value !== 0) return '0';
  return Math.round(Math.abs(value)).toLocaleString('es-CO');
}

// ── Enviar respuesta por WhatsApp via Twilio REST API ───────
async function sendWhatsAppReply(env, to, message) {
  const twilioSid   = env.TWILIO_ACCOUNT_SID;
  const twilioToken = env.TWILIO_AUTH_TOKEN;

  if (!twilioSid || !twilioToken) {
    console.error('Twilio credentials not configured');
    return;
  }

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`;
  const basicAuth = btoa(`${twilioSid}:${twilioToken}`);

  // El numero "From" de Twilio Sandbox o numero comprado
  const twilioFrom = env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  const params = new URLSearchParams();
  params.append('From', twilioFrom);
  params.append('To', to);
  params.append('Body', message);

  try {
    const res = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Twilio send error:', res.status, err);
    }
  } catch (err) {
    console.error('Twilio fetch error:', err);
  }
}

// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const reqId = newRequestId();
    const CORS = corsHeaders(request, env);
    // json/fail locales: CORS acotado por origen; nunca filtran err.message.
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
    const fail = (where, err, status = 500) => {
      logError(reqId, where, err);
      return json({ error: 'Error interno del servidor', request_id: reqId }, status);
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ── Auth middleware ─────────────────────────────────────
    // SOLO son públicas las rutas que no pueden llevar sesión:
    //  - auth (login/register/2fa se autentican por sí mismas)
    //  - webhooks entrantes (validados por firma Twilio / secret Telegram, no por sesión)
    // TODA escritura de datos (upload, confirm, pagos, etc.) EXIGE sesión.
    const PUBLIC_ROUTES = new Set([
      'POST /api/auth/login',
      'POST /api/auth/register',
      'POST /api/auth/setup-2fa',
      'POST /api/auth/verify-2fa',
      'GET /api/whatsapp/webhook',
      'POST /api/whatsapp/webhook',
      'POST /api/telegram/webhook',
      'GET /api/telegram/health',
    ]);
    const isPublic = PUBLIC_ROUTES.has(`${request.method} ${url.pathname}`);

    let authUser = null;
    if (!isPublic && url.pathname.startsWith('/api/')) {
      authUser = await verifyRequest(request, env);
      if (!authUser) return json({ error: 'Unauthorized' }, 401);
    }
    // Helper de autorización por rol (Fase 2/3). captura<revision<tesoreria<admin.
    const requireRole = (minRol) => authUser && roleAtLeast(authUser.rol, minRol);

    // ── POST /api/upload ────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      try {
        const form    = await request.formData();
        const file    = form.get('file');
        const usuario = authUser?.nombre || authUser?.email || 'sistema';
        if (!file) return json({ error: 'No file' }, 400);

        // ── Validación ANTES de tocar R2 (MIME + extensión + tamaño) ──
        const maxBytes = (parseInt(env.MAX_UPLOAD_MB) || 10) * 1024 * 1024;
        const vf = validateUpload(file, { maxBytes });
        if (!vf.ok) return json({ ok: false, error: vf.error }, 400);

        const mimeType = vf.mime;
        const buf      = await file.arrayBuffer();
        const bytes    = new Uint8Array(buf);
        let binary     = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64      = btoa(binary);

        // Key con UUID (nunca el nombre original del archivo)
        const r2Key     = r2KeyForUpload(vf.ext);
        const r2Promise = env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType: mimeType } });

        // ★ OCR Router: hybrid (Gemini→Sonnet fallback) | sonnet | gemini
        const preview = await runOcrAgent(b64, mimeType, env, env.DB);

        await r2Promise;

        if (preview.error) {
          // Limpiar objeto huérfano si el OCR falló
          await env.BUCKET.delete(r2Key).catch(() => {});
          logError(reqId, '/api/upload:ocr', new Error(preview.error));
          return json({ ok: false, error: 'No se pudo procesar el documento', request_id: reqId }, 502);
        }
        preview.usuario = usuario;
        preview.archivo_r2 = r2Key;
        const dup = await checkDuplicate(env.DB, preview.numero_documento, preview.total, preview.fecha, preview.proveedor_nit);
        preview.es_posible_duplicado = !!dup;
        preview.duplicado_info = dup;

        // ── Auto-confirm: proveedor conocido + confianza alta + sin duplicado + total positivo ──
        const wantsAuto = form.get('auto_confirm') === '1';
        if (wantsAuto
            && preview.en_catalogo === true
            && preview.confianza_global === 'alta'
            && !preview.es_posible_duplicado
            && preview.total > 0) {

          const ins = await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            RETURNING numero
          `).bind(
            preview.fecha, preview.proveedor_nit, preview.proveedor_nombre,
            preview.numero_documento, preview.concepto, preview.categoria,
            preview.valor_base || 0, preview.iva || 0, preview.inc || 0,
            preview.otros_impuestos || 0, preview.total,
            preview.es_nota_credito ? 1 : 0,
            preview.medio_pago, preview.referencia_pago,
            preview.archivo_r2, preview.usuario || 'david',
            'confirmado', preview.notas || null
          ).first();
          const numero = ins.numero;

          preview.auto_confirmado = true;
          return json({ ok: true, preview, auto_confirmado: true, numero });
        }

        return json({ ok: true, preview });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/confirm ───────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/confirm') {
      try {
        const body = await request.json();

        // ── Validación central (Fase 1.7) ──
        const v = validateGastoPayload(body, { anio: anioActualBogota() });
        if (!v.ok) return json({ ok: false, error: v.error }, 400);
        const g = v.value;

        // Anti-duplicado: hard bloquea siempre; soft requiere forzar (autorización explícita)
        const dup = await checkDuplicate(env.DB, g.numero_documento, g.total, g.fecha, g.proveedor_nit);
        if (dup && (dup.severidad === 'hard' || body.forzar !== true)) {
          const r = dup.registro;
          const motivo = dup.tipo === 'numero_documento' ? 'mismo número de documento y proveedor'
            : dup.tipo === 'numero_documento_sin_nit' ? 'mismo número de documento'
            : dup.tipo === 'total_fecha_proveedor' ? 'mismo total, fecha y proveedor'
            : 'mismo total y fecha';
          return json({
            ok: false,
            error: `Posible duplicado (#${r.numero} — ${r.proveedor_nombre}): ${motivo}`,
            duplicado: true,
            forzable: dup.severidad === 'soft',
            coincidencia: { numero: r.numero, proveedor: r.proveedor_nombre, total: r.total, motivo },
          }, 409);
        }

        // Auto-detección de recurrente: si el NIT coincide con una obligación activa, marca 1
        let esRecurrenteAuto = body.es_recurrente ? 1 : 0;
        if (!body.es_recurrente && g.proveedor_nit) {
          const nitLimpio = g.proveedor_nit.replace(/\D/g, '');
          if (nitLimpio) {
            const match = await env.DB.prepare(
              `SELECT id FROM obligaciones WHERE activo = 1 AND REPLACE(REPLACE(proveedor_nit, '-', ''), ' ', '') LIKE ?`
            ).bind(`${nitLimpio.slice(0, 9)}%`).first();
            if (match) esRecurrenteAuto = 1;
          }
        }

        const usuario = authUser?.nombre || authUser?.email || 'sistema';
        const bindComunes = [
          g.fecha, g.proveedor_nit, g.proveedor_nombre,
          g.numero_documento, g.concepto, g.categoria,
          g.valor_base, g.iva, g.inc,
          g.otros_impuestos, g.total,
          g.es_nota_credito,
          g.medio_pago, g.referencia_pago,
          g.archivo_r2, usuario,
          g.estado,
        ];
        let numero;
        try {
          const ins = await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas, es_recurrente, entidad)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            RETURNING numero
          `).bind(...bindComunes, g.notas, esRecurrenteAuto, g.entidad).first();
          numero = ins.numero;
        } catch (e) {
          if (!/no column named entidad/i.test(e.message || '')) throw e;
          // Migración 0005 pendiente: guardar la entidad en notas para backfill posterior
          const ins = await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas, es_recurrente)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            RETURNING numero
          `).bind(...bindComunes, ((g.notas || '') + ' · entidad: ' + g.entidad).trim(), esRecurrenteAuto).first();
          numero = ins.numero;
        }

        return json({ ok: true, numero }, 201);
      } catch (err) {
        return fail('/api/confirm', err);
      }
    }

    // ── PATCH /api/gastos/:id ─────────────────────────────────
    // Actualiza campos selectivos de un gasto (toggle es_recurrente, categoría, etc.)
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/gastos/')) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const body = await request.json();
        const allowed = ['es_recurrente', 'categoria', 'concepto', 'estado',
                         'pagado_via', 'fecha_pago_masivo', 'entidad', 'deducible_cocicp',
                         'total', 'fecha', 'proveedor_nombre', 'numero_documento'];
        // Validaciones puntuales de los campos editables (Fase 4.5)
        if ('entidad' in body && !['cocicp', 'restituyo', 'personal'].includes(body.entidad)) {
          return json({ error: 'Entidad inválida (cocicp | restituyo | personal)' }, 400);
        }
        if ('total' in body && (typeof body.total !== 'number' || !isFinite(body.total))) {
          return json({ error: 'Total inválido' }, 400);
        }
        if ('fecha' in body && !isValidDateStr(body.fecha)) {
          return json({ error: 'Fecha inválida (YYYY-MM-DD)' }, 400);
        }
        if ('estado' in body && !['confirmado', 'revision', 'anulado'].includes(body.estado)) {
          return json({ error: 'Estado inválido' }, 400);
        }
        const sets = [];
        const vals = [];
        for (const k of allowed) {
          if (k in body) {
            sets.push(`${k} = ?`);
            vals.push(body[k]);
          }
        }
        if (sets.length === 0) return json({ error: 'Sin campos para actualizar' }, 400);

        sets.push("actualizado_en = datetime('now')");
        vals.push(id);

        await env.DB.prepare(`UPDATE gastos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── DELETE /api/gastos/:id ──────────────────────────────
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/gastos/')) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const row = await env.DB.prepare('SELECT id, numero, archivo_r2 FROM gastos WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Registro no encontrado' }, 404);

        // Borrar archivo de R2 si existe
        if (row.archivo_r2) {
          try { await env.BUCKET.delete(row.archivo_r2); } catch {}
        }

        await env.DB.prepare('DELETE FROM gastos WHERE id = ?').bind(id).run();
        return json({ ok: true, deleted: row.numero });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/gastos ─────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/gastos') {
      const p     = url.searchParams;
      const desde = p.get('desde') || '2026-01-01';
      const hasta = p.get('hasta') || '2026-12-31';
      const cat   = p.get('categoria');

      let q = 'SELECT * FROM gastos WHERE fecha BETWEEN ? AND ?';
      let v = [desde, hasta];
      if (cat) { q += ' AND categoria = ?'; v.push(cat); }
      // Filtro multi-entidad (cocicp | restituyo | personal); ignora si la columna no existe aún
      const entidadFiltro = url.searchParams.get('entidad');
      if (entidadFiltro && ['cocicp', 'restituyo', 'personal'].includes(entidadFiltro)) {
        q += " AND COALESCE(entidad, 'cocicp') = ?"; v.push(entidadFiltro);
      }
      q += ' ORDER BY fecha DESC, id DESC';

      let result;
      try {
        result = await env.DB.prepare(q).bind(...v).all();
      } catch (e) {
        if (entidadFiltro && /no such column: entidad/i.test(e.message || '')) {
          // Migración 0005 pendiente: devolver sin filtro de entidad
          result = await env.DB.prepare(q.replace(" AND COALESCE(entidad, 'cocicp') = ?", '')).bind(...v.slice(0, -1)).all();
        } else { throw e; }
      }
      const total  = result.results.reduce((s, r) => s + r.total, 0);
      const porCategoria = result.results.reduce((acc, r) => {
        acc[r.categoria] = (acc[r.categoria] || 0) + r.total;
        return acc;
      }, {});

      return json({ registros: result.results, total_registros: result.results.length, gran_total: total, por_categoria: porCategoria });
    }

    // ── POST /api/cruce-dian ──────────────────────────────────
    // Recibe filas parseadas del Excel DIAN, cruza contra D1
    if (request.method === 'POST' && url.pathname === '/api/cruce-dian') {
      try {
        const body = await request.json();
        const { filas } = body;
        const entidad = ['cocicp', 'restituyo', 'personal'].includes(body.entidad) ? body.entidad : null;
        if (!filas || !Array.isArray(filas)) return json({ error: 'Se espera { filas: [...] }' }, 400);

        // Cruzar SOLO contra los gastos de la entidad indicada (cada NIT sube su reporte DIAN)
        const SEL = 'SELECT id, numero, numero_documento, proveedor_nit, fecha, total, concepto, categoria, proveedor_nombre FROM gastos';
        let existentes;
        try {
          existentes = entidad
            ? await env.DB.prepare(SEL + " WHERE COALESCE(entidad,'cocicp') = ?").bind(entidad).all()
            : await env.DB.prepare(SEL).all();
        } catch (e) {
          if (entidad && /no such column: entidad/i.test(e.message || '')) {
            existentes = await env.DB.prepare(SEL).all(); // migración 0005 pendiente → cruza contra todo
          } else { throw e; }
        }
        const dbRows = existentes.results || [];

        const resultados = { existentes: [], nuevos: [], completar: [] };

        for (const fila of filas) {
          // Emparejar con la misma lógica probada (lib/finance-utils.matchDianFila)
          const match = matchDianFila(fila, dbRows);

          if (match) {
            // Ya existe — verificar si le falta info para completar
            const faltantes = [];
            if (!match.numero_documento && fila.numero_documento) faltantes.push('numero_documento');
            if (!match.proveedor_nit && fila.nit_emisor) faltantes.push('proveedor_nit');
            if (!match.concepto || match.concepto === 'Sin concepto') faltantes.push('concepto');

            if (faltantes.length > 0) {
              resultados.completar.push({
                gasto_existente: match,
                datos_dian: fila,
                campos_faltantes: faltantes
              });
            } else {
              resultados.existentes.push({
                gasto_existente: match,
                datos_dian: fila
              });
            }
          } else {
            // Nuevo — no existe en D1
            resultados.nuevos.push(fila);
          }
        }

        return json({
          ok: true,
          entidad: entidad || 'todas',
          total_dian: filas.length,
          total_existentes: resultados.existentes.length,
          total_completar: resultados.completar.length,
          total_nuevos: resultados.nuevos.length,
          ...resultados
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/bulk-import ───────────────────────────────
    // Importar múltiples registros nuevos de golpe
    if (request.method === 'POST' && url.pathname === '/api/bulk-import') {
      try {
        const body = await request.json();
        const { registros } = body;
        const entidad = ['cocicp', 'restituyo', 'personal'].includes(body.entidad) ? body.entidad : 'cocicp';
        if (!registros || !Array.isArray(registros)) return json({ error: 'Se espera { registros: [...] }' }, 400);

        const usuario = authUser?.nombre || authUser?.email || 'sistema';
        let insertados = 0;
        let omitidos = 0;
        let entidadGuardada = true;

        for (const r of registros) {
          // Verificar duplicado antes de insertar (mismo doc + proveedor)
          if (r.numero_documento) {
            const dup = r.proveedor_nit
              ? await env.DB.prepare('SELECT id FROM gastos WHERE numero_documento = ? AND proveedor_nit = ?').bind(r.numero_documento, r.proveedor_nit).first()
              : await env.DB.prepare('SELECT id FROM gastos WHERE numero_documento = ?').bind(r.numero_documento).first();
            if (dup) { omitidos++; continue; }
          }

          const comunes = [
            r.fecha, r.proveedor_nit || null, r.proveedor_nombre || 'Sin proveedor',
            r.numero_documento || null, r.concepto || 'Importado DIAN', r.categoria || 'Misceláneos',
            r.valor_base || 0, r.iva || 0, r.inc || 0, r.otros_impuestos || 0,
            r.total || 0, r.es_nota_credito ? 1 : 0,
            r.medio_pago || null, r.referencia_pago || null,
            usuario, 'revision',
          ];
          try {
            await env.DB.prepare(`
              INSERT INTO gastos
                (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
                 concepto, categoria, valor_base, iva, inc, otros_impuestos,
                 total, es_nota_credito, medio_pago, referencia_pago,
                 usuario, estado, notas, entidad)
              SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                     ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
              RETURNING numero
            `).bind(...comunes, 'Importado desde reporte DIAN', entidad).first();
          } catch (e) {
            if (!/no column named entidad/i.test(e.message || '')) throw e;
            entidadGuardada = false;
            await env.DB.prepare(`
              INSERT INTO gastos
                (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
                 concepto, categoria, valor_base, iva, inc, otros_impuestos,
                 total, es_nota_credito, medio_pago, referencia_pago,
                 usuario, estado, notas)
              SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                     ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
              RETURNING numero
            `).bind(...comunes, 'Importado desde reporte DIAN · entidad: ' + entidad).first();
          }
          insertados++;
        }

        return json({ ok: true, insertados, omitidos, entidad, entidad_guardada: entidadGuardada });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/completar-gasto ───────────────────────────
    // Actualizar campos faltantes de un gasto existente
    if (request.method === 'POST' && url.pathname === '/api/completar-gasto') {
      try {
        const { id, campos } = await request.json();
        if (!id || !campos) return json({ error: 'Se espera { id, campos: {...} }' }, 400);

        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(campos)) {
          if (['numero_documento', 'proveedor_nit', 'proveedor_nombre', 'concepto', 'categoria', 'fecha', 'valor_base', 'iva', 'total'].includes(k)) {
            sets.push(`${k} = ?`);
            vals.push(v);
          }
        }
        if (!sets.length) return json({ error: 'Sin campos válidos' }, 400);

        sets.push("actualizado_en = datetime('now')");
        vals.push(id);

        await env.DB.prepare(`UPDATE gastos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/soporte/:gastoId — soporte por ID de gasto, autenticado y privado ──
    // (Fase 1.3) No acepta keys R2 arbitrarias: resuelve la key desde el gasto.
    if (request.method === 'GET' && url.pathname.startsWith('/api/soporte/')) {
      try {
        const idRaw = url.pathname.replace('/api/soporte/', '').split('/')[0];
        const gastoId = parseInt(idRaw, 10);
        if (!isPositiveId(gastoId)) return json({ error: 'ID de gasto inválido' }, 400);

        const row = await env.DB.prepare('SELECT archivo_r2 FROM gastos WHERE id = ?').bind(gastoId).first();
        if (!row || !row.archivo_r2) return json({ error: 'Soporte no encontrado' }, 404);

        // Solo se sirven objetos dentro del prefijo controlado
        const key = String(row.archivo_r2);
        if (!key.startsWith('soportes/')) return json({ error: 'Soporte no autorizado' }, 403);

        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'Soporte no encontrado' }, 404);

        return new Response(obj.body, {
          headers: {
            ...CORS,
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Content-Disposition': `inline; filename="soporte-${gastoId}"`,
            'Cache-Control': 'private, no-store',
          }
        });
      } catch (err) {
        return fail('/api/soporte', err);
      }
    }

    // ── GET /api/reporte ───────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/reporte') {
      try {
        const p     = url.searchParams;
        const anio  = anioActualBogota();
        const desde = p.get('desde') || `${anio}-01-01`;
        const hasta = p.get('hasta') || `${anio}-12-31`;
        const entidad = ['cocicp', 'restituyo', 'personal'].includes(p.get('entidad')) ? p.get('entidad') : null;

        let registros;
        try {
          registros = entidad
            ? (await env.DB.prepare("SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? AND COALESCE(entidad,'cocicp') = ? ORDER BY fecha DESC, id DESC").bind(desde, hasta, entidad).all()).results
            : (await env.DB.prepare('SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, id DESC').bind(desde, hasta).all()).results;
        } catch (e) {
          if (entidad && /no such column: entidad/i.test(e.message || '')) {
            registros = (await env.DB.prepare('SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, id DESC').bind(desde, hasta).all()).results;
          } else { throw e; }
        }
        registros = registros || [];

        const ENT = { cocicp: 'COCICP', restituyo: 'Restituyo SAS', personal: 'David Duque (Persona Natural)' };
        const { generateReport } = await import('./report-pdf.js');
        const pdfBytes = generateReport(registros, desde, hasta, { entidad: entidad ? ENT[entidad] : null });

        return new Response(pdfBytes, {
          headers: {
            ...CORS,
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="COCICP_Reporte${entidad ? '_' + entidad : ''}_${desde}_${hasta}.pdf"`,
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/recurrentes ─────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/recurrentes') {
      try {
        const p    = url.searchParams;
        const mes  = parseInt(p.get('mes'))  || new Date().getMonth() + 1;
        const anio = parseInt(p.get('anio')) || new Date().getFullYear();
        const result = await checkRecurrentes(env.DB, mes, anio);
        return json({ ok: true, ...result });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/cruce-banco ──────────────────────────────────
    // Receives bank statement movements, crosses against gastos in D1
    if (request.method === 'POST' && url.pathname === '/api/cruce-banco') {
      try {
        const { movimientos } = await request.json();
        if (!movimientos || !Array.isArray(movimientos)) {
          return json({ error: 'Se espera { movimientos: [{fecha, descripcion, valor, referencia}] }' }, 400);
        }

        // Fetch all gastos for crossing
        const existentes = await env.DB.prepare(
          'SELECT id, numero, numero_documento, proveedor_nit, proveedor_nombre, fecha, total, concepto, categoria, referencia_pago, medio_pago, estado FROM gastos'
        ).all();
        const dbRows = existentes.results || [];

        // Build lookup indexes
        const porReferencia = {};
        const porFechaTotal = {};
        const porFechaTotalAprox = {};
        const gastosUsados = new Set();

        dbRows.forEach(r => {
          if (r.referencia_pago) {
            const refKey = r.referencia_pago.trim().toUpperCase();
            if (!porReferencia[refKey]) porReferencia[refKey] = [];
            porReferencia[refKey].push(r);
          }

          const totalAbs = Math.round(Math.abs(r.total));
          const keyExacto = `${r.fecha}|${totalAbs}`;
          if (!porFechaTotal[keyExacto]) porFechaTotal[keyExacto] = [];
          porFechaTotal[keyExacto].push(r);

          if (!porFechaTotalAprox[totalAbs]) porFechaTotalAprox[totalAbs] = [];
          porFechaTotalAprox[totalAbs].push(r);
        });

        const conciliados = [];
        const sinSoporte = [];

        for (const mov of movimientos) {
          const movRef = (mov.referencia || '').trim().toUpperCase();
          const movFecha = mov.fecha || null;
          const movValor = Math.round(Math.abs(parseFloat(mov.valor) || 0));
          const movDesc = (mov.descripcion || '').trim();

          let match = null;
          let metodo = '';

          // Match 1: by referencia_pago (strongest match)
          if (movRef && !match) {
            const candidates = porReferencia[movRef];
            if (candidates) {
              for (const c of candidates) {
                if (!gastosUsados.has(c.id)) {
                  match = c;
                  metodo = 'referencia';
                  break;
                }
              }
            }
          }

          // Match 1b: referencia contained in description or vice-versa
          if (!match && movRef) {
            for (const r of dbRows) {
              if (gastosUsados.has(r.id)) continue;
              if (r.referencia_pago) {
                const rRef = r.referencia_pago.trim().toUpperCase();
                if (movDesc.toUpperCase().includes(rRef) || movRef.includes(rRef)) {
                  if (Math.round(Math.abs(r.total)) === movValor) {
                    match = r;
                    metodo = 'referencia_parcial';
                    break;
                  }
                }
              }
            }
          }

          // Match 2: by fecha + total exacto
          if (!match && movFecha && movValor) {
            const keyExacto = `${movFecha}|${movValor}`;
            const candidates = porFechaTotal[keyExacto];
            if (candidates) {
              for (const c of candidates) {
                if (!gastosUsados.has(c.id)) {
                  match = c;
                  metodo = 'fecha_total';
                  break;
                }
              }
            }
          }

          // Match 3: by total + fecha approximate (+/- 2 days)
          if (!match && movFecha && movValor) {
            const candidates = porFechaTotalAprox[movValor];
            if (candidates) {
              const movDate = new Date(movFecha + 'T00:00:00');
              for (const c of candidates) {
                if (gastosUsados.has(c.id)) continue;
                const cDate = new Date(c.fecha + 'T00:00:00');
                const diffDays = Math.abs((movDate - cDate) / 86400000);
                if (diffDays <= 2) {
                  match = c;
                  metodo = 'fecha_aprox_total';
                  break;
                }
              }
            }
          }

          if (match) {
            gastosUsados.add(match.id);
            conciliados.push({
              movimiento: mov,
              gasto: {
                id: match.id,
                numero: match.numero,
                proveedor_nombre: match.proveedor_nombre,
                concepto: match.concepto,
                categoria: match.categoria,
                total: match.total,
                fecha: match.fecha,
                numero_documento: match.numero_documento,
                referencia_pago: match.referencia_pago,
                estado: match.estado
              },
              metodo_match: metodo
            });
          } else {
            sinSoporte.push(mov);
          }
        }

        // Gastos that exist in system but have no bank match
        const soloEnSistema = dbRows
          .filter(r => !gastosUsados.has(r.id))
          .filter(r => {
            if (!movimientos.length) return false;
            const fechas = movimientos.map(m => m.fecha).filter(Boolean).sort();
            if (!fechas.length) return false;
            const minFecha = fechas[0];
            const maxFecha = fechas[fechas.length - 1];
            return r.fecha >= minFecha && r.fecha <= maxFecha;
          })
          .map(r => ({
            id: r.id,
            numero: r.numero,
            proveedor_nombre: r.proveedor_nombre,
            concepto: r.concepto,
            categoria: r.categoria,
            total: r.total,
            fecha: r.fecha,
            numero_documento: r.numero_documento,
            estado: r.estado
          }));

        return json({
          ok: true,
          total_movimientos: movimientos.length,
          total_conciliados: conciliados.length,
          total_sin_soporte: sinSoporte.length,
          total_solo_en_sistema: soloEnSistema.length,
          conciliados,
          sin_soporte: sinSoporte,
          solo_en_sistema: soloEnSistema
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/tendencias ────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/tendencias') {
      try {
        const meses = parseInt(url.searchParams.get('meses') || '6');
        const limit = Math.min(Math.max(meses, 1), 24);

        const result = await env.DB.prepare(`
          SELECT strftime('%Y-%m', fecha) as mes,
                 categoria,
                 SUM(total) as total
          FROM gastos
          WHERE fecha >= date('now', '-${limit} months')
          GROUP BY mes, categoria
          ORDER BY mes
        `).all();

        const rows = result.results || [];

        // Agrupar por mes
        const mesesMap = {};
        for (const row of rows) {
          if (!mesesMap[row.mes]) {
            mesesMap[row.mes] = { mes: row.mes, total: 0, categorias: {} };
          }
          mesesMap[row.mes].categorias[row.categoria] = row.total;
          mesesMap[row.mes].total += row.total;
        }

        // Ordenar cronologicamente
        const mesesArr = Object.values(mesesMap).sort((a, b) => a.mes.localeCompare(b.mes));

        return json({ ok: true, meses: mesesArr });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/comparativo ───────────────────────────────────
    // Compara dos meses: ?mes1=2026-03&mes2=2026-04
    if (request.method === 'GET' && url.pathname === '/api/comparativo') {
      try {
        const mes1 = url.searchParams.get('mes1');
        const mes2 = url.searchParams.get('mes2');
        if (!mes1 || !mes2) return json({ error: 'Parámetros mes1 y mes2 requeridos (formato YYYY-MM)' }, 400);
        if (!/^\d{4}-\d{2}$/.test(mes1) || !/^\d{4}-\d{2}$/.test(mes2)) {
          return json({ error: 'Formato inválido. Usar YYYY-MM' }, 400);
        }

        const desde1 = `${mes1}-01`;
        const hasta1 = `${mes1}-31`;
        const desde2 = `${mes2}-01`;
        const hasta2 = `${mes2}-31`;

        const [r1, r2] = await Promise.all([
          env.DB.prepare('SELECT categoria, SUM(total) as total, COUNT(*) as registros FROM gastos WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY categoria')
            .bind(desde1, hasta1).all(),
          env.DB.prepare('SELECT categoria, SUM(total) as total, COUNT(*) as registros FROM gastos WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY categoria')
            .bind(desde2, hasta2).all()
        ]);

        const catMap = {};

        // Acumular mes1
        let granTotal1 = 0;
        let totalReg1 = 0;
        for (const row of (r1.results || [])) {
          if (!catMap[row.categoria]) catMap[row.categoria] = { mes1: 0, mes2: 0, reg1: 0, reg2: 0 };
          catMap[row.categoria].mes1 = row.total;
          catMap[row.categoria].reg1 = row.registros;
          granTotal1 += row.total;
          totalReg1 += row.registros;
        }

        // Acumular mes2
        let granTotal2 = 0;
        let totalReg2 = 0;
        for (const row of (r2.results || [])) {
          if (!catMap[row.categoria]) catMap[row.categoria] = { mes1: 0, mes2: 0, reg1: 0, reg2: 0 };
          catMap[row.categoria].mes2 = row.total;
          catMap[row.categoria].reg2 = row.registros;
          granTotal2 += row.total;
          totalReg2 += row.registros;
        }

        // Construir array ordenado por diferencia absoluta desc
        const categorias = Object.entries(catMap).map(([cat, v]) => {
          const diff = v.mes2 - v.mes1;
          const pct = v.mes1 !== 0 ? ((diff / Math.abs(v.mes1)) * 100) : (v.mes2 !== 0 ? 100 : 0);
          return {
            categoria: cat,
            mes1: v.mes1,
            mes2: v.mes2,
            registros_mes1: v.reg1,
            registros_mes2: v.reg2,
            diferencia: diff,
            porcentaje: Math.round(pct * 10) / 10
          };
        }).sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

        const diffTotal = granTotal2 - granTotal1;
        const pctTotal = granTotal1 !== 0 ? Math.round(((diffTotal / Math.abs(granTotal1)) * 100) * 10) / 10 : 0;

        return json({
          ok: true,
          mes1,
          mes2,
          resumen: {
            total_mes1: granTotal1,
            total_mes2: granTotal2,
            diferencia: diffTotal,
            porcentaje: pctTotal,
            registros_mes1: totalReg1,
            registros_mes2: totalReg2,
            categorias_activas: categorias.length
          },
          categorias
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/estado-mes ──────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/estado-mes') {
      try {
        const mes  = parseInt(url.searchParams.get('mes'))  || new Date().getMonth() + 1;
        const anio = parseInt(url.searchParams.get('anio')) || new Date().getFullYear();

        const mesStr   = String(mes).padStart(2, '0');
        const desde    = `${anio}-${mesStr}-01`;
        const hastaDia = new Date(anio, mes, 0).getDate();
        const hasta    = `${anio}-${mesStr}-${String(hastaDia).padStart(2, '0')}`;

        // 1. Total gastos y monto del mes
        const resumen = await env.DB.prepare(
          'SELECT COUNT(*) as total_gastos, COALESCE(SUM(total),0) as total_monto FROM gastos WHERE fecha BETWEEN ? AND ?'
        ).bind(desde, hasta).first();

        // 2. Gastos en estado revision
        const revision = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM gastos WHERE fecha BETWEEN ? AND ? AND estado = ?'
        ).bind(desde, hasta, 'revision').first();

        // 3. Días sin registro
        const ultimoReg = await env.DB.prepare(
          'SELECT fecha FROM gastos ORDER BY fecha DESC LIMIT 1'
        ).first();

        let dias_sin_registro = 0;
        if (ultimoReg && ultimoReg.fecha) {
          const ultimaFecha = new Date(ultimoReg.fecha + 'T12:00:00');
          const hoy = new Date();
          hoy.setHours(12, 0, 0, 0);
          dias_sin_registro = Math.floor((hoy - ultimaFecha) / (1000 * 60 * 60 * 24));
          if (dias_sin_registro < 0) dias_sin_registro = 0;
        }

        // 4. Recurrentes faltantes
        const RECURRENTES = [
          { nit_prefix: '901423905', nombre: 'Liceo Frances',      categoria: 'Educacion hijos' },
          { nit_prefix: '800155413', nombre: 'Accion Fiduciaria',  categoria: 'Vivienda' },
          { nit_prefix: '9998600669427', nombre: 'miplanilla',     categoria: 'Seguridad Social' },
          { nit_prefix: '902029628', nombre: 'Laura Anaya',        categoria: 'Honorarios Medicos' }
        ];

        const recurrentes_faltantes = [];
        for (const rec of RECURRENTES) {
          const found = await env.DB.prepare(
            "SELECT COUNT(*) as c FROM gastos WHERE fecha BETWEEN ? AND ? AND proveedor_nit LIKE ?"
          ).bind(desde, hasta, rec.nit_prefix + '%').first();

          if (!found || found.c === 0) {
            recurrentes_faltantes.push({
              nit: rec.nit_prefix,
              nombre: rec.nombre,
              categoria: rec.categoria
            });
          }
        }

        // 5. Construir alertas
        const alertas = [];

        if (revision.count > 0) {
          alertas.push({
            tipo: 'revision',
            nivel: 'yellow',
            mensaje: `${revision.count} gasto(s) en estado "revision" pendientes de confirmar`
          });
        }

        if (recurrentes_faltantes.length > 0) {
          const nombres = recurrentes_faltantes.map(r => r.nombre).join(', ');
          alertas.push({
            tipo: 'recurrentes',
            nivel: recurrentes_faltantes.length >= 3 ? 'red' : 'yellow',
            mensaje: `Falta(n) pago(s) recurrente(s): ${nombres}`
          });
        }

        if (dias_sin_registro > 7) {
          alertas.push({
            tipo: 'inactividad',
            nivel: dias_sin_registro > 14 ? 'red' : 'yellow',
            mensaje: `${dias_sin_registro} dias sin registrar gastos (ultimo: ${ultimoReg?.fecha || 'N/A'})`
          });
        }

        if (resumen.total_gastos === 0) {
          alertas.push({
            tipo: 'vacio',
            nivel: 'red',
            mensaje: `Sin gastos registrados en ${mesStr}/${anio}`
          });
        }

        // Nivel global
        let nivel_global = 'green';
        if (alertas.some(a => a.nivel === 'red')) nivel_global = 'red';
        else if (alertas.some(a => a.nivel === 'yellow')) nivel_global = 'yellow';

        return json({
          mes,
          anio,
          total_gastos: resumen.total_gastos,
          total_monto: resumen.total_monto,
          gastos_en_revision: revision.count,
          recurrentes_faltantes,
          dias_sin_registro,
          alertas,
          nivel_global
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/whatsapp/webhook — Verificacion Twilio ────────
    if (request.method === 'GET' && url.pathname === '/api/whatsapp/webhook') {
      return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    // ── POST /api/whatsapp/webhook — Recibir mensaje WhatsApp ──
    if (request.method === 'POST' && url.pathname === '/api/whatsapp/webhook') {
      try {
        const xml = (s) => new Response(s, { status: 200, headers: { 'Content-Type': 'text/xml' } });

        // Twilio envia application/x-www-form-urlencoded
        const formData = await request.formData();
        const params = {};
        for (const [k, v] of formData.entries()) params[k] = typeof v === 'string' ? v : '';

        // (Fase WhatsApp 1-2) Validar firma Twilio ANTES de procesar nada
        const sigOk = env.TWILIO_AUTH_TOKEN
          ? await verifyTwilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params, request.headers.get('X-Twilio-Signature') || '')
          : false;
        if (!sigOk) {
          logError(reqId, '/api/whatsapp/webhook', new Error('firma Twilio inválida o TWILIO_AUTH_TOKEN ausente'));
          return new Response('Forbidden', { status: 403 });
        }

        const from       = params.From || '';
        const body       = params.Body || '';
        const numMedia   = parseInt(params.NumMedia || '0');
        const mediaUrl   = params.MediaUrl0 || null;
        const mediaType  = params.MediaContentType0 || null;

        // Determinar usuario por numero de telefono
        const NUMEROS_AUTORIZADOS = {
          'whatsapp:+573001234567': 'david',
          'whatsapp:+573009876543': 'andrea',
        };
        const usuario = NUMEROS_AUTORIZADOS[from];

        if (!usuario) {
          await sendWhatsAppReply(env, from, 'No autorizado. Contacte al administrador de COCICP.');
          return xml('<Response></Response>');
        }

        // Sin imagen adjunta
        if (numMedia === 0 || !mediaUrl) {
          await sendWhatsAppReply(env, from, 'Envie una foto o PDF de la factura para registrar el gasto.');
          return xml('<Response></Response>');
        }

        // (Fase WhatsApp 3-5) Anti-SSRF: solo medios de Twilio por HTTPS; nunca Basic Auth a host no verificado
        if (!isAllowedMediaUrl(mediaUrl)) {
          logError(reqId, '/api/whatsapp/webhook', new Error('MediaUrl no permitida: ' + mediaUrl));
          await sendWhatsAppReply(env, from, 'Medio no válido.');
          return xml('<Response></Response>');
        }

        // --- Descargar imagen desde Twilio con Basic Auth (sin seguir redirecciones) ---
        const twilioSid   = env.TWILIO_ACCOUNT_SID;
        const twilioToken = env.TWILIO_AUTH_TOKEN;
        const basicAuth   = btoa(`${twilioSid}:${twilioToken}`);

        const mediaRes = await fetch(mediaUrl, {
          headers: { 'Authorization': `Basic ${basicAuth}` },
          redirect: 'error',
        });

        if (!mediaRes.ok) {
          await sendWhatsAppReply(env, from, 'Error descargando imagen. Intente de nuevo.');
          return xml('<Response></Response>');
        }

        // (Fase WhatsApp 6) Límite de tamaño + MIME
        const ctype = (mediaRes.headers.get('content-type') || mediaType || '').toLowerCase();
        if (!/^(image\/jpeg|image\/png|application\/pdf)/.test(ctype)) {
          await sendWhatsAppReply(env, from, 'Solo se aceptan fotos (JPG/PNG) o PDF.');
          return xml('<Response></Response>');
        }
        const clen = parseInt(mediaRes.headers.get('content-length') || '0');
        if (clen && clen > 10 * 1024 * 1024) {
          await sendWhatsAppReply(env, from, 'El archivo excede 10 MB.');
          return xml('<Response></Response>');
        }

        const mediaBuf   = await mediaRes.arrayBuffer();
        if (mediaBuf.byteLength > 10 * 1024 * 1024) {
          await sendWhatsAppReply(env, from, 'El archivo excede 10 MB.');
          return xml('<Response></Response>');
        }
        const mediaBytes = new Uint8Array(mediaBuf);
        let binary = '';
        for (let i = 0; i < mediaBytes.length; i++) {
          binary += String.fromCharCode(mediaBytes[i]);
        }
        const b64 = btoa(binary);

        const mimeType = mediaType || 'image/jpeg';

        // --- Guardar en R2 ---
        const timestamp = Date.now();
        const ext = mimeType.includes('pdf') ? 'pdf'
                  : mimeType.includes('png') ? 'png' : 'jpg';
        const r2Key = `soportes/wa-${timestamp}.${ext}`;
        const r2Promise = env.BUCKET.put(r2Key, mediaBuf, {
          httpMetadata: { contentType: mimeType }
        });

        // --- Correr 3 agentes en paralelo ---
        const apiKey = env.ANTHROPIC_API_KEY;
        const [a1, a2, a3] = await Promise.all([
          runAgent1(b64, mimeType, apiKey),
          runAgent2(b64, mimeType, env.DB, apiKey),
          runAgent3(b64, mimeType, apiKey)
        ]);

        await r2Promise;

        // --- Merge ---
        const preview = mergeAgents(a1, a2, a3, usuario);
        preview.archivo_r2 = r2Key;
        preview.origen = 'whatsapp';

        // --- Verificar duplicado ---
        const dup = await checkDuplicate(
          env.DB,
          preview.numero_documento,
          preview.total,
          preview.fecha,
          preview.proveedor_nit
        );

        if (dup) {
          const r = dup.registro;
          await sendWhatsAppReply(
            env, from,
            `Duplicado: ya existe #${r.numero} (${r.proveedor_nombre}) $${formatCOP(r.total)}`
          );
          return new Response('<Response></Response>', {
            status: 200,
            headers: { 'Content-Type': 'text/xml' }
          });
        }

        // --- Decidir: auto-confirmar o enviar a revision ---
        const esConfiable = preview.confianza_global !== 'baja'
                         && preview.en_catalogo
                         && !preview.errores_parciales
                         && preview.total > 0;

        let replyMsg;

        if (esConfiable) {
          const ins = await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            RETURNING numero
          `).bind(
            preview.fecha,
            preview.proveedor_nit,
            preview.proveedor_nombre,
            preview.numero_documento,
            preview.concepto,
            preview.categoria,
            preview.valor_base || 0,
            preview.iva || 0,
            preview.inc || 0,
            preview.otros_impuestos || 0,
            preview.total,
            preview.es_nota_credito ? 1 : 0,
            preview.medio_pago,
            preview.referencia_pago,
            r2Key,
            usuario,
            'confirmado',
            'Registrado via WhatsApp'
          ).first();
          const numero = ins.numero;

          replyMsg = [
            `\u2713 #${numero}`,
            preview.proveedor_nombre,
            `$${formatCOP(preview.total)}`,
            preview.categoria
          ].join(' ');

        } else {
          await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            RETURNING numero
          `).bind(
            preview.fecha,
            preview.proveedor_nit,
            preview.proveedor_nombre || 'Desconocido',
            preview.numero_documento,
            preview.concepto,
            preview.categoria,
            preview.valor_base || 0,
            preview.iva || 0,
            preview.inc || 0,
            preview.otros_impuestos || 0,
            preview.total,
            preview.es_nota_credito ? 1 : 0,
            preview.medio_pago,
            preview.referencia_pago,
            r2Key,
            usuario,
            'revision',
            'Requiere revision - registrado via WhatsApp'
          ).first();

          const frontendUrl = env.FRONTEND_URL || 'https://cocicp.davidduque.com';
          replyMsg = [
            `\u26a0\ufe0f Revisar:`,
            preview.proveedor_nombre || 'Desconocido',
            `$${formatCOP(preview.total)}`,
            frontendUrl
          ].join(' ');
        }

        // --- Responder por WhatsApp ---
        await sendWhatsAppReply(env, from, replyMsg);

        return new Response('<Response></Response>', {
          status: 200,
          headers: { 'Content-Type': 'text/xml' }
        });

      } catch (err) {
        console.error('WhatsApp webhook error:', err);
        return new Response('<Response></Response>', {
          status: 200,
          headers: { 'Content-Type': 'text/xml' }
        });
      }
    }

    // ── GET /api/obligaciones ───────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/obligaciones') {
      try {
        const tipo   = url.searchParams.get('tipo');
        const activo = url.searchParams.get('activo');

        let q = 'SELECT * FROM obligaciones WHERE 1=1';
        const v = [];
        if (tipo)   { q += ' AND tipo = ?';   v.push(tipo); }
        if (activo !== null && activo !== undefined && activo !== '') {
          q += ' AND activo = ?'; v.push(parseInt(activo));
        }
        q += ' ORDER BY tipo ASC, dia_limite ASC, nombre ASC';

        const result = await env.DB.prepare(q).bind(...v).all();
        return json({ ok: true, obligaciones: result.results || [] });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/obligaciones/pendientes ─────────────────────
    if (request.method === 'GET' && url.pathname === '/api/obligaciones/pendientes') {
      try {
        const now   = new Date();
        const mes   = parseInt(url.searchParams.get('mes'))  || (now.getMonth() + 1);
        const anio  = parseInt(url.searchParams.get('anio')) || now.getFullYear();
        const mesStr = String(mes).padStart(2, '0');
        const desde  = `${anio}-${mesStr}-01`;
        const hastaDia = new Date(anio, mes, 0).getDate();
        const hasta  = `${anio}-${mesStr}-${String(hastaDia).padStart(2, '0')}`;
        const hoy    = now.getDate();
        const esMesActual = (mes === now.getMonth() + 1 && anio === now.getFullYear());

        // Get active obligations (monthly ones always, annual only if current month matches logic)
        const obligs = await env.DB.prepare(
          'SELECT * FROM obligaciones WHERE activo = 1 ORDER BY tipo ASC, dia_limite ASC'
        ).all();

        // Get gastos of the month
        const gastosRes = await env.DB.prepare(
          'SELECT id, numero, proveedor_nit, proveedor_nombre, total, fecha, categoria FROM gastos WHERE fecha BETWEEN ? AND ?'
        ).bind(desde, hasta).all();
        const gastosMes = gastosRes.results || [];

        const pendientes = [];
        const pagadas = [];

        for (const ob of (obligs.results || [])) {
          // Skip annual obligations unless we specifically want to show them
          if (ob.frecuencia === 'anual') {
            // Only show annual in the month of dia_limite or if no dia_limite, show in January
            const mesOblig = ob.dia_limite ? 1 : 1; // annual obligations show every month as reminder
            // Actually, show annual obligations always — user decides
          }

          // Check if paid: match by proveedor_nit or proveedor_nombre LIKE
          let pagado = null;
          for (const g of gastosMes) {
            if (ob.proveedor_nit && g.proveedor_nit) {
              const obNitClean = ob.proveedor_nit.replace(/\D/g, '');
              const gNitClean  = g.proveedor_nit.replace(/\D/g, '');
              if (obNitClean && gNitClean && gNitClean.startsWith(obNitClean.slice(0, 9))) {
                pagado = g;
                break;
              }
            }
            if (!pagado && ob.proveedor_nombre && g.proveedor_nombre) {
              const obName = ob.proveedor_nombre.toLowerCase();
              const gName  = g.proveedor_nombre.toLowerCase();
              if (gName.includes(obName) || obName.includes(gName)) {
                pagado = g;
                break;
              }
            }
            // Also try matching by obligation name against proveedor_nombre
            if (!pagado && ob.nombre) {
              const obNombre = ob.nombre.toLowerCase();
              const gName = g.proveedor_nombre.toLowerCase();
              if (gName.includes(obNombre) || obNombre.includes(gName)) {
                pagado = g;
                break;
              }
            }
          }

          const diaLimite = ob.dia_limite || 0;
          const diasRestantes = esMesActual ? (diaLimite - hoy) : null;
          const vencido = esMesActual && diaLimite > 0 && hoy > diaLimite;

          const item = {
            ...ob,
            dias_restantes: diasRestantes,
            vencido: vencido && !pagado
          };

          if (pagado) {
            pagadas.push({ ...item, gasto: pagado });
          } else {
            pendientes.push(item);
          }
        }

        return json({
          ok: true,
          mes, anio,
          pendientes,
          pagadas,
          total_pendientes: pendientes.length,
          total_pagadas: pagadas.length
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/obligaciones ──────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/obligaciones') {
      try {
        const b = await request.json();
        if (!b.nombre || !b.tipo || !b.frecuencia) {
          return json({ error: 'nombre, tipo y frecuencia son requeridos' }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO obligaciones (nombre, descripcion, tipo, categoria, proveedor_nit, proveedor_nombre, frecuencia, dia_limite, valor_estimado, medio_pago, notas)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          b.nombre, b.descripcion || null, b.tipo, b.categoria || null,
          b.proveedor_nit || null, b.proveedor_nombre || null,
          b.frecuencia, b.dia_limite || null, b.valor_estimado || null,
          b.medio_pago || null, b.notas || null
        ).run();

        return json({ ok: true, id: result.meta?.last_row_id }, 201);
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── PUT /api/obligaciones/:id ───────────────────────────
    if (request.method === 'PUT' && url.pathname.match(/^\/api\/obligaciones\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        const b = await request.json();

        const sets = [];
        const vals = [];
        const allowed = ['nombre','descripcion','tipo','categoria','proveedor_nit','proveedor_nombre','frecuencia','dia_limite','valor_estimado','medio_pago','activo','notas'];
        for (const [k, v] of Object.entries(b)) {
          if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (!sets.length) return json({ error: 'Sin campos validos' }, 400);

        vals.push(id);
        await env.DB.prepare(`UPDATE obligaciones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── DELETE /api/obligaciones/:id ────────────────────────
    if (request.method === 'DELETE' && url.pathname.match(/^\/api\/obligaciones\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        await env.DB.prepare('UPDATE obligaciones SET activo = 0 WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/analisis-ia ──────────────────────────────────
    // Claude analiza el historial de gastos y sugiere recurrentes/pendientes
    if (request.method === 'GET' && url.pathname === '/api/analisis-ia') {
      try {
        // Traer todos los gastos de los últimos 6 meses
        const gastos = await env.DB.prepare(`
          SELECT proveedor_nit, proveedor_nombre, categoria, fecha, total, concepto, numero_documento
          FROM gastos
          WHERE fecha >= date('now', '-6 months')
          ORDER BY fecha DESC
        `).all();

        // Traer obligaciones existentes para no duplicar
        const obligs = await env.DB.prepare('SELECT nombre, proveedor_nit FROM obligaciones WHERE activo = 1').all();

        // Mes actual
        const now = new Date();
        const mesActual = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

        // Gastos de este mes para detectar pendientes
        const estesMes = await env.DB.prepare(`
          SELECT proveedor_nit, proveedor_nombre, categoria, total, fecha
          FROM gastos
          WHERE strftime('%Y-%m', fecha) = ?
        `).bind(mesActual).all();

        // Agrupar por proveedor+categoría para reducir tokens (~90% menos)
        const agrupado = {};
        for (const g of (gastos.results || [])) {
          const key = `${g.proveedor_nit||''}|${g.proveedor_nombre}|${g.categoria}`;
          if (!agrupado[key]) agrupado[key] = { proveedor: g.proveedor_nombre, nit: g.proveedor_nit, cat: g.categoria, meses: new Set(), total: 0, n: 0 };
          agrupado[key].meses.add(g.fecha?.slice(0,7));
          agrupado[key].total += g.total || 0;
          agrupado[key].n++;
        }
        const resumen = Object.values(agrupado).map(g => ({
          proveedor: g.proveedor, nit: g.nit, cat: g.cat, meses: g.meses.size, veces: g.n, total: Math.round(g.total), prom: Math.round(g.total/g.n)
        })).sort((a,b) => b.veces - a.veces);

        const prompt = `Eres un analista financiero. Analiza este resumen agrupado de gastos de COCICP (corporación médica colombiana, ESAL).

RESUMEN AGRUPADO últimos 6 meses (${gastos.results.length} registros, ${resumen.length} proveedores):
${JSON.stringify(resumen.slice(0, 50), null, 0)}

OBLIGACIONES YA REGISTRADAS (no las repitas):
${JSON.stringify(obligs.results, null, 0)}

GASTOS DE ESTE MES (${mesActual}):
${JSON.stringify(estesMes.results, null, 0)}

Analiza patrones y responde SOLO con JSON válido:

{
  "recurrentes_sugeridos": [
    {
      "nombre": "nombre descriptivo",
      "tipo": "empresa | personal",
      "categoria": "categoría del sistema",
      "proveedor_nombre": "nombre",
      "proveedor_nit": "NIT si se conoce",
      "frecuencia": "mensual | quincenal | bimestral | trimestral | semestral | anual",
      "dia_limite": 15,
      "valor_estimado": 500000,
      "razon": "por qué crees que es recurrente (ej: aparece 4 de 6 meses)"
    }
  ],
  "pendientes_este_mes": [
    {
      "nombre": "qué falta por pagar",
      "tipo": "empresa | personal",
      "categoria": "categoría",
      "valor_estimado": 500000,
      "razon": "se pagó los últimos N meses pero no este mes"
    }
  ],
  "alertas": [
    "Texto libre con observaciones: gastos inusuales, aumentos, patrones preocupantes, etc."
  ],
  "resumen": "Resumen ejecutivo de 2-3 frases sobre la salud financiera"
}

REGLAS:
- Solo sugiere recurrentes que NO estén en la lista de obligaciones existentes
- Para pendientes, solo incluye los que se pagaron al menos 3 de los últimos 6 meses y NO aparecen este mes
- Categorías válidas: Alimentación, Combustible, Educación hijos, Honorarios Médicos, Prestadores de servicios, Seguridad Social, Impuestos vehículos, Gastos Administrativos, Transporte Aéreo, Alojamiento, Salud, Tecnología, Personal, Misceláneos, Vivienda, Pagos David Duque, Parqueadero, Mercado/Aseo
- Tipos: "empresa" para gastos de COCICP, "personal" para gastos de David Duque`;

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1200,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData = await res.json();
        const raw = aiData.content?.find(b => b.type === 'text')?.text || '{}';

        let analisis;
        try {
          analisis = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch {
          return json({ ok: false, error: 'Error parseando respuesta IA', raw }, 500);
        }

        return json({ ok: true, ...analisis, total_gastos_analizados: gastos.results.length });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/enviar-alerta ─────────────────────────────
    // Trigger manual de la alerta por email (para probar)
    if (request.method === 'GET' && url.pathname === '/api/enviar-alerta') {
      try {
        await this.scheduled({}, env, {});
        return json({ ok: true, message: 'Alerta enviada (si hay pendientes)' });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/sugerencia-aceptar ────────────────────────
    // Acepta una sugerencia de la IA y la crea como obligación
    if (request.method === 'POST' && url.pathname === '/api/sugerencia-aceptar') {
      try {
        const body = await request.json();
        await env.DB.prepare(`
          INSERT INTO obligaciones (nombre, tipo, categoria, proveedor_nit, proveedor_nombre, frecuencia, dia_limite, valor_estimado, notas)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          body.nombre, body.tipo || 'empresa', body.categoria || 'Misceláneos',
          body.proveedor_nit || null, body.proveedor_nombre || null,
          body.frecuencia || 'mensual', body.dia_limite || null,
          body.valor_estimado || null, 'Sugerido por IA: ' + (body.razon || '')
        ).run();
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ══════════════════════════════════════════════════════
    // AUTH ENDPOINTS
    // ══════════════════════════════════════════════════════

    // ── POST /api/auth/register ─────────────────────────────
    // (Fase 1.5) SIEMPRE exige ADMIN_SETUP_TOKEN. Sin carrera de "primer usuario".
    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      try {
        if (!env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Registro no configurado (falta ADMIN_SETUP_TOKEN en el servidor)' }, 503);
        }
        const adminToken = request.headers.get('x-admin-token') || '';
        if (!timingSafeEqual(adminToken, String(env.ADMIN_SETUP_TOKEN))) {
          return json({ error: 'No autorizado' }, 403);
        }

        const body = await request.json();
        const { email, password, nombre } = body;
        if (!email || typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: 'Email inválido' }, 400);
        }
        if (!password || typeof password !== 'string' || password.length < 12) {
          return json({ error: 'Password mínimo 12 caracteres' }, 400);
        }
        const rol = ['captura', 'revision', 'tesoreria', 'admin'].includes(body.rol) ? body.rol : 'admin';

        // Ya existe?
        const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (exists) return json({ error: 'Email ya registrado' }, 409);

        const passwordHash = await hashPassword(password);
        const result = await env.DB.prepare(
          'INSERT INTO users (email, password_hash, nombre, rol) VALUES (?, ?, ?, ?)'
        ).bind(email, passwordHash, nombre || null, rol).run();

        return json({ ok: true, id: result.meta?.last_row_id, email, rol });
      } catch (err) {
        return fail('/api/auth/register', err);
      }
    }

    // ── POST /api/auth/login ────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      try {
        const { email, password } = await request.json();
        if (!email || !password) return json({ error: 'Credenciales requeridas' }, 400);

        const user = await env.DB.prepare(
          'SELECT id, email, password_hash, totp_secret, totp_verified, activo, nombre FROM users WHERE email = ?'
        ).bind(email).first();

        if (!user || user.activo === 0) return json({ error: 'Credenciales inválidas' }, 401);
        if (user.password_hash === 'PENDING') return json({ error: 'Usuario pendiente de setup' }, 403);

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) return json({ error: 'Credenciales inválidas' }, 401);

        // (Fase 2.7) 2FA real: el login SIEMPRE produce sesión temporal.
        // El token full se emite únicamente tras validar el TOTP en /verify-2fa.
        const { token, expires_at } = await createSession(env.DB, user.id, 'temp');
        const needs2fa = !!user.totp_secret && user.totp_verified === 1;
        const needsSetup = !user.totp_secret || user.totp_verified !== 1;

        return json({
          ok: true,
          temp_token: token,
          expires_at,
          needs_2fa: needs2fa,
          needs_setup: needsSetup,
          user: { email: user.email, nombre: user.nombre },
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/auth/setup-2fa ────────────────────────────
    // Requiere temp_token, genera secret TOTP y devuelve QR
    if (request.method === 'POST' && url.pathname === '/api/auth/setup-2fa') {
      try {
        const user = await verifyRequest(request, env, { requireFull: false });
        if (!user) return json({ error: 'Token temporal inválido' }, 401);
        if (user.session_tipo !== 'temp') return json({ error: 'Ya autenticado' }, 400);

        // Generar nuevo secret (sobreescribe si existía sin verificar)
        const secret = generateTotpSecret();
        await env.DB.prepare(
          'UPDATE users SET totp_secret = ?, totp_verified = 0 WHERE id = ?'
        ).bind(secret, user.id).run();

        const uri = totpUri(user.email, secret, 'COCICP');
        // (Fase 2.7) NO se envía el secreto a un servicio de QR externo.
        // El cliente renderiza el QR localmente desde otpauth_uri, o el usuario
        // ingresa `secret` manualmente en Google Authenticator.
        return json({
          ok: true,
          secret,
          otpauth_uri: uri,
          render_qr_local: true,
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/auth/verify-2fa ───────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/verify-2fa') {
      try {
        const user = await verifyRequest(request, env, { requireFull: false });
        if (!user) return json({ error: 'Token temporal inválido' }, 401);
        if (user.session_tipo !== 'temp') return json({ error: 'Sesión ya activa' }, 400);

        const { code } = await request.json();
        if (!code) return json({ error: 'Código requerido' }, 400);

        const row = await env.DB.prepare(
          'SELECT totp_secret FROM users WHERE id = ?'
        ).bind(user.id).first();

        if (!row?.totp_secret) return json({ error: 'TOTP no configurado' }, 400);

        const valid = await verifyTotp(row.totp_secret, code);
        if (!valid) return json({ error: 'Código inválido' }, 401);

        // Marcar como verificado si era primera vez
        if (user.totp_verified === 0) {
          await env.DB.prepare('UPDATE users SET totp_verified = 1 WHERE id = ?').bind(user.id).run();
        }
        await env.DB.prepare("UPDATE users SET ultimo_login = datetime('now') WHERE id = ?").bind(user.id).run();

        // Borrar session temp
        const auth = request.headers.get('Authorization') || '';
        const tempToken = auth.replace(/^Bearer\s+/i, '').trim();
        await deleteSession(env.DB, tempToken);

        // Crear session full
        const { token, expires_at } = await createSession(env.DB, user.id, 'full');

        return json({
          ok: true,
          session_token: token,
          expires_at,
          user: { email: user.email, nombre: user.nombre, rol: user.rol }
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── POST /api/auth/logout ───────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      try {
        const auth = request.headers.get('Authorization') || '';
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token) await deleteSession(env.DB, token);
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ── GET /api/auth/me ────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      return json({
        ok: true,
        user: {
          email: authUser.email,
          nombre: authUser.nombre,
          rol: authUser.rol
        }
      });
    }

    // ══════════════════════════════════════════════════════
    // TELEGRAM BOT
    // ══════════════════════════════════════════════════════

    // POST /api/telegram/webhook — Telegram envía updates aquí
    if (request.method === 'POST' && url.pathname === '/api/telegram/webhook') {
      try {
        // Validar secret token (lo configuramos en setupWebhook)
        const expected = env.TELEGRAM_WEBHOOK_SECRET;
        const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (expected && got !== expected) {
          return json({ error: 'Invalid secret' }, 403);
        }

        const update = await request.json();
        // Responder rápido a Telegram (procesar en background)
        ctx.waitUntil(handleTelegramUpdate(update, env).catch(err => console.error('TG err:', err)));
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // POST /api/telegram/setup — configura el webhook (admin only)
    if (request.method === 'POST' && url.pathname === '/api/telegram/setup') {
      try {
        const adminToken = request.headers.get('x-admin-token');
        if (!env.ADMIN_SETUP_TOKEN || adminToken !== env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Forbidden' }, 403);
        }
        if (!env.TELEGRAM_BOT_TOKEN) {
          return json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 400);
        }
        const webhookUrl = `https://${url.host}/api/telegram/webhook`;
        const secret = env.TELEGRAM_WEBHOOK_SECRET || crypto.randomUUID();
        const result = await setupWebhook(env, webhookUrl, secret);
        return json({
          ok: result.ok,
          webhook_url: webhookUrl,
          secret_to_save: env.TELEGRAM_WEBHOOK_SECRET ? '(already set)' : secret,
          telegram_response: result
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // GET /api/telegram/health — health check público (lectura)
    // Devuelve estado del webhook. No requiere admin token para que se pueda
    // monitorear desde sistemas externos (UptimeRobot, etc.)
    if (request.method === 'GET' && url.pathname === '/api/telegram/health') {
      try {
        const health = await checkWebhookHealth(env);
        return json(health, health.healthy ? 200 : 503);
      } catch (err) {
        return json({ healthy: false, reason: 'exception', detail: err.message }, 500);
      }
    }

    // POST /api/telegram/heal — fuerza re-registro del webhook (admin only)
    if (request.method === 'POST' && url.pathname === '/api/telegram/heal') {
      try {
        const adminToken = request.headers.get('x-admin-token');
        if (!env.ADMIN_SETUP_TOKEN || adminToken !== env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Forbidden' }, 403);
        }
        const result = await healWebhook(env);
        const after = await checkWebhookHealth(env);
        return json({ heal: result, status_after: after });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // GET /api/telegram/info — estado del bot (admin only)
    if (request.method === 'GET' && url.pathname === '/api/telegram/info') {
      try {
        const adminToken = request.headers.get('x-admin-token');
        if (!env.ADMIN_SETUP_TOKEN || adminToken !== env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Forbidden' }, 403);
        }
        if (!env.TELEGRAM_BOT_TOKEN) {
          return json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 400);
        }
        const me = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`).then(r => r.json());
        const wh = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`).then(r => r.json());
        return json({
          bot: me.result,
          webhook: wh.result,
          authorized_chats: env.TELEGRAM_AUTHORIZED_CHATS ? env.TELEGRAM_AUTHORIZED_CHATS.split(',').length : 0
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PAGO MASIVO FINANDINA
    // ════════════════════════════════════════════════════════════════════

    // GET /api/pago-masivo/bancos — lista de bancos disponibles
    if (request.method === 'GET' && url.pathname === '/api/pago-masivo/bancos') {
      return json({ bancos: Object.keys(BANCO_A_FINANDINA), oficial: BANCO_A_FINANDINA });
    }

    // POST /api/extraer-certificado-bancario — OCR de certificación bancaria
    // Recibe multipart con campo 'file', devuelve JSON con datos extraídos
    if (request.method === 'POST' && url.pathname === '/api/extraer-certificado-bancario') {
      try {
        if (!env.GEMINI_API_KEY) {
          return json({ error: 'GEMINI_API_KEY no configurada en el Worker' }, 500);
        }

        const form = await request.formData();
        const file = form.get('file');
        if (!file) return json({ error: 'No file' }, 400);

        const mimeType = file.type || 'application/pdf';
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);

        const extraido = await extraerCertificadoBancario(b64, mimeType, env.GEMINI_API_KEY);

        // Si tiene titular, también separamos en nombre/apellido (para PN)
        const split = splitTitular(extraido.titular);

        return json({
          ok: true,
          extraido,
          // Mapeo directo a campos del form de proveedores
          form_prefill: {
            banco_finandina: extraido.banco_finandina,
            tipo_cuenta: extraido.tipo_cuenta_cocicp,
            numero_cuenta: extraido.numero_cuenta,
            numero_documento_titular: extraido.cedula_nit,
            nombre_titular: split.nombre,
            apellido_titular: split.apellido,
            razon_social_titular: extraido.titular,  // si es NIT, va como razón social
          },
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // GET /api/proveedores — lista todos con estado de info bancaria
    if (request.method === 'GET' && url.pathname === '/api/proveedores') {
      try {
        // Cuenta gastos del último año por proveedor para priorizar
        const result = await env.DB.prepare(`
          SELECT p.*,
                 (SELECT COUNT(*) FROM gastos g WHERE g.proveedor_nit = p.nit) AS gastos_total,
                 (SELECT COUNT(*) FROM gastos g WHERE g.proveedor_nit = p.nit
                   AND (g.pagado_via IS NULL OR g.pagado_via = '')) AS gastos_sin_pagar,
                 (SELECT COALESCE(SUM(g.total),0) FROM gastos g WHERE g.proveedor_nit = p.nit
                   AND (g.pagado_via IS NULL OR g.pagado_via = '')) AS total_sin_pagar
          FROM proveedores p
          ORDER BY gastos_sin_pagar DESC, gastos_total DESC
        `).all();

        const rows = result.results || [];
        const conInfo = rows.filter(r => r.banco_finandina && r.numero_cuenta && r.numero_documento_titular);
        const sinInfo = rows.filter(r => !(r.banco_finandina && r.numero_cuenta && r.numero_documento_titular));

        return json({
          ok: true,
          total: rows.length,
          con_info: conInfo.length,
          sin_info: sinInfo.length,
          proveedores: rows,
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // POST /api/proveedores — crear nuevo proveedor en el catálogo (con info opcional bancaria)
    if (request.method === 'POST' && url.pathname === '/api/proveedores') {
      try {
        // (Fase 2.10) Datos bancarios de terceros → rol tesorería/admin
        if (!requireRole('tesoreria')) return json({ error: 'Requiere rol de tesorería o admin' }, 403);
        const b = await request.json();
        if (!b.nombre && !b.nombre_corto) return json({ error: 'Nombre requerido' }, 400);

        // Evitar duplicado por NIT si lo aportan
        if (b.nit) {
          const exists = await env.DB.prepare('SELECT id FROM proveedores WHERE nit = ?').bind(b.nit).first();
          if (exists) return json({ error: `Ya existe un proveedor con NIT ${b.nit}`, id: exists.id }, 409);
        }

        const result = await env.DB.prepare(`
          INSERT INTO proveedores (
            nit, nombre, nombre_corto, categoria_default,
            banco_finandina, tipo_cuenta, numero_cuenta,
            tipo_documento_titular, numero_documento_titular,
            nombre_titular, apellido_titular, razon_social_titular,
            email_notificacion
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          b.nit || null,
          b.nombre || b.nombre_corto,
          b.nombre_corto || b.nombre,
          b.categoria_default || null,
          b.banco_finandina || null,
          b.tipo_cuenta || null,
          b.numero_cuenta || null,
          b.tipo_documento_titular || null,
          b.numero_documento_titular || null,
          b.nombre_titular || null,
          b.apellido_titular || null,
          b.razon_social_titular || null,
          b.email_notificacion || null
        ).run();

        return json({ ok: true, id: result.meta?.last_row_id });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // POST /api/pago-masivo/finandina-directo — genera TXT desde proveedores + montos custom
    // (NO requiere gastos en D1, es un pago directo)
    if (request.method === 'POST' && url.pathname === '/api/pago-masivo/finandina-directo') {
      try {
        // (Fase 3 + roles) Solo tesorería/admin
        if (!requireRole('tesoreria')) return json({ error: 'Requiere rol de tesorería o admin' }, 403);

        const body = await request.json();
        const { pagos, fechaPago, cuentaOrigen, tipoOrigen } = body;
        // pagos: [{ proveedor_id, valor, referencia1?, referencia2? }]

        if (!Array.isArray(pagos) || pagos.length === 0) {
          return json({ error: 'Sin pagos especificados' }, 400);
        }
        if (!isValidDateStr(fechaPago)) return json({ error: 'fechaPago inválida (YYYY-MM-DD)' }, 400);
        if (!String(cuentaOrigen || '').replace(/\D/g, '')) return json({ error: 'cuentaOrigen requerida' }, 400);

        // Próximo consecutivo
        const last = await env.DB.prepare('SELECT MAX(identificacion) as max FROM dispersiones').first();
        const identificacionArchivo = (last?.max || 0) + 1;

        // Cargar proveedores y construir beneficiarios
        const beneficiarios = [];
        const errores = [];
        for (const p of pagos) {
          // (Fase 3.1/3.2) Rechaza cero/negativo/crédito/NaN — nunca Math.abs
          const amt = sanitizePayAmount(p.valor);
          if (!amt.ok) {
            errores.push(`Proveedor ${p.proveedor_id}: valor inválido (${amt.reason})`);
            continue;
          }
          const valor = amt.value;
          const row = await env.DB.prepare('SELECT * FROM proveedores WHERE id = ?').bind(p.proveedor_id).first();
          if (!row) {
            errores.push(`Proveedor ID ${p.proveedor_id}: no encontrado`);
            continue;
          }
          if (!row.banco_finandina || !row.tipo_cuenta || !row.numero_cuenta) {
            errores.push(`${row.nombre_corto || row.nombre}: falta info bancaria`);
            continue;
          }
          const tipoDoc = row.tipo_documento_titular || 'CC';
          const isPJ = tipoDoc === 'NIT';
          beneficiarios.push({
            tipoIdentificacion: tipoDoc,
            identificacion: (row.numero_documento_titular || '').replace(/\D/g, ''),
            ...(isPJ
              ? { razonSocial: row.razon_social_titular || row.nombre_corto || row.nombre }
              : {
                  nombre: row.nombre_titular || (row.nombre_corto || row.nombre).split(' ')[0],
                  apellido: row.apellido_titular || (row.nombre_corto || row.nombre).split(' ').slice(1).join(' ') || 'PROVEEDOR',
                }),
            cuentaDestino: String(row.numero_cuenta).replace(/\D/g, ''),
            tipoCuentaDestino: row.tipo_cuenta,
            banco: row.banco_finandina,
            valor,
            referencia1: (p.referencia1 || `PAGO-${row.id}`).slice(0, 30),
            referencia2: (p.referencia2 || fechaPago.replace(/-/g, '')).slice(0, 30),
          });
        }

        if (beneficiarios.length === 0) {
          return json({ error: 'Ningún pago válido', errores }, 400);
        }

        const cabecera = {
          fechaPago: new Date(fechaPago + 'T12:00:00Z'),
          identificacionArchivo,
          tipoOrigen: tipoOrigen || 'ahorros',
          cuentaOrigen: String(cuentaOrigen).replace(/\D/g, ''),
        };
        const { content, resumen } = generarArchivoDispersion(cabecera, beneficiarios);
        const filename = sugerirNombreArchivo(resumen);

        // Registrar dispersión
        await env.DB.prepare(`
          INSERT INTO dispersiones
            (identificacion, fecha_pago, cuenta_origen, tipo_origen, total_registros, total_valor, archivo_nombre, gastos_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          identificacionArchivo, fechaPago, cabecera.cuentaOrigen, cabecera.tipoOrigen,
          resumen.totalRegistros, resumen.totalValor, filename,
          'DIRECTO:' + pagos.map(p => p.proveedor_id).join(',')
        ).run();

        const bytes = contentToLatin1Bytes(content);
        return new Response(bytes, {
          headers: {
            ...CORS,
            'Content-Type': 'text/plain; charset=iso-8859-1',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Resumen-Registros': String(resumen.totalRegistros),
            'X-Resumen-Total': String(resumen.totalValor),
            'X-Archivo-Nombre': filename,
            'X-Errores': errores.length > 0 ? errores.join(' | ').slice(0, 500) : '',
          },
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // DELETE /api/proveedores/:id — borra un proveedor del catálogo
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/proveedores/') &&
        !url.pathname.endsWith('/banco')) {
      try {
        const idStr = url.pathname.replace('/api/proveedores/', '');
        const id = parseInt(idStr);
        if (!id) return json({ error: 'ID inválido' }, 400);

        // Info para feedback
        const row = await env.DB.prepare('SELECT nombre_corto, nombre FROM proveedores WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Proveedor no encontrado' }, 404);

        await env.DB.prepare('DELETE FROM proveedores WHERE id = ?').bind(id).run();
        return json({ ok: true, borrado: row.nombre_corto || row.nombre });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // PUT /api/proveedores/:id/banco — actualiza info bancaria del proveedor
    if (request.method === 'PUT' && url.pathname.startsWith('/api/proveedores/') && url.pathname.endsWith('/banco')) {
      try {
        const idStr = url.pathname.replace('/api/proveedores/', '').replace('/banco', '');
        const id = parseInt(idStr);
        if (!id) return json({ error: 'ID inválido' }, 400);

        const body = await request.json();
        await env.DB.prepare(`
          UPDATE proveedores SET
            banco_finandina = ?,
            tipo_cuenta = ?,
            numero_cuenta = ?,
            tipo_documento_titular = ?,
            numero_documento_titular = ?,
            nombre_titular = ?,
            apellido_titular = ?,
            razon_social_titular = ?,
            email_notificacion = ?
          WHERE id = ?
        `).bind(
          body.banco_finandina || null,
          body.tipo_cuenta || null,
          body.numero_cuenta || null,
          body.tipo_documento_titular || null,
          body.numero_documento_titular || null,
          body.nombre_titular || null,
          body.apellido_titular || null,
          body.razon_social_titular || null,
          body.email_notificacion || null,
          id
        ).run();
        return json({ ok: true });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // GET /api/pago-masivo/preview — verifica qué gastos están listos vs faltan info
    // ?ids=1,2,3
    if (request.method === 'GET' && url.pathname === '/api/pago-masivo/preview') {
      try {
        const ids = (url.searchParams.get('ids') || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
        if (ids.length === 0) return json({ error: 'Sin IDs' }, 400);

        const placeholders = ids.map(() => '?').join(',');
        const result = await env.DB.prepare(`
          SELECT g.id, g.numero, g.fecha, g.proveedor_nit, g.proveedor_nombre,
                 g.total, g.concepto, g.numero_documento, g.pagado_via,
                 p.id as prov_id,
                 p.banco_finandina, p.tipo_cuenta, p.numero_cuenta,
                 p.tipo_documento_titular, p.numero_documento_titular,
                 p.nombre_titular, p.apellido_titular, p.razon_social_titular
          FROM gastos g
          LEFT JOIN proveedores p ON p.nit = g.proveedor_nit
          WHERE g.id IN (${placeholders})
        `).bind(...ids).all();

        const listos = [];
        const faltan = [];
        const yaPagados = [];

        for (const r of (result.results || [])) {
          if (r.pagado_via === 'finandina') {
            yaPagados.push(r);
            continue;
          }
          const ok = r.banco_finandina && r.tipo_cuenta && r.numero_cuenta &&
                     r.tipo_documento_titular && r.numero_documento_titular &&
                     ((r.tipo_documento_titular === 'NIT' && r.razon_social_titular) ||
                      (r.tipo_documento_titular !== 'NIT' && r.nombre_titular && r.apellido_titular));
          if (ok) listos.push(r);
          else faltan.push(r);
        }

        return json({
          ok: true,
          listos,
          faltan,
          yaPagados,
          total_listos: listos.reduce((s, r) => s + (r.total || 0), 0),
        });
      } catch (err) {
        return fail(url.pathname, err);
      }
    }

    // POST /api/pago-masivo/finandina — genera el archivo TXT
    if (request.method === 'POST' && url.pathname === '/api/pago-masivo/finandina') {
      try {
        // (Fase 3 + roles) Solo tesorería/admin generan dispersiones
        if (!requireRole('tesoreria')) return json({ error: 'Requiere rol de tesorería o admin' }, 403);

        const body = await request.json();
        const { gastoIds, fechaPago, cuentaOrigen, tipoOrigen, marcarComoPagado, overridesValor, opId, aprobados } = body;

        if (!Array.isArray(gastoIds) || gastoIds.length === 0) return json({ error: 'Sin gastos seleccionados' }, 400);
        if (!gastoIds.every(isPositiveId)) return json({ error: 'IDs de gasto inválidos' }, 400);
        if (!isValidDateStr(fechaPago)) return json({ error: 'fechaPago inválida (YYYY-MM-DD)' }, 400);
        const cuentaOrigenDig = String(cuentaOrigen || '').replace(/\D/g, '');
        if (!cuentaOrigenDig) return json({ error: 'cuentaOrigen requerida' }, 400);

        // (Fase 3.10) Idempotencia por clave de operación
        if (opId) {
          const prev = await env.DB.prepare('SELECT id, archivo_nombre FROM dispersiones WHERE op_id = ?')
            .bind(String(opId)).first().catch(() => null);
          if (prev) return json({ error: 'Operación ya procesada', duplicada: true, archivo: prev.archivo_nombre }, 409);
        }

        // (Fase 3.4) Aprobación explícita por gasto: importe/proveedor/cuenta esperados
        const aprobMap = {};
        if (Array.isArray(aprobados)) {
          for (const a of aprobados) if (a && isPositiveId(a.gasto_id)) aprobMap[a.gasto_id] = a;
        }

        const placeholders = gastoIds.map(() => '?').join(',');
        const result = await env.DB.prepare(`
          SELECT g.id, g.total, g.es_nota_credito, g.numero_documento, g.proveedor_nit, g.proveedor_nombre, g.fecha,
                 p.banco_finandina, p.tipo_cuenta, p.numero_cuenta,
                 p.tipo_documento_titular, p.numero_documento_titular,
                 p.nombre_titular, p.apellido_titular, p.razon_social_titular
          FROM gastos g
          LEFT JOIN proveedores p ON p.nit = g.proveedor_nit
          WHERE g.id IN (${placeholders}) AND (g.pagado_via IS NULL OR g.pagado_via = '')
        `).bind(...gastoIds).all();

        const rows = result.results || [];
        if (rows.length === 0) return json({ error: 'Ningún gasto seleccionable (¿ya pagados?)' }, 400);

        const errores = [];
        const beneficiarios = [];
        const idsIncluidos = [];
        for (const r of rows) {
          // (Fase 3.1/3.2) Excluir notas crédito y todo importe no positivo — NUNCA Math.abs
          if (r.es_nota_credito) { errores.push(`Gasto #${r.id}: nota crédito, excluido del pago`); continue; }
          const rawValor = (overridesValor && overridesValor[r.id] != null) ? overridesValor[r.id] : r.total;
          const amt = sanitizePayAmount(rawValor);
          if (!amt.ok) { errores.push(`Gasto #${r.id}: importe inválido (${amt.reason}), excluido`); continue; }
          if (!r.banco_finandina || !r.tipo_cuenta || !r.numero_cuenta) {
            errores.push(`Gasto #${r.id} (${r.proveedor_nombre}): falta info bancaria del proveedor`); continue;
          }

          // Validar contra la aprobación explícita del usuario (si viene)
          const ap = aprobMap[r.id];
          if (ap) {
            const cuentaDb = String(r.numero_cuenta).replace(/\D/g, '');
            if (ap.importe != null && Math.round(Number(ap.importe)) !== amt.value) { errores.push(`Gasto #${r.id}: importe aprobado no coincide`); continue; }
            if (ap.cuenta && String(ap.cuenta).replace(/\D/g, '') !== cuentaDb) { errores.push(`Gasto #${r.id}: cuenta destino no coincide`); continue; }
            if (ap.proveedor_nit && String(ap.proveedor_nit).replace(/\D/g, '') !== String(r.proveedor_nit || '').replace(/\D/g, '')) { errores.push(`Gasto #${r.id}: proveedor no coincide`); continue; }
          }

          const tipoDoc = r.tipo_documento_titular || 'CC';
          const isPJ = tipoDoc === 'NIT';
          beneficiarios.push({
            tipoIdentificacion: tipoDoc,
            identificacion: (r.numero_documento_titular || '').replace(/\D/g, ''),
            ...(isPJ
              ? { razonSocial: r.razon_social_titular || r.proveedor_nombre }
              : {
                  nombre: r.nombre_titular || (r.proveedor_nombre || '').split(' ')[0],
                  apellido: r.apellido_titular || (r.proveedor_nombre || '').split(' ').slice(1).join(' ') || 'PROVEEDOR',
                }),
            cuentaDestino: String(r.numero_cuenta).replace(/\D/g, ''),
            tipoCuentaDestino: r.tipo_cuenta,
            banco: r.banco_finandina,
            valor: amt.value,
            referencia1: (r.numero_documento || `GASTO${r.id}`).slice(0, 30),
            referencia2: r.fecha?.replace(/-/g, '') || '',
          });
          idsIncluidos.push(r.id);
        }

        if (beneficiarios.length === 0) return json({ error: 'Ningún gasto pagable con los filtros actuales', errores }, 400);

        const identificacionArchivo = ((await env.DB.prepare('SELECT MAX(identificacion) as max FROM dispersiones').first())?.max || 0) + 1;
        const cabecera = {
          fechaPago: new Date(fechaPago + 'T12:00:00Z'),
          identificacionArchivo,
          tipoOrigen: tipoOrigen === 'corriente' ? 'corriente' : 'ahorros',
          cuentaOrigen: cuentaOrigenDig,
        };
        // Generar TXT (esto puede lanzar; si lanza NO se marca nada como pagado)
        const { content, resumen } = generarArchivoDispersion(cabecera, beneficiarios);
        const filename = sugerirNombreArchivo(resumen);
        const fileHash = await sha256Hex(content);

        // Registrar dispersión (tras generar OK) — solo los ids realmente incluidos
        await env.DB.prepare(`
          INSERT INTO dispersiones
            (identificacion, fecha_pago, cuenta_origen, tipo_origen, total_registros, total_valor, archivo_nombre, gastos_ids, op_id, archivo_hash, creado_por)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          identificacionArchivo, fechaPago, cabecera.cuentaOrigen, cabecera.tipoOrigen,
          resumen.totalRegistros, resumen.totalValor, filename, idsIncluidos.join(','),
          opId ? String(opId) : null, fileHash, authUser?.email || 'sistema'
        ).run().catch(async () => {
          // Degradación si la migración 0003 (op_id/archivo_hash/creado_por) no está aplicada
          await env.DB.prepare(`
            INSERT INTO dispersiones (identificacion, fecha_pago, cuenta_origen, tipo_origen, total_registros, total_valor, archivo_nombre, gastos_ids)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(identificacionArchivo, fechaPago, cabecera.cuentaOrigen, cabecera.tipoOrigen,
            resumen.totalRegistros, resumen.totalValor, filename, idsIncluidos.join(',')).run();
        });

        // (Fase 3.9/3.11) Marcar pagado SOLO los ids incluidos, atómicamente, tras generar el archivo
        if (marcarComoPagado) {
          const stmts = idsIncluidos.map(gid =>
            env.DB.prepare(`UPDATE gastos SET pagado_via='finandina', fecha_pago_masivo=?, archivo_dispersion=? WHERE id=?`)
              .bind(fechaPago, filename, gid));
          if (stmts.length) await env.DB.batch(stmts);
        }

        // (Fase 3.12) Auditoría estructurada
        console.log(JSON.stringify({
          level: 'audit', evento: 'pago-masivo', reqId,
          usuario: authUser?.email, fechaPago, ids: idsIncluidos,
          registros: resumen.totalRegistros, total: resumen.totalValor,
          archivo: filename, hash: fileHash.slice(0, 32), opId: opId || null,
        }));

        const bytes = contentToLatin1Bytes(content);
        return new Response(bytes, {
          headers: {
            ...CORS,
            'Content-Type': 'text/plain; charset=iso-8859-1',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Resumen-Registros': String(resumen.totalRegistros),
            'X-Resumen-Total': String(resumen.totalValor),
            'X-Archivo-Nombre': filename,
            'X-Errores': errores.length > 0 ? errores.join(' | ').slice(0, 500) : '',
          },
        });
      } catch (err) {
        return fail('/api/pago-masivo/finandina', err);
      }
    }

    return json({ error: 'Not found' }, 404);
  },

  // ═══════════════════════════════════════════════════════════
  // CRON: Alertas diarias por email (Resend)
  // Se ejecuta todos los días a las 7am Colombia
  // ═══════════════════════════════════════════════════════════
  async scheduled(event, env, ctx) {
    const now = new Date();
    const dia = now.getUTCDate();
    const mes = now.getUTCMonth() + 1;
    const anio = now.getUTCFullYear();
    const mesStr = `${anio}-${String(mes).padStart(2, '0')}`;

    // ── 0. Telegram self-healing (siempre primero, no debe fallar el resto) ──
    let telegramAlert = null;
    try {
      const health = await checkWebhookHealth(env);
      if (!health.healthy) {
        console.log('[CRON] Telegram webhook unhealthy:', health.reason);
        const heal = await healWebhook(env);
        const after = await checkWebhookHealth(env);
        telegramAlert = {
          had_issue: true,
          reason: health.reason,
          detail: health.last_error_message || health.detail || null,
          heal_attempted: heal.ok,
          recovered: after.healthy
        };
        console.log('[CRON] Heal result:', telegramAlert);
      } else {
        console.log('[CRON] Telegram webhook healthy');
      }
    } catch (err) {
      console.error('[CRON] Telegram health check failed:', err.message);
      telegramAlert = { had_issue: true, reason: 'check_threw', detail: err.message };
    }

    // 1. Obtener obligaciones pendientes
    const obligs = await env.DB.prepare('SELECT * FROM obligaciones WHERE activo = 1').all();
    const gastosDelMes = await env.DB.prepare(
      "SELECT proveedor_nit, proveedor_nombre, total, fecha FROM gastos WHERE strftime('%Y-%m', fecha) = ?"
    ).bind(mesStr).all();

    const gastosNits = new Set((gastosDelMes.results || []).map(g => (g.proveedor_nit || '').replace(/\D/g, '')));
    const gastosNombres = (gastosDelMes.results || []).map(g => (g.proveedor_nombre || '').toLowerCase());

    const vencidas = [];
    const proximas = [];
    const pagadas = [];

    for (const ob of (obligs.results || [])) {
      if (ob.frecuencia === 'anual') continue; // solo mensuales por ahora

      const nitBase = (ob.proveedor_nit || '').replace(/\D/g, '');
      const nombreLower = (ob.proveedor_nombre || ob.nombre || '').toLowerCase();
      const pagado = (nitBase && gastosNits.has(nitBase)) ||
        gastosNombres.some(n => n.includes(nombreLower) || nombreLower.includes(n));

      if (pagado) {
        pagadas.push(ob);
      } else if (ob.dia_limite && dia > ob.dia_limite) {
        vencidas.push(ob);
      } else if (ob.dia_limite && (ob.dia_limite - dia) <= 3) {
        proximas.push(ob);
      }
    }

    // 2. Gastos en revisión
    const revision = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM gastos WHERE estado = 'revision'"
    ).first();
    const enRevision = revision?.cnt || 0;

    // 3. Solo enviar si hay algo que reportar (incluye issues de Telegram)
    if (vencidas.length === 0 && proximas.length === 0 && enRevision === 0 && !telegramAlert?.had_issue) return;

    // 4. Construir email HTML
    const fmtCOP = v => v ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v) : '';
    const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    let html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d0f0e;color:#e8ede8;padding:24px;border-radius:12px;">
      <div style="border-bottom:1px solid #222724;padding-bottom:16px;margin-bottom:16px;">
        <h1 style="font-size:20px;font-weight:300;color:#b8f0a0;margin:0;">COCICP <span style="color:#6b7a6b;font-style:italic">alertas</span></h1>
        <p style="color:#6b7a6b;font-size:12px;margin:4px 0 0;">${dia} ${meses[mes-1]} ${anio}</p>
      </div>`;

    if (vencidas.length > 0) {
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:#f0b0a0;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">🔴 Vencidas (${vencidas.length})</h2>`;
      for (const ob of vencidas) {
        html += `<div style="background:#1a1111;border-left:3px solid #f0b0a0;padding:10px 14px;margin-bottom:6px;border-radius:0 6px 6px 0;">
          <strong style="color:#e8ede8;">${ob.nombre}</strong>
          <span style="color:#6b7a6b;font-size:11px;"> · ${ob.tipo === 'empresa' ? 'COCICP' : 'Personal'} · Día ${ob.dia_limite}</span>
          ${ob.valor_estimado ? `<span style="float:right;color:#f0b0a0;font-weight:500;">${fmtCOP(ob.valor_estimado)}</span>` : ''}
        </div>`;
      }
      html += '</div>';
    }

    if (proximas.length > 0) {
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:#f0e0a0;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">🟡 Próximas a vencer (${proximas.length})</h2>`;
      for (const ob of proximas) {
        const diasRestantes = ob.dia_limite - dia;
        html += `<div style="background:#1a1a11;border-left:3px solid #f0e0a0;padding:10px 14px;margin-bottom:6px;border-radius:0 6px 6px 0;">
          <strong style="color:#e8ede8;">${ob.nombre}</strong>
          <span style="color:#6b7a6b;font-size:11px;"> · ${diasRestantes === 0 ? 'HOY' : diasRestantes + ' día(s)'} · Día ${ob.dia_limite}</span>
          ${ob.valor_estimado ? `<span style="float:right;color:#f0e0a0;font-weight:500;">${fmtCOP(ob.valor_estimado)}</span>` : ''}
        </div>`;
      }
      html += '</div>';
    }

    if (enRevision > 0) {
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:#a0d0f0;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">📋 Gastos en revisión</h2>
        <div style="background:#111a1a;border-left:3px solid #a0d0f0;padding:10px 14px;border-radius:0 6px 6px 0;">
          ${enRevision} gasto(s) pendientes de revisión
        </div>
      </div>`;
    }

    // ── Bloque alerta Telegram (solo si hubo issue) ──
    if (telegramAlert?.had_issue) {
      const statusColor = telegramAlert.recovered ? '#f0e0a0' : '#f0b0a0';
      const statusIcon = telegramAlert.recovered ? '🟡' : '🔴';
      const statusText = telegramAlert.recovered
        ? 'Webhook recuperado automáticamente'
        : 'Webhook NO se pudo recuperar — revisa manualmente';
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:${statusColor};text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">${statusIcon} Telegram Bot</h2>
        <div style="background:#1a1a11;border-left:3px solid ${statusColor};padding:10px 14px;border-radius:0 6px 6px 0;">
          <strong style="color:#e8ede8;">${statusText}</strong>
          <div style="font-size:11px;color:#6b7a6b;margin-top:4px;">Razón: ${telegramAlert.reason}${telegramAlert.detail ? ' — ' + telegramAlert.detail : ''}</div>
        </div>
      </div>`;
    }

    html += `<div style="text-align:center;margin-top:20px;">
        <a href="${env.FRONTEND_URL || 'https://cocicp.davidduque.com'}" style="display:inline-block;background:#b8f0a0;color:#0d1a0d;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:500;font-size:13px;">Abrir COCICP Gastos</a>
      </div>
      <div style="text-align:center;margin-top:12px;color:#6b7a6b;font-size:10px;">
        ${pagadas.length} obligaciones pagadas este mes ✓
      </div>
    </div>`;

    // 5. Enviar por Resend
    const resendKey = env.RESEND_API_KEY;
    if (!resendKey) return;

    let subject;
    if (telegramAlert?.had_issue && !telegramAlert.recovered) {
      subject = `🔴 Telegram bot caído + alertas — ${dia} ${meses[mes-1]}`;
    } else if (vencidas.length > 0) {
      subject = `🔴 ${vencidas.length} obligación(es) vencida(s) — ${dia} ${meses[mes-1]}`;
    } else if (proximas.length > 0) {
      subject = `🟡 ${proximas.length} pago(s) próximo(s) — ${dia} ${meses[mes-1]}`;
    } else if (telegramAlert?.had_issue) {
      subject = `🟡 Telegram bot reparado — ${dia} ${meses[mes-1]}`;
    } else {
      subject = `📋 ${enRevision} gasto(s) en revisión — ${dia} ${meses[mes-1]}`;
    }

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM || 'COCICP Alertas <alertas@davidduque.com>',
        to: [env.ALERT_EMAIL_TO || 'ddropero@gmail.com'],
        subject,
        html
      })
    });
  }
};
