// ============================================================
// chat-gasto.js — parser de gastos escritos en texto libre (chat)
// "gasto en gasolina 100000 por persona natural" → gasto estructurado
// Puro y testeable: sin dependencias de Worker/Telegram.
// ============================================================

import { parseMoneyCO, fechaBogotaISO } from './finance-utils.js';

export const ENTIDADES_VALIDAS = ['cocicp', 'restituyo', 'personal'];

// Normaliza para matching: minúsculas y sin tildes (\b de JS no funciona tras acentos)
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Patrones SIN tildes (se aplican sobre texto normalizado)
const ENTIDAD_PATTERNS = [
  { entidad: 'personal',  re: /\b(persona\s+natural|personal|natural|mio|david)\b/ },
  { entidad: 'restituyo', re: /\brestituy?o\b/ },
  { entidad: 'cocicp',    re: /\b(cocicp|corporacion|corp)\b/ },
];

// Keywords → categorías VÁLIDAS de la tabla categorias de COCICP (FK estricta).
// Los nombres de categoría conservan tildes (son el valor FK); los patrones no.
const CATEGORIA_KEYWORDS = [
  { cat: 'Combustible',              re: /\b(gasolina|acpm|diesel|tanqueo|tanqueada|combustible|gas)\b/ },
  { cat: 'Mercado/Aseo',             re: /\b(mercado|aseo|d1|exito|carulla|ara|supermercado|jabon|detergente)\b/ },
  { cat: 'Alimentación',             re: /\b(almuerzo|desayuno|cena|comida|restaurante|cafe|domicilio|rappi)\b/ },
  { cat: 'Alimentación/Viáticos',    re: /\b(viaticos?)\b/ },
  { cat: 'Parqueadero',              re: /\b(parqueadero|parqueo|estacionamiento)\b/ },
  { cat: 'Transporte Aéreo',         re: /\b(vuelo|tiquete|avianca|latam|aereo)\b/ },
  { cat: 'Alojamiento',              re: /\b(hotel|alojamiento|hospedaje|airbnb)\b/ },
  { cat: 'Salud',                    re: /\b(salud|farmacia|drogueria|medicina|medico|eps|prepagada)\b/ },
  { cat: 'Tecnología',               re: /\b(tecnologia|computador|impresora|software|licencia|dominio|hosting|apple|celular)\b/ },
  { cat: 'Libros',                   re: /\b(libros?|libreria)\b/ },
  { cat: 'Vivienda',                 re: /\b(vivienda|arriendo|administracion|internet|luz|agua|energia|servicios publicos)\b/ },
  { cat: 'Educación hijos',          re: /\b(colegio|pension|liceo|ballet|bus escolar|matricula)\b/ },
  { cat: 'Honorarios Médicos',       re: /\b(honorarios?)\b/ },
  { cat: 'Seguridad Social',         re: /\b(seguridad social|planilla|pila|arl)\b/ },
  { cat: 'Impuestos vehículos',      re: /\b(impuesto|soat|tecnomecanica)\b/ },
  { cat: 'Gastos Administrativos',   re: /\b(papeleria|notaria|camara de comercio|administrativo|bancario|4x1000|comision)\b/ },
  { cat: 'Prestadores de servicios', re: /\b(servicios?|contratista|plomero|electricista|mantenimiento)\b/ },
];

// ── Detectar solo la entidad en un texto (ej. caption de una foto) ──
export function detectarEntidad(texto) {
  const tn = norm(texto);
  for (const p of ENTIDAD_PATTERNS) if (p.re.test(tn)) return p.entidad;
  return null;
}

