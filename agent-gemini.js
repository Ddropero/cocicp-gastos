// ============================================================
// Agente Gemini 2.5 Flash — alternativa barata para OCR
// Mismo contrato que agent-unified.js (Sonnet 4.6)
// ============================================================

const CATALOGO_RAPIDO = {
  '901423905': { nombre_corto: 'Liceo Francés', categoria_default: 'Educación hijos' },
  '900276962': { nombre_corto: 'D1', categoria_default: 'Mercado/Aseo' },
  '890900608': { nombre_corto: 'Carulla/Éxito', categoria_default: 'Mercado/Aseo' },
  '900720191': { nombre_corto: 'JENAGRO', categoria_default: 'Alimentación' },
  '900078103': { nombre_corto: 'DH Galerías', categoria_default: 'Combustible' },
  '900568774': { nombre_corto: 'K-Saval', categoria_default: 'Combustible' },
  '811009788': { nombre_corto: 'Distracom', categoria_default: 'Combustible' },
  '902029628': { nombre_corto: 'Laura Anaya', categoria_default: 'Honorarios Médicos' },
  '830019189': { nombre_corto: 'LATAM', categoria_default: 'Transporte Aéreo' },
  '830009217': { nombre_corto: 'Ballet Pavlova', categoria_default: 'Educación hijos' },
  '901023168': { nombre_corto: 'Bus escolar', categoria_default: 'Educación hijos' },
  '800155413': { nombre_corto: 'Acción Fiduciaria', categoria_default: 'Vivienda' },
  '890905211': { nombre_corto: 'Gob. Antioquia', categoria_default: 'Impuestos vehículos' },
  '890399010': { nombre_corto: 'Gob. Valle', categoria_default: 'Impuestos vehículos' },
  '860007322': { nombre_corto: 'CCB', categoria_default: 'Gastos Administrativos' },
  '9998600669427': { nombre_corto: 'miplanilla', categoria_default: 'Seguridad Social' },
  '860530559': { nombre_corto: 'Tequendama', categoria_default: 'Parqueadero' },
  '901555354': { nombre_corto: 'Ardea Restaurante', categoria_default: 'Alimentación' },
  '860076919': { nombre_corto: 'Crepes y Waffles', categoria_default: 'Alimentación' },
  '900451555': { nombre_corto: 'Rappi', categoria_default: 'Pagos David Duque' },
  '890300279': { nombre_corto: 'Banco Occidente', categoria_default: 'Pagos David Duque' },
};

const PROMPT = `Eres un procesador de documentos fiscales colombianos para COCICP (NIT 901277565-7), una corporación sin ánimo de lucro de cirugía plástica.

Analiza este documento y extrae TODO en una sola respuesta JSON con este schema EXACTO:

{
  "fiscal": {
    "numero_documento": "prefijo + número tal como aparece o null",
    "tipo_documento": "factura | nota_credito | comprobante_pago | planilla | otro",
    "fecha_emision": "YYYY-MM-DD o null",
    "fecha_pago": "YYYY-MM-DD o null",
    "subtotal": 0,
    "iva": 0,
    "inc": 0,
    "otros_impuestos": 0,
    "descuentos": 0,
    "total": 0,
    "es_nota_credito": false,
    "medio_pago": "efectivo | tarjeta_credito | transferencia | pse | null",
    "referencia_pago": "CUS o ID transacción o null",
    "moneda": "COP"
  },
  "proveedor": {
    "nit": "con DV ej: 900123456-1 o null",
    "nit_sin_dv": "solo dígitos sin DV o null",
    "razon_social": "nombre completo o null",
    "nombre_comercial": "o null",
    "municipio": "o null"
  },
  "clasificacion": {
    "categoria": "una de: Alimentación | Alimentación/Viáticos | Mercado/Aseo | Combustible | Educación hijos | Honorarios Médicos | Prestadores de servicios | Seguridad Social | Impuestos vehículos | Gastos Administrativos | Transporte Aéreo | Alojamiento | Salud | Tecnología | Libros | Personal | Misceláneos | Vivienda | Pagos David Duque | Parqueadero",
    "concepto": "máx 80 chars ej: Gasolina 17.5 gal - DH Galerías Bogotá",
    "deducible_cocicp": true,
    "es_viatico": false,
    "municipio_gasto": "o null"
  },
  "confianza": "alta | media | baja"
}

REGLAS:
- TODOS los montos deben ser NUMEROS (no strings), sin separadores: 1234567 no "1.234.567"
- Nota crédito: total NEGATIVO
- Si no puedes leer un campo: usa null o 0
- Restaurantes fuera de Bogotá → "Alimentación/Viáticos"
- Combustible/gasolinera → "Combustible"
- Pagos tarjeta crédito personal → "Pagos David Duque"
- Deducibles: Alimentación, Combustible, Honorarios, Prestadores, Salud, Admin, Viáticos
- NO deducibles: Educación hijos, Personal, Vivienda, Pagos David Duque
- Si la imagen está borrosa, mal iluminada, o no puedes leer datos clave: confianza = "baja"
- Responde SOLO JSON puro, sin markdown, sin texto adicional`;

