// ============================================================
// finance-utils.js — utilidades puras y testables (sin dependencias de Worker)
// Parser monetario colombiano, escape CSV, validación de payload,
// helpers de fecha America/Bogota y saneo de importes de pago.
// ============================================================

// ── Categorías y estados permitidos (fuente central) ────────
export const CATEGORIAS_VALIDAS = [
  'Alimentación', 'Alimentación/Viáticos', 'Mercado/Aseo', 'Combustible',
  'Educación hijos', 'Honorarios Médicos', 'Prestadores de servicios',
  'Seguridad Social', 'Impuestos vehículos', 'Gastos Administrativos',
  'Transporte Aéreo', 'Alojamiento', 'Salud', 'Tecnología', 'Libros',
  'Personal', 'Misceláneos', 'Vivienda', 'Pagos David Duque', 'Parqueadero',
  'Mantenimiento', 'Seguro', 'Peajes', 'Viáticos conductor',
];
export const ESTADOS_VALIDOS = ['confirmado', 'revision', 'anulado'];
export const ENTIDADES_VALIDAS = ['cocicp', 'restituyo', 'personal'];
export const ROLES_VALIDOS = ['captura', 'revision', 'tesoreria', 'admin'];
export const FRECUENCIAS_VALIDAS = ['mensual', 'quincenal', 'bimestral', 'trimestral', 'semestral', 'anual'];

// ── Parser monetario colombiano robusto ─────────────────────
// Soporta: "1.234.567,89" (CO), "1,234,567.89" (US), "$ 1.234.567", "-1.234.567", números.
export function parseMoneyCO(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  let s = String(v).trim().replace(/[^\d.,\-]/g, '');
  if (!s) return 0;
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');
  let n;
  if (s.includes('.') && s.includes(',')) {
    // Ambos separadores: el ÚLTIMO en aparecer es el decimal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      n = parseFloat(s.replace(/\./g, '').replace(',', '.'));      // 1.234.567,89 → 1234567.89
    } else {
      n = parseFloat(s.replace(/,/g, ''));                          // 1,234,567.89 → 1234567.89
    }
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    n = parseInt(s.replace(/[.,]/g, ''), 10);                       // 1.234.567 / 1,234,567 → miles
  } else {
    n = parseFloat(s.replace(',', '.'));                           // 1234,56 → 1234.56
  }
  if (!Number.isFinite(n)) return 0;
  return neg ? -n : n;
}

// ── Escape CSV con protección anti fórmula-injection ────────
// Prefija ' a celdas que empiezan por = + - @ TAB CR (Excel/Sheets las ejecutan).
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

// ── Fecha America/Bogota (UTC-5 fijo, sin DST) ──────────────
export function ahoraBogota(now = Date.now()) {
  return new Date(now - 5 * 3600 * 1000);
}
export function fechaBogotaISO(now = Date.now()) {
  return ahoraBogota(now).toISOString().slice(0, 10);
}
export function anioActualBogota(now = Date.now()) {
  return ahoraBogota(now).getUTCFullYear();
}

// ── Validación de fechas YYYY-MM-DD ─────────────────────────
export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