// ── Extraer monto: números con miles CO/US, $, sufijo k / "mil" ──
function extraerMonto(texto) {
  const candidatos = [];
  // 100k / 100 k
  for (const m of texto.matchAll(/(\d+(?:[.,]\d+)?)\s*k\b/gi)) {
    candidatos.push({ valor: parseMoneyCO(m[1]) * 1000, raw: m[0] });
  }
  // "100 mil" / "100mil"
  for (const m of texto.matchAll(/(\d+(?:[.,]\d+)?)\s*mil\b/gi)) {
    candidatos.push({ valor: parseMoneyCO(m[1]) * 1000, raw: m[0] });
  }
  // números planos o con separadores ($ opcional)
  for (const m of texto.matchAll(/\$?\s*(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g)) {
    const v = parseMoneyCO(m[1]);
    candidatos.push({ valor: v, raw: m[0] });
  }
  if (!candidatos.length) return null;
  // El monto del gasto es el candidato de mayor valor (descarta cantidades tipo "2 almuerzos")
  candidatos.sort((a, b) => b.valor - a.valor);
  const top = candidatos[0];
  return top.valor >= 100 ? top : null; // menos de $100 no es un gasto plausible
}

// ── Parser principal ─────────────────────────────────────────
// Devuelve:
//   { ok:true, gasto:{ entidad,total,categoria,concepto,fecha } }
//   { ok:false, motivo:'sin_monto'|'sin_entidad', error, parcial? }
export function parseGastoTexto(texto, { hoy = null, defaultEntidad = null } = {}) {
  const t = String(texto || '').trim();
  if (!t || t.length > 300) return { ok: false, motivo: 'sin_monto', error: 'Texto vacío o demasiado largo' };

  const monto = extraerMonto(t);
  if (!monto) return { ok: false, motivo: 'sin_monto', error: 'No encontré un monto válido en el mensaje' };

  const tn = norm(t); // texto normalizado (sin tildes, minúsculas) para matching

  // Entidad
  let entidad = null;
  for (const p of ENTIDAD_PATTERNS) {
    if (p.re.test(tn)) { entidad = p.entidad; break; }
  }
  if (!entidad && defaultEntidad && ENTIDADES_VALIDAS.includes(defaultEntidad)) entidad = defaultEntidad;

  // Categoría por keywords
  let categoria = 'Misceláneos';
  for (const k of CATEGORIA_KEYWORDS) {
    if (k.re.test(tn)) { categoria = k.cat; break; }
  }

  // Fecha: hoy Bogotá, o "ayer"
  let fecha = hoy || fechaBogotaISO();
  if (/\bayer\b/i.test(t)) {
    const d = new Date(fecha + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    fecha = d.toISOString().slice(0, 10);
  }

  // Concepto: texto sin prefijo "gasto en/de", sin el monto, sin la mención de entidad ni conectores
  const ENT_WORDS = 'persona\\s+natural|personal|natural|restituy?o|cocicp|corporaci[oó]n|corp|m[ií]o|david';
  let concepto = t
    .replace(/^gasto\s+(en\s+|de\s+)?/i, '')
    .replace(monto.raw, ' ')
    .replace(new RegExp('\\b(por|para|de)\\s+(la\\s+)?(' + ENT_WORDS + ')(?=\\s|$|[^a-zA-Z])', 'gi'), ' ')
    .replace(new RegExp('(^|\\s)(' + ENT_WORDS + ')(?=\\s|$|[^a-zA-Z])', 'gi'), ' ')
    .replace(/\$\s*/g, ' ')
    .replace(/\bayer\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!concepto) concepto = categoria;
  concepto = concepto.charAt(0).toUpperCase() + concepto.slice(1);
  if (concepto.length > 80) concepto = concepto.slice(0, 77) + '...';

  if (!entidad) {
    return {
      ok: false, motivo: 'sin_entidad',
      error: 'Falta la entidad. Termina el mensaje con: cocicp, restituyo o personal',
      parcial: { total: Math.round(monto.valor), categoria, concepto, fecha },
    };
  }

  return {
    ok: true,
    gasto: {
      entidad,
      total: Math.round(monto.valor),
      categoria,
      concepto,
      fecha,
    },
  };
}
