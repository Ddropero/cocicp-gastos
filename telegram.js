// ============================================================
// Telegram Bot — captura de gastos COCICP por chat
// Usa el agente unificado (1 llamada IA) y guarda en D1+R2
// ============================================================

import { runOcrAgent } from './agent-router.js';
import { parseGastoTexto, detectarEntidad, ENTIDADES_VALIDAS } from './lib/chat-gasto.js';

const TG_API = 'https://api.telegram.org';

const ENTIDAD_EMOJI = { cocicp: '🏢 COCICP', restituyo: '🏭 Restituyo', personal: '👤 Personal' };

// ── Helpers Telegram ──────────────────────────────────────
async function tgRequest(token, method, body) {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(token, chatId, text, opts = {}) {
  return tgRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...opts
  });
}

async function sendChatAction(token, chatId, action = 'typing') {
  return tgRequest(token, 'sendChatAction', { chat_id: chatId, action });
}

// ── Authorization ─────────────────────────────────────────
function isAuthorized(chatId, env) {
  const raw = env.TELEGRAM_AUTHORIZED_CHATS || '';
  if (!raw) return false;
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  return allowed.includes(String(chatId));
}

// ── Format helpers ────────────────────────────────────────
function fmtCOP(n) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(n || 0);
}

function escapeMd(s) {
  return String(s || '').replace(/[_*`[\]]/g, '\\$&');
}

// ── checkDuplicate (mismo que worker.js) ──────────────────
async function checkDuplicate(db, numeroDocumento, total, fecha, proveedorNit) {
  if (!db) return null;
  if (numeroDocumento) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ?'
    ).bind(numeroDocumento).first();
    if (row) return { tipo: 'numero_documento', registro: row };
  }
  if (total && fecha && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND proveedor_nit = ?'
    ).bind(total, fecha, proveedorNit).first();
    if (row) return { tipo: 'total_fecha_proveedor', registro: row };
  }
  if (total && fecha) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ?'
    ).bind(total, fecha).first();
    if (row) return { tipo: 'total_fecha', registro: row };
  }
  return null;
}

// ── Comandos de texto ─────────────────────────────────────
async function handleCommand(env, chatId, text, fromName) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const cmd = text.trim().split(' ')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(token, chatId,
      `*Gastos Bot* 🤖 (COCICP · Restituyo · Personal)\n\n` +
      `Hola ${escapeMd(fromName)} 👋\n\n` +
      `1️⃣ Envía una *foto o PDF* de la factura y la registro con OCR.\n` +
      `2️⃣ O escribe el gasto directo, terminando con la entidad:\n` +
      `   _gasto en gasolina 100000 personal_\n` +
      `   _almuerzo clientes 85.000 restituyo_\n` +
      `   _papelería 45.500 cocicp_\n\n` +
      `*Comandos:*\n` +
      `/total — Total del mes (o /total personal)\n` +
      `/ultimos — Últimos 5 gastos\n` +
      `/help — Esta ayuda\n\n` +
      `Tu chat_id es: \`${chatId}\``
    );
    return;
  }

  if (cmd === '/total') {
    const now = new Date(Date.now() - 5 * 3600 * 1000); // Bogotá
    const desde = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-01`;
    const arg = (text.trim().split(/\s+/)[1] || '').toLowerCase();
    const entidad = ENTIDADES_VALIDAS.includes(arg) ? arg : null;
    let result = null;
    try {
      result = entidad
        ? await env.DB.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total FROM gastos WHERE fecha >= ? AND entidad = ?`).bind(desde, entidad).first()
        : await env.DB.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total FROM gastos WHERE fecha >= ?`).bind(desde).first();
    } catch {
      // Columna entidad aún no migrada: total global
      result = await env.DB.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total FROM gastos WHERE fecha >= ?`).bind(desde).first();
    }
    await sendMessage(token, chatId,
      `📊 *Mes actual${entidad ? ' — ' + (ENTIDAD_EMOJI[entidad] || entidad) : ''}*\n\n` +
      `Registros: *${result?.cnt || 0}*\n` +
      `Total: *${fmtCOP(result?.total || 0)}*`
    );
    return;
  }

  if (cmd === '/ultimos') {
    const rows = await env.DB.prepare(
      `SELECT numero, fecha, proveedor_nombre, total, categoria
       FROM gastos ORDER BY id DESC LIMIT 5`
    ).all();
    if (!rows.results?.length) {
      await sendMessage(token, chatId, 'No hay gastos registrados.');
      return;
    }
    const lines = rows.results.map(g =>
      `• #${g.numero} ${g.fecha} — ${escapeMd(g.proveedor_nombre)} ${fmtCOP(g.total)}\n  _${escapeMd(g.categoria)}_`
    );
    await sendMessage(token, chatId, `📋 *Últimos 5 gastos*\n\n${lines.join('\n\n')}`);
    return;
  }

  await sendMessage(token, chatId,
    'No entiendo ese comando. Envíame una *foto* de factura o usa /help'
  );
}

