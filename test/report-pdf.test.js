import { describe, it, expect } from 'vitest';
import { generateReport } from '../report-pdf.js';

// Datos con acentos/ñ y montos, para probar transliteración + estructura
function regsAcentos(n) {
  const cats = ['Combustible', 'Personal', 'Salud', 'Vivienda', 'Tecnología', 'Educación hijos', 'Misceláneos', 'Alimentación'];
  const out = [];
  for (let i = 0; i < n; i++) out.push({ categoria: cats[i % cats.length], total: 1000 * (i + 1), iva: 190 * (i + 1), inc: 0, proveedor_nombre: 'Ñoño áéíóú SAS ' + i });
  return out;
}
// Muchas categorías distintas → fuerza multipágina
function regsMultiCat(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ categoria: 'Categoria ' + i, total: 1000 * (i + 1), iva: 0, inc: 0 });
  return out;
}

// Parser INDEPENDIENTE: valida que cada offset del xref apunte a "N 0 obj" (byte-exacto)
function validarPdf(bytes) {
  expect(bytes).toBeInstanceOf(Uint8Array);
  const s = Buffer.from(bytes).toString('latin1'); // latin1 = 1 byte/char → índices == offsets
  expect(s.startsWith('%PDF-1.4')).toBe(true);
  expect(s.trimEnd().endsWith('%%EOF')).toBe(true);

  const m = s.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  expect(m, 'debe tener startxref…%%EOF').toBeTruthy();
  const xrefOff = parseInt(m[1], 10);
  expect(s.slice(xrefOff, xrefOff + 4), 'startxref apunta a "xref"').toBe('xref');

  const after = s.slice(xrefOff);
  const header = after.match(/^xref\s+0\s+(\d+)\s/);
  expect(header).toBeTruthy();
  const count = parseInt(header[1], 10);
  const entries = [...after.matchAll(/(\d{10}) (\d{5}) (n|f) /g)].slice(0, count);
  expect(entries.length).toBe(count);

  let objNum = 0, nCount = 0;
  for (const e of entries) {
    const off = parseInt(e[1], 10), type = e[3];
    if (type === 'n') {
      const expected = `${objNum} 0 obj`;
      expect(s.slice(off, off + expected.length), `offset del obj ${objNum} debe apuntar a "${expected}"`).toBe(expected);
      nCount++;
    }
    objNum++;
  }
  expect(nCount).toBe(count - 1); // todos menos el obj 0 (libre)
  return s;
}

describe('generateReport — PDF byte-accurate', () => {
  it('xref byte-exacto con datos acentuados (200 registros)', () => {
    validarPdf(generateReport(regsAcentos(200), '2026-01-01', '2026-12-31'));
  });

  it('multipágina real: /Count >= 2 con 40 categorías', () => {
    const s = validarPdf(generateReport(regsMultiCat(40), null, null));
    const cnt = s.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/);
    expect(cnt).toBeTruthy();
    expect(parseInt(cnt[1], 10)).toBeGreaterThanOrEqual(2);
  });

  it('lista vacía no rompe (1 página)', () => {
    const s = validarPdf(generateReport([], '2026-01-01', '2026-12-31'));
    expect(s).toContain('/Count 1');
  });

  it('etiqueta de entidad aparece en el encabezado', () => {
    const s = validarPdf(generateReport(regsAcentos(3), '2026-07-01', '2026-07-31', { entidad: 'Restituyo SAS' }));
    expect(s).toContain('Restituyo SAS');
    expect(s).toContain('Entidad: Restituyo SAS');
  });

  it('transliteración: no deja bytes no-ASCII en el stream de texto', () => {
    const bytes = generateReport(regsAcentos(5), null, null);
    // ningún byte > 0x7E salvo el comentario binario de la cabecera (posición 10-13)
    let raros = 0;
    for (let i = 14; i < bytes.length; i++) if (bytes[i] > 0x7e) raros++;
    expect(raros).toBe(0);
  });
});
