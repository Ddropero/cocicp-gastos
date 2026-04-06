// ============================================================
// COCICP Gastos — Worker Cloudflare
// 3 agentes en paralelo con Promise.all()
// Bindings: DB (D1) | BUCKET (R2) | ANTHROPIC_API_KEY (secret)
// ============================================================

import { runAgent1 } from './agent1-fiscal.js';
import { runAgent2 } from './agent2-provider.js';
import { runAgent3 } from './agent3-classification.js';
import { checkRecurrentes } from './recurrentes.js';
import { generateReport } from './report-pdf.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

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

async function checkDuplicate(db, numeroDocumento, total, fecha, proveedorNit) {
  if (!db) return null;
  // 1. Exacto por numero_documento
  if (numeroDocumento) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ?'
    ).bind(numeroDocumento).first();
    if (row) return { tipo: 'numero_documento', registro: row };
  }
  // 2. Mismo total + misma fecha + mismo proveedor
  if (total && fecha && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND proveedor_nit = ?'
    ).bind(total, fecha, proveedorNit).first();
    if (row) return { tipo: 'total_fecha_proveedor', registro: row };
  }
  // 3. Mismo total + misma fecha (sin proveedor, más laxo)
  if (total && fecha) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ?'
    ).bind(total, fecha).first();
    if (row) return { tipo: 'total_fecha', registro: row };
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    // ── POST /api/upload ────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      try {
        const form    = await request.formData();
        const file    = form.get('file');
        const usuario = form.get('usuario') || 'david';
        if (!file) return json({ error: 'No file' }, 400);

        const mimeType = file.type;
        const buf      = await file.arrayBuffer();
        const bytes    = new Uint8Array(buf);
        let binary     = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64      = btoa(binary);

        const r2Key     = `soportes/${Date.now()}-${file.name}`;
        const r2Promise = env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType: mimeType } });

        // ★ 3 agentes simultáneos
        const apiKey = env.ANTHROPIC_API_KEY;
        const [a1, a2, a3] = await Promise.all([
          runAgent1(b64, mimeType, apiKey),
          runAgent2(b64, mimeType, env.DB, apiKey),
          runAgent3(b64, mimeType, apiKey)
        ]);

        await r2Promise;

        const preview = mergeAgents(a1, a2, a3, usuario);
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

          const maxRow = await env.DB.prepare('SELECT MAX(numero) as max FROM gastos').first();
          const numero = (maxRow?.max || 0) + 1;

          await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            numero, preview.fecha, preview.proveedor_nit, preview.proveedor_nombre,
            preview.numero_documento, preview.concepto, preview.categoria,
            preview.valor_base || 0, preview.iva || 0, preview.inc || 0,
            preview.otros_impuestos || 0, preview.total,
            preview.es_nota_credito ? 1 : 0,
            preview.medio_pago, preview.referencia_pago,
            preview.archivo_r2, preview.usuario || 'david',
            'confirmado', preview.notas || null
          ).run();

          preview.auto_confirmado = true;
          return json({ ok: true, preview, auto_confirmado: true, numero });
        }

        return json({ ok: true, preview });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/confirm ───────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/confirm') {
      try {
        const body = await request.json();

        // Anti-duplicado robusto
        const dup = await checkDuplicate(env.DB, body.numero_documento, body.total, body.fecha, body.proveedor_nit);
        if (dup) {
          const r = dup.registro;
          const motivo = dup.tipo === 'numero_documento' ? 'mismo número de documento'
            : dup.tipo === 'total_fecha_proveedor' ? 'mismo total, fecha y proveedor'
            : 'mismo total y fecha';
          return json({ ok: false, error: `Duplicado (#${r.numero} — ${r.proveedor_nombre}): ${motivo}`, duplicado: true }, 409);
        }

        const maxRow = await env.DB.prepare('SELECT MAX(numero) as max FROM gastos').first();
        const numero = (maxRow?.max || 0) + 1;

        await env.DB.prepare(`
          INSERT INTO gastos
            (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
             concepto, categoria, valor_base, iva, inc, otros_impuestos,
             total, es_nota_credito, medio_pago, referencia_pago,
             archivo_r2, usuario, estado, notas)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          numero, body.fecha, body.proveedor_nit, body.proveedor_nombre,
          body.numero_documento, body.concepto, body.categoria,
          body.valor_base || 0, body.iva || 0, body.inc || 0,
          body.otros_impuestos || 0, body.total,
          body.es_nota_credito ? 1 : 0,
          body.medio_pago, body.referencia_pago,
          body.archivo_r2, body.usuario || 'david',
          body.estado || 'confirmado', body.notas || null
        ).run();

        return json({ ok: true, numero }, 201);
      } catch (err) {
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
      q += ' ORDER BY fecha DESC, id DESC';

      const result = await env.DB.prepare(q).bind(...v).all();
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
        const { filas } = await request.json();
        if (!filas || !Array.isArray(filas)) return json({ error: 'Se espera { filas: [...] }' }, 400);

        // Traer todos los gastos existentes para cruzar
        const existentes = await env.DB.prepare('SELECT id, numero, numero_documento, proveedor_nit, fecha, total, concepto, categoria, proveedor_nombre FROM gastos').all();
        const dbRows = existentes.results || [];

        // Índices para búsqueda rápida
        const porDocumento = {};
        const porNitFechaTotal = {};
        dbRows.forEach(r => {
          if (r.numero_documento) porDocumento[r.numero_documento.trim().toUpperCase()] = r;
          const key = `${(r.proveedor_nit||'').replace(/\D/g,'')}|${r.fecha}|${Math.round(Math.abs(r.total))}`;
          porNitFechaTotal[key] = r;
        });

        const resultados = { existentes: [], nuevos: [], completar: [] };

        for (const fila of filas) {
          const numDoc = (fila.numero_documento || '').trim().toUpperCase();
          const nitLimpio = (fila.nit_emisor || '').replace(/\D/g, '');
          const fecha = fila.fecha || null;
          const total = Math.round(Math.abs(parseFloat(fila.total) || 0));

          // Match 1: por numero_documento exacto
          let match = numDoc ? porDocumento[numDoc] : null;

          // Match 2: por NIT + fecha + total
          if (!match && nitLimpio && fecha) {
            const key = `${nitLimpio}|${fecha}|${total}`;
            match = porNitFechaTotal[key];
          }

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
          total_dian: filas.length,
          total_existentes: resultados.existentes.length,
          total_completar: resultados.completar.length,
          total_nuevos: resultados.nuevos.length,
          ...resultados
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/bulk-import ───────────────────────────────
    // Importar múltiples registros nuevos de golpe
    if (request.method === 'POST' && url.pathname === '/api/bulk-import') {
      try {
        const { registros } = await request.json();
        if (!registros || !Array.isArray(registros)) return json({ error: 'Se espera { registros: [...] }' }, 400);

        const maxRow = await env.DB.prepare('SELECT MAX(numero) as max FROM gastos').first();
        let numero = (maxRow?.max || 0) + 1;
        let insertados = 0;
        let omitidos = 0;

        for (const r of registros) {
          // Verificar duplicado antes de insertar
          if (r.numero_documento) {
            const dup = await env.DB.prepare('SELECT id FROM gastos WHERE numero_documento = ?').bind(r.numero_documento).first();
            if (dup) { omitidos++; continue; }
          }

          await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               usuario, estado, notas)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            numero, r.fecha, r.proveedor_nit || null, r.proveedor_nombre || 'Sin proveedor',
            r.numero_documento || null, r.concepto || 'Importado DIAN', r.categoria || 'Misceláneos',
            r.valor_base || 0, r.iva || 0, r.inc || 0, r.otros_impuestos || 0,
            r.total || 0, r.es_nota_credito ? 1 : 0,
            r.medio_pago || null, r.referencia_pago || null,
            'david', 'revision', 'Importado desde reporte DIAN'
          ).run();

          numero++;
          insertados++;
        }

        return json({ ok: true, insertados, omitidos });
      } catch (err) {
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/soporte/* ────────────────────────────────────
    if (request.method === 'GET' && url.pathname.startsWith('/api/soporte/')) {
      try {
        const key = url.pathname.replace('/api/soporte/', '');
        if (!key) return json({ error: 'Key requerida' }, 400);

        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'Archivo no encontrado' }, 404);

        return new Response(obj.body, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${key.split('/').pop()}"`,
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/reporte ───────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/reporte') {
      try {
        const p     = url.searchParams;
        const desde = p.get('desde') || '2026-01-01';
        const hasta = p.get('hasta') || '2026-12-31';

        const result = await env.DB.prepare(
          'SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, id DESC'
        ).bind(desde, hasta).all();

        const registros = result.results || [];

        const { generateReport } = await import('./report-pdf.js');
        const pdfBytes = generateReport(registros, desde, hasta);

        return new Response(pdfBytes, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="COCICP_Reporte_${desde}_${hasta}.pdf"`,
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/whatsapp/webhook — Verificacion Twilio ────────
    if (request.method === 'GET' && url.pathname === '/api/whatsapp/webhook') {
      return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    // ── POST /api/whatsapp/webhook — Recibir mensaje WhatsApp ──
    if (request.method === 'POST' && url.pathname === '/api/whatsapp/webhook') {
      try {
        // Twilio envia application/x-www-form-urlencoded
        const formData = await request.formData();

        const from       = formData.get('From')      || '';
        const body       = formData.get('Body')       || '';
        const numMedia   = parseInt(formData.get('NumMedia') || '0');
        const mediaUrl   = formData.get('MediaUrl0')  || null;
        const mediaType  = formData.get('MediaContentType0') || null;

        // Determinar usuario por numero de telefono
        const NUMEROS_AUTORIZADOS = {
          'whatsapp:+573001234567': 'david',
          'whatsapp:+573009876543': 'andrea',
        };
        const usuario = NUMEROS_AUTORIZADOS[from];

        if (!usuario) {
          await sendWhatsAppReply(
            env, from,
            'No autorizado. Contacte al administrador de COCICP.'
          );
          return new Response('<Response></Response>', {
            status: 200,
            headers: { 'Content-Type': 'text/xml' }
          });
        }

        // Sin imagen adjunta
        if (numMedia === 0 || !mediaUrl) {
          await sendWhatsAppReply(
            env, from,
            'Envie una foto o PDF de la factura para registrar el gasto.'
          );
          return new Response('<Response></Response>', {
            status: 200,
            headers: { 'Content-Type': 'text/xml' }
          });
        }

        // --- Descargar imagen desde Twilio con Basic Auth ---
        const twilioSid   = env.TWILIO_ACCOUNT_SID;
        const twilioToken = env.TWILIO_AUTH_TOKEN;
        const basicAuth   = btoa(`${twilioSid}:${twilioToken}`);

        const mediaRes = await fetch(mediaUrl, {
          headers: { 'Authorization': `Basic ${basicAuth}` }
        });

        if (!mediaRes.ok) {
          await sendWhatsAppReply(env, from, 'Error descargando imagen. Intente de nuevo.');
          return new Response('<Response></Response>', {
            status: 200,
            headers: { 'Content-Type': 'text/xml' }
          });
        }

        const mediaBuf   = await mediaRes.arrayBuffer();
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
          const maxRow = await env.DB.prepare(
            'SELECT MAX(numero) as max FROM gastos'
          ).first();
          const numero = (maxRow?.max || 0) + 1;

          await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            numero,
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
          ).run();

          replyMsg = [
            `\u2713 #${numero}`,
            preview.proveedor_nombre,
            `$${formatCOP(preview.total)}`,
            preview.categoria
          ].join(' ');

        } else {
          const maxRow = await env.DB.prepare(
            'SELECT MAX(numero) as max FROM gastos'
          ).first();
          const numero = (maxRow?.max || 0) + 1;

          await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               archivo_r2, usuario, estado, notas)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).bind(
            numero,
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
          ).run();

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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
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
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/obligaciones/:id ────────────────────────
    if (request.method === 'DELETE' && url.pathname.match(/^\/api\/obligaciones\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        await env.DB.prepare('UPDATE obligaciones SET activo = 0 WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  }
};