// ── Coerce: a veces Gemini devuelve montos como "1.234.567" o "1,234,567" ──
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[^\d.,\-]/g, '');
  // Si tiene punto Y coma, asumir formato es-CO (1.234.567,89): . miles, , decimal
  if (s.includes('.') && s.includes(',')) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  }
  // Si tiene solo puntos y son separadores de miles (ej: 1.234.567)
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    return parseInt(s.replace(/\./g, ''), 10) || 0;
  }
  return parseFloat(s) || 0;
}

export async function runGeminiAgent(fileBase64, mimeType, apiKey, db) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: fileBase64 } },
        { text: PROMPT }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 1024,
      // Desactivar thinking para bajar costo (no aporta nada en extracción JSON estructurada)
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  // Reintentar ante rate limit 429: hasta 2 retries con espera incremental (1.5s, 3s)
  const RETRY_DELAYS = [1500, 3000];
  let res;
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      return { error: 'gemini_network_failed: ' + err.message };
    }

    if ((res.status === 429 || res.status === 503 || res.status === 500) && intento < RETRY_DELAYS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[intento]));
      continue;
    }
    break;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `gemini_http_${res.status}`, raw: errText.slice(0, 500) };
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

  let parsed;
  try {
    // Gemini con responseMimeType=application/json a veces aún devuelve markdown
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { error: 'gemini_parse_failed', raw: raw.slice(0, 500) };
  }

  const f = parsed.fiscal || {};
  const p = parsed.proveedor || {};
  const c = parsed.clasificacion || {};

  // Enriquecer con catálogo
  const nitSinDv = p.nit_sin_dv || (p.nit || '').replace(/\D/g, '');
  let catalogo = nitSinDv ? (CATALOGO_RAPIDO[nitSinDv] || null) : null;

  if (!catalogo && nitSinDv && db) {
    try {
      const row = await db.prepare(
        'SELECT nombre_corto, categoria_default FROM proveedores WHERE nit LIKE ?'
      ).bind(`${nitSinDv}%`).first();
      if (row) catalogo = row;
    } catch {}
  }

  const nombreProveedor = catalogo?.nombre_corto || p.nombre_comercial || p.razon_social || 'Proveedor desconocido';
  const categoria = c.categoria || catalogo?.categoria_default || 'Misceláneos';
  const confianza = parsed.confianza || 'media';

  return {
    proveedor_nit: p.nit || null,
    proveedor_nit_sin_dv: nitSinDv || null,
    proveedor_nombre: nombreProveedor,
    proveedor_razon_social: p.razon_social || null,
    en_catalogo: !!catalogo,
    numero_documento: f.numero_documento || null,
    tipo_documento: f.tipo_documento || 'otro',
    fecha: f.fecha_pago || f.fecha_emision || null,
    fecha_emision: f.fecha_emision || null,
    categoria,
    concepto: c.concepto || 'Sin concepto',
    deducible_cocicp: c.deducible_cocicp ?? true,
    es_viatico: c.es_viatico || false,
    municipio_gasto: c.municipio_gasto || null,
    valor_base: toNum(f.subtotal),
    iva: toNum(f.iva),
    inc: toNum(f.inc),
    otros_impuestos: toNum(f.otros_impuestos),
    descuentos: toNum(f.descuentos),
    total: toNum(f.total),
    es_nota_credito: f.es_nota_credito || false,
    moneda: f.moneda || 'COP',
    medio_pago: f.medio_pago || null,
    referencia_pago: f.referencia_pago || null,
    confianza_global: confianza,
    estado: confianza === 'baja' ? 'revision' : 'confirmado',
    errores_parciales: null,
    notas: null,
  };
}
