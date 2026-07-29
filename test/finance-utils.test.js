import { describe, it, expect } from 'vitest';
import {
  parseMoneyCO, csvCell, toCsv, sanitizePayAmount,
  validateGastoPayload, isValidDateStr, isPositiveId,
} from '../lib/finance-utils.js';

describe('parseMoneyCO — parser monetario colombiano', () => {
  it('formato colombiano 1.234.567,89', () => expect(parseMoneyCO('1.234.567,89')).toBeCloseTo(1234567.89));
  it('formato US 1,234,567.89', () => expect(parseMoneyCO('1,234,567.89')).toBeCloseTo(1234567.89));
  it('con símbolo $ 1.234.567', () => expect(parseMoneyCO('$ 1.234.567')).toBe(1234567));
  it('miles CO sin decimales', () => expect(parseMoneyCO('1.234.567')).toBe(1234567));
  it('negativo con miles (nota crédito)', () => expect(parseMoneyCO('-1.234.567')).toBe(-1234567));
  it('decimal simple con coma', () => expect(parseMoneyCO('1234,56')).toBeCloseTo(1234.56));
  it('número directo', () => expect(parseMoneyCO(450184)).toBe(450184));
  it('vacío → 0', () => expect(parseMoneyCO('')).toBe(0));
  it('basura → 0', () => expect(parseMoneyCO('N/A')).toBe(0));
});

describe('csvCell — anti fórmula-injection', () => {
  it("prefija ' a =CMD", () => expect(csvCell('=1+1')).toBe("'=1+1"));
  it("prefija ' a +area", () => expect(csvCell('+A1')).toBe("'+A1"));
  it("prefija ' a @import", () => expect(csvCell('@SUM(A)')).toBe("'@SUM(A)"));
  it("prefija ' a -2", () => expect(csvCell('-2')).toBe("'-2"));
  it('escapa comillas y comas', () => expect(csvCell('a,"b"')).toBe('"a,""b"""'));
  it('texto normal intacto', () => expect(csvCell('EDS El Bosque')).toBe('EDS El Bosque'));
  it('toCsv une filas con CRLF', () => expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d'));
});

describe('sanitizePayAmount — rechaza crédito/cero/negativo', () => {
  it('positivo válido', () => expect(sanitizePayAmount(450000)).toEqual({ ok: true, value: 450000 }));
  it('cero rechazado', () => expect(sanitizePayAmount(0).ok).toBe(false));
  it('negativo (crédito) rechazado', () => expect(sanitizePayAmount(-100).ok).toBe(false));
  it('NaN rechazado', () => expect(sanitizePayAmount(NaN).ok).toBe(false));
  it('Infinity rechazado', () => expect(sanitizePayAmount(Infinity).ok).toBe(false));
  it('string CO parseado', () => expect(sanitizePayAmount('1.234.567')).toEqual({ ok: true, value: 1234567 }));
  it('nunca aplica abs a negativo', () => expect(sanitizePayAmount(-500000).ok).toBe(false));
});

describe('validateGastoPayload', () => {
  const base = { fecha: '2026-07-05', total: 100000, categoria: 'Combustible' };
  it('acepta payload válido', () => expect(validateGastoPayload(base, { anio: 2026 }).ok).toBe(true));
  it('rechaza fecha inválida', () => expect(validateGastoPayload({ ...base, fecha: '05/07/2026' }, { anio: 2026 }).ok).toBe(false));
  it('rechaza total no finito', () => expect(validateGastoPayload({ ...base, total: Infinity }, { anio: 2026 }).ok).toBe(false));
  it('rechaza categoría inválida', () => expect(validateGastoPayload({ ...base, categoria: 'Hacking' }, { anio: 2026 }).ok).toBe(false));
  it('rechaza estado inválido', () => expect(validateGastoPayload({ ...base, estado: 'x' }, { anio: 2026 }).ok).toBe(false));
  it('rechaza año fuera de rango', () => expect(validateGastoPayload({ ...base, fecha: '2010-01-01' }, { anio: 2026 }).ok).toBe(false));
  it('normaliza opcionales a null', () => {
    const r = validateGastoPayload(base, { anio: 2026 });
    expect(r.value.proveedor_nit).toBeNull();
  });
});

describe('isValidDateStr / isPositiveId', () => {
  it('fecha válida', () => expect(isValidDateStr('2026-07-05')).toBe(true));
  it('fecha imposible 2026-13-40', () => expect(isValidDateStr('2026-13-40')).toBe(false));
  it('id positivo', () => expect(isPositiveId(5)).toBe(true));
  it('id cero/neg/float', () => {
    expect(isPositiveId(0)).toBe(false);
    expect(isPositiveId(-1)).toBe(false);
    expect(isPositiveId(1.5)).toBe(false);
  });
});