// ── Validación central de payload de gasto ──────────────────
// Devuelve { ok:true, value } normalizado, o { ok:false, error }.
export function validateGastoPayload(body, { anio = anioActualBogota() } = {}) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Payload inválido' };
  const err = (m) => ({ ok: false, error: m });

  if (!isValidDateStr(body.fecha)) return err('Fecha inválida (use YYYY-MM-DD)');
  const y = parseInt(body.fecha.slice(0, 4), 10);
  if (y < anio - 3 || y > anio + 1) return err(`Año de la fecha fuera de rango (${body.fecha})`);

  const total = Number(body.total);
  if (!Number.isFinite(total)) return err('Total no es un número finito');

  if (body.categoria != null && !CATEGORIAS_VALIDAS.includes(body.categoria)) {
    return err(`Categoría no permitida: ${body.categoria}`);
  }
  const estado = body.estado || 'confirmado';
  if (!ESTADOS_VALIDOS.includes(estado)) return err(`Estado no permitido: ${estado}`);

  const entidad = body.entidad || 'cocicp';
  if (!ENTIDADES_VALIDAS.includes(entidad)) return err(`Entidad no permitida: ${entidad} (usa cocicp, restituyo o personal)`);

  const maxLen = (s, n) => typeof s === 'string' && s.length > n;
  if (maxLen(body.concepto, 300)) return err('Concepto excede 300 caracteres');
  if (maxLen(body.proveedor_nombre, 200)) return err('Proveedor excede 200 caracteres');
  if (maxLen(body.numero_documento, 60)) return err('Número de documento excede 60 caracteres');
  if (maxLen(body.notas, 1000)) return err('Notas exceden 1000 caracteres');

  return {
    ok: true,
    value: {
      fecha: body.fecha,
      proveedor_nit: body.proveedor_nit ? String(body.proveedor_nit).slice(0, 30) : null,
      proveedor_nombre: body.proveedor_nombre ? String(body.proveedor_nombre) : null,
      numero_documento: body.numero_documento ? String(body.numero_documento) : null,
      concepto: body.concepto ? String(body.concepto) : null,
      categoria: body.categoria || null,
      valor_base: Number(body.valor_base) || 0,
      iva: Number(body.iva) || 0,
      inc: Number(body.inc) || 0,
      otros_impuestos: Number(body.otros_impuestos) || 0,
      total,
      es_nota_credito: body.es_nota_credito ? 1 : 0,
      medio_pago: body.medio_pago ? String(body.medio_pago).slice(0, 60) : null,
      referencia_pago: body.referencia_pago ? String(body.referencia_pago).slice(0, 120) : null,
      archivo_r2: body.archivo_r2 ? String(body.archivo_r2).slice(0, 200) : null,
      estado,
      entidad,
      notas: body.notas ? String(body.notas) : null,
    },
  };
}

// ── Saneo de importe de PAGO (dispersión) ───────────────────
// Rechaza crédito/negativo/cero/NaN/infinito. Nunca aplica Math.abs.
export function sanitizePayAmount(raw) {
  const n = typeof raw === 'number' ? raw : parseMoneyCO(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: 'no_finito' };
  if (n <= 0) return { ok: false, reason: 'cero_o_negativo' };
  const entero = Math.round(n);
  if (entero <= 0) return { ok: false, reason: 'redondeo_no_positivo' };
  return { ok: true, value: entero };
}

// ── Cruce DIAN: emparejar una fila DIAN contra gastos (por doc, o NIT+fecha+total) ──
// Puro y testeable. gastos = filas ya filtradas por entidad.
export function matchDianFila(fila, gastos) {
  const nit9 = s => String(s || '').replace(/\D/g, '').slice(0, 9); // base sin DV
  const numDoc = String(fila.numero_documento || '').trim().toUpperCase();
  const nit = nit9(fila.nit_emisor);
  const fecha = fila.fecha || null;
  const total = Math.round(Math.abs(parseMoneyCO(fila.total)));
  // 1) documento exacto (+ proveedor si ambos tienen NIT)
  let m = numDoc ? gastos.find(g => String(g.numero_documento || '').trim().toUpperCase() === numDoc
    && (!nit || !g.proveedor_nit || nit9(g.proveedor_nit) === nit)) : null;
  // 2) NIT(9) + fecha + total
  if (!m && nit && fecha) {
    m = gastos.find(g => nit9(g.proveedor_nit) === nit && g.fecha === fecha
      && Math.round(Math.abs(g.total)) === total) || null;
  }
  return m || null;
}

// ── ID positivo ─────────────────────────────────────────────
export function isPositiveId(v) {
  return Number.isInteger(v) && v > 0;
}