// ── Procesar foto/documento ───────────────────────────────
// caption: texto adjunto a la foto — define la entidad ("liceo julio cocicp") y se guarda en notas
async function handleMedia(env, chatId, fileId, fileName, mimeType, usuario, caption = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const entidad = detectarEntidad(caption || '') || 'cocicp';

  await sendChatAction(token, chatId, 'typing');

  // 1. Obtener file_path desde Telegram
  const fileInfo = await tgRequest(token, 'getFile', { file_id: fileId });
  if (!fileInfo.ok) {
    await sendMessage(token, chatId, '❌ No pude obtener el archivo de Telegram.');
    return;
  }
  const filePath = fileInfo.result.file_path;
  const fileSize = fileInfo.result.file_size || 0;

  if (fileSize > 20 * 1024 * 1024) {
    await sendMessage(token, chatId, '❌ Archivo demasiado grande (máx 20MB).');
    return;
  }

  // 2. Descargar archivo
  const downloadUrl = `${TG_API}/file/bot${token}/${filePath}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    await sendMessage(token, chatId, '❌ Error descargando archivo.');
    return;
  }
  const buf = await fileRes.arrayBuffer();

  // 3. Convertir a base64 y subir a R2
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);

  // Detectar mime type real
  let resolvedMime = mimeType;
  if (!resolvedMime || resolvedMime === 'application/octet-stream') {
    if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) resolvedMime = 'image/jpeg';
    else if (filePath.endsWith('.png')) resolvedMime = 'image/png';
    else if (filePath.endsWith('.pdf')) resolvedMime = 'application/pdf';
    else resolvedMime = 'image/jpeg';
  }

  const safeName = (fileName || filePath.split('/').pop() || 'telegram').replace(/[^\w.\-]/g, '_');
  const r2Key = `soportes/${Date.now()}-tg-${safeName}`;
  const r2Promise = env.BUCKET.put(r2Key, buf, {
    httpMetadata: { contentType: resolvedMime }
  });

  // 4. Procesar con IA (router: hybrid Gemini→Sonnet | sonnet | gemini)
  await sendChatAction(token, chatId, 'typing');
  const preview = await runOcrAgent(b64, resolvedMime, env, env.DB);

  await r2Promise;

  if (preview.error) {
    await sendMessage(token, chatId, `❌ Error procesando: ${preview.error}`);
    return;
  }

  // 5. Verificar duplicado
  const dup = await checkDuplicate(env.DB, preview.numero_documento, preview.total, preview.fecha, preview.proveedor_nit);
  if (dup) {
    const r = dup.registro;
    await sendMessage(token, chatId,
      `⚠️ *Duplicado*\n\nYa existe como #${r.numero} (${escapeMd(r.proveedor_nombre)} — ${fmtCOP(r.total)})\n\nNo se guardó.`
    );
    // Limpiar el archivo en R2
    try { await env.BUCKET.delete(r2Key); } catch {}
    return;
  }

  // 6. Insertar en D1 (con entidad; fallback si la migración 0005 no está aplicada)
  preview.archivo_r2 = r2Key;
  const notasMedia = 'Subido por Telegram' + (caption ? ` · nota: ${caption.slice(0, 120)}` : '');
  const bindComunes = [
    preview.fecha, preview.proveedor_nit, preview.proveedor_nombre,
    preview.numero_documento, preview.concepto, preview.categoria,
    preview.valor_base || 0, preview.iva || 0, preview.inc || 0,
    preview.otros_impuestos || 0, preview.total,
    preview.es_nota_credito ? 1 : 0,
    preview.medio_pago, preview.referencia_pago,
    preview.archivo_r2, usuario || 'david',
    preview.estado || 'confirmado',
  ];
  let numero, entidadGuardada = true;
  try {
    const ins = await env.DB.prepare(`
      INSERT INTO gastos
        (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
         concepto, categoria, valor_base, iva, inc, otros_impuestos,
         total, es_nota_credito, medio_pago, referencia_pago,
         archivo_r2, usuario, estado, notas, entidad)
      SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
             ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      RETURNING numero
    `).bind(...bindComunes, notasMedia, entidad).first();
    numero = ins.numero;
  } catch (err) {
    if (!/no column named entidad/i.test(err.message || '')) throw err;
    entidadGuardada = false;
    const ins = await env.DB.prepare(`
      INSERT INTO gastos
        (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento,
         concepto, categoria, valor_base, iva, inc, otros_impuestos,
         total, es_nota_credito, medio_pago, referencia_pago,
         archivo_r2, usuario, estado, notas)
      SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
             ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      RETURNING numero
    `).bind(...bindComunes, notasMedia + ' · entidad: ' + entidad).first();
    numero = ins.numero;
  }

  // 7. Responder con resumen
  const emoji = preview.estado === 'revision' ? '⚠️' : '✅';
  const estadoTxt = preview.estado === 'revision' ? '_Requiere revisión_' : '_Confirmado_';

  const resumen =
    `${emoji} *#${numero} guardado*\n\n` +
    `${ENTIDAD_EMOJI[entidad] || entidad}\n` +
    `*${escapeMd(preview.proveedor_nombre)}*\n` +
    `${fmtCOP(preview.total)}\n` +
    `${escapeMd(preview.concepto)}\n\n` +
    `📁 ${escapeMd(preview.categoria)}\n` +
    `📅 ${preview.fecha || '—'}\n` +
    `${estadoTxt}` +
    (entidadGuardada ? '' : `\n\n⚠️ _Entidad en notas (falta migración 0005)._`);

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, resumen);
}

