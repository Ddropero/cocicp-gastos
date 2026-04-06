// ============================================================
// COCICP Gastos — Worker Cloudflare
// 3 agentes en paralelo con Promise.all()
// Bindings: DB (D1) | BUCKET (R2) | ANTHROPIC_API_KEY (secret)
// ============================================================

import { runAgent1 } from './agent1-fiscal.js';
import { runAgent2 } from './agent2-provider.js';
import { runAgent3 } from './agent3-classification.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

    return json({ error: 'Not found' }, 404);
  }
};
