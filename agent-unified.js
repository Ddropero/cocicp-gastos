// ============================================================
// Agente Unificado — Extracción fiscal + proveedor + clasificación
// UNA sola llamada a Claude = 1 imagen = ~66% menos tokens
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

const SYSTEM = `Eres un procesador de documentos fiscales colombianos para COCICP (NIT 901277565-7), una corporación sin ánimo de lucro de cirugía plástica.
Extrae TODO en UNA sola respuesta: valores fiscales, datos del proveedor, y clasificación.
Responde ÚNICAMENTE con JSON válido, sin markdown.`;

const PROMPT = `Analiza este documento fiscal colombiano y extrae todo:

{
  "fiscal": {
    "numero_documento": "prefijo + número tal como aparece",
    "tipo_documento": "factura | nota_credito | comprobante_pago | planilla | otro",
    "fecha_emision": "YYYY-MM-DD o null",
    "fecha_pago": "YYYY-MM-DD o null",
    "subtotal": 0, "iva": 0, "inc": 0, "otros_impuestos": 0, "descuentos": 0, "total": 0,
    "es_nota_credito": false,
    "medio_pago": "efectivo | tarjeta_credito | transferencia | pse | null",
    "referencia_pago": "CUS o ID transacción o null",
    "moneda": "COP"
  },
  "proveedor": {
    "nit": "con DV ej: 900123456-1",
    "nit_sin_dv": "solo dígitos",
    "razon_social": "nombre completo",
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
- Nota crédito: total NEGATIVO
- Si no puedes leer un campo: null
- Restaurantes fuera de Bogotá → Alimentación/Viáticos
- Combustible/gasolinera → Combustible
- Pagos tarjeta crédito personal → Pagos David Duque
- Deducibles: Alimentación, Combustible, Honorarios, Prestadores, Salud, Admin, Viáticos
- NO deducibles: Educación hijos, Personal, Vivienda, Pagos David Duque`;

export async function runUnifiedAgent(fileBase64, mimeType, apiKey, db) {
  const isDoc = mimeType === 'application/pdf';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: PROMPT }
        ]
      }]
    })
  });

  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { error: 'parse_failed', raw };
  }

  const f = parsed.fiscal || {};
  const p = parsed.proveedor || {};
  const c = parsed.clasificacion || {};

  // Enriquecer con catálogo
  const nitSinDv = p.nit_sin_dv || (p.nit || '').replace(/\D/g, '');
  let catalogo = nitSinDv ? (CATALOGO_RAPIDO[nitSinDv] || null) : null;

  // Fallback a D1 si no está en catálogo rápido
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
    valor_base: f.subtotal || 0,
    iva: f.iva || 0,
    inc: f.inc || 0,
    otros_impuestos: f.otros_impuestos || 0,
    descuentos: f.descuentos || 0,
    total: f.total || 0,
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