// ── Gasto escrito en texto libre (multi-entidad) ──────────
async function handleTextoGasto(env, chatId, text, usuario) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const r = parseGastoTexto(text);

  if (!r.ok && r.motivo === 'sin_monto') {
    // No parece un gasto → ayuda estándar
    await sendMessage(token, chatId,
      `Envíame una *foto de la factura*, o escribe el gasto así:\n\n` +
      `_gasto en gasolina 100000 personal_\n` +
      `_almuerzo 85.000 restituyo_\n` +
      `_papelería 45.500 cocicp_\n\n` +
      `O usa /help`
    );
    return;
  }

  if (!r.ok && r.motivo === 'sin_entidad') {
    const p = r.parcial;
    await sendMessage(token, chatId,
      `Casi 👀 Entendí *${fmtCOP(p.total)}* en _${escapeMd(p.categoria)}_ pero falta la *entidad*.\n\n` +
      `Reenvíalo terminando con una de estas:\n` +
      `• \`${escapeMd(text.trim())} cocicp\`\n` +
      `• \`${escapeMd(text.trim())} restituyo\`\n` +
      `• \`${escapeMd(text.trim())} personal\``
    );
    return;
  }

  const g = r.gasto;

  // Aviso suave de posible duplicado (mismo total + fecha) — no bloquea un gasto manual deliberado
  let dupNota = '';
  try {
    const dup = await env.DB.prepare(
      'SELECT numero, proveedor_nombre FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? LIMIT 1'
    ).bind(g.total, g.fecha).first();
    if (dup) dupNota = `\n\n⚠️ _Ojo: parecido al #${dup.numero} (${escapeMd(dup.proveedor_nombre)}) del mismo día._`;
  } catch {}

  // INSERT con entidad; si la columna aún no existe (migración 0005 pendiente), fallback sin ella
  const cols = `(numero, fecha, proveedor_nombre, concepto, categoria, total, usuario, estado, notas, entidad)`;
  const colsSin = `(numero, fecha, proveedor_nombre, concepto, categoria, total, usuario, estado, notas)`;
  const notas = 'Gasto manual por chat Telegram';
  let numero, entidadGuardada = true;
  try {
    const ins = await env.DB.prepare(`
      INSERT INTO gastos ${cols}
      SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos), ?,?,?,?,?,?,?,?,?
      RETURNING numero
    `).bind(g.fecha, 'Manual (Telegram)', g.concepto, g.categoria, g.total, usuario || 'telegram', 'confirmado', notas, g.entidad).first();
    numero = ins.numero;
  } catch (err) {
    if (/no column named entidad|has no column named entidad/i.test(err.message || '')) {
      entidadGuardada = false;
      const ins = await env.DB.prepare(`
        INSERT INTO gastos ${colsSin}
        SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos), ?,?,?,?,?,?,?,?
        RETURNING numero
      `).bind(g.fecha, 'Manual (Telegram)', g.concepto, g.categoria, g.total, usuario || 'telegram', 'confirmado', notas + ' · entidad: ' + g.entidad).first();
      numero = ins.numero;
    } else {
      await sendMessage(token, chatId, `❌ No pude guardar el gasto. Intenta de nuevo o usa el dashboard.`);
      console.error('handleTextoGasto INSERT:', err.message);
      return;
    }
  }

  await sendMessage(token, chatId,
    `✅ *#${numero} guardado*\n\n` +
    `${ENTIDAD_EMOJI[g.entidad] || g.entidad}\n` +
    `*${escapeMd(g.concepto)}*\n` +
    `${fmtCOP(g.total)}\n` +
    `📁 ${escapeMd(g.categoria)} · 📅 ${g.fecha}\n` +
    `_Manual por chat (sin soporte adjunto)_` +
    (entidadGuardada ? '' : `\n\n⚠️ _La entidad quedó en las notas (falta aplicar la migración 0005)._`) +
    dupNota
  );
}

// ── Handler principal del webhook ─────────────────────────
export async function handleTelegramUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromName = msg.from?.first_name || msg.from?.username || 'usuario';
  const usuario = (msg.from?.username || 'telegram').toLowerCase();

  // Authorization
  if (!isAuthorized(chatId, env)) {
    if (env.TELEGRAM_BOT_TOKEN && chatId) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        `🔒 No autorizado.\n\nTu chat_id es \`${chatId}\`. Pídele al admin que lo agregue.`
      );
    }
    return;
  }

  // Photo (Telegram envía array de tamaños — usamos el más grande)
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    await handleMedia(env, chatId, photo.file_id, null, 'image/jpeg', usuario, msg.caption || null);
    return;
  }

  // Document (PDF u otra imagen)
  if (msg.document) {
    const doc = msg.document;
    const mime = doc.mime_type || 'application/octet-stream';
    if (mime.startsWith('image/') || mime === 'application/pdf') {
      await handleMedia(env, chatId, doc.file_id, doc.file_name, mime, usuario, msg.caption || null);
      return;
    }
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `❌ Tipo de archivo no soportado. Envía imagen (JPG/PNG) o PDF.`
    );
    return;
  }

  // Text: comando o gasto escrito en lenguaje natural
  if (msg.text) {
    if (msg.text.startsWith('/')) {
      await handleCommand(env, chatId, msg.text, fromName);
    } else {
      await handleTextoGasto(env, chatId, msg.text, usuario);
    }
    return;
  }
}

// ── Setup webhook (utility) ───────────────────────────────
export async function setupWebhook(env, webhookUrl, secretToken) {
  const token = env.TELEGRAM_BOT_TOKEN;
  return tgRequest(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true
  });
}

// ── Health check del webhook ──────────────────────────────
export async function checkWebhookHealth(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { healthy: false, reason: 'no_token' };

  try {
    const info = await tgRequest(token, 'getWebhookInfo', {});
    if (!info?.ok) return { healthy: false, reason: 'api_error', detail: info };

    const r = info.result || {};
    const expectedUrl = `${env.WORKER_URL || 'https://cocicp-gastos.ddropero.workers.dev'}/api/telegram/webhook`;

    // ¿La URL apunta a donde debe?
    if (r.url !== expectedUrl) {
      return { healthy: false, reason: 'wrong_url', current: r.url, expected: expectedUrl, info: r };
    }

    // ¿Hay errores recientes?
    if (r.last_error_date) {
      const errorAge = Date.now() / 1000 - r.last_error_date;
      // Errores hace menos de 1 hora son preocupantes
      if (errorAge < 3600) {
        return {
          healthy: false,
          reason: 'recent_error',
          last_error_message: r.last_error_message,
          last_error_date: new Date(r.last_error_date * 1000).toISOString(),
          info: r
        };
      }
    }

    // ¿Mensajes acumulados sin procesar?
    if ((r.pending_update_count || 0) > 50) {
      return {
        healthy: false,
        reason: 'too_many_pending',
        pending: r.pending_update_count,
        info: r
      };
    }

    return { healthy: true, info: r };
  } catch (err) {
    return { healthy: false, reason: 'exception', detail: err.message };
  }
}

// ── Auto-heal: re-registra webhook si se cayó ─────────────
export async function healWebhook(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const webhookUrl = `${env.WORKER_URL || 'https://cocicp-gastos.ddropero.workers.dev'}/api/telegram/webhook`;

  if (!token || !webhookSecret) {
    return { ok: false, error: 'missing_secrets' };
  }

  try {
    const result = await tgRequest(token, 'setWebhook', {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message'],
      drop_pending_updates: false  // No dropear: queremos procesar lo que se acumuló
    });
    return { ok: !!result?.ok, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
