# Arquitectura — estado y plan de modularización

## Hecho (Fase 7)
- **Build Pages con allowlist**: `scripts/build-pages.mjs` → `dist-pages/` con SOLO assets públicos; `scripts/verify-pages.mjs` falla si se cuela `worker.js`, `auth.js`, `*.sql`, `*.md`, etc.
- **Scripts npm**: `test`, `check`, `lint`, `build:pages`, `verify:pages`, `deploy:*` (deploy corre test+check+build primero).
- **`.gitignore`** para `node_modules/`, `.wrangler/`, `.dev.vars*`, `.env*`, `dist*/`, `*.cpuprofile`.
- **`*-integration.txt` desfasados** movidos a `docs/legacy/` (no borrados).
- **Utilidades ya extraídas y testeadas**: `lib/finance-utils.js` (validación, dinero, CSV, fechas, categorías centralizadas), `lib/security.js` (CORS, firma Twilio, SSRF, uploads, roles, escapeHtml).

## Pendiente — split de `worker.js` y `index.html` (refactor grande)
Es un cambio arquitectónico amplio sobre archivos en producción; se difiere para hacerlo con verificación dedicada y no romper la app. Plan propuesto:

### worker.js → `src/`
Extraer el gran `fetch()` a routers por dominio, cada uno exportando `handle(request, env, ctx, deps)`:
- `src/routes/auth.js` (login, register, 2fa, logout, me)
- `src/routes/gastos.js` (upload, confirm, gastos, patch, soporte)
- `src/routes/conciliacion.js` (cruce-dian, cruce-banco, comparativo)
- `src/routes/obligaciones.js`, `src/routes/pagos.js` (pago-masivo), `src/routes/webhooks.js` (telegram, whatsapp)
- `worker.js` queda como dispatcher: arma `CORS`/`json`/`fail`, corre el middleware de auth y delega por prefijo de ruta.
Mantener firmas estables; migrar ruta por ruta con pruebas de integración (`@cloudflare/vitest-pool-workers`).

### index.html → assets separados
- `styles.css` (extraer el `<style>` inline) + `<link rel="stylesheet">`.
- `config.js` (WORKER_URL, categorías, colores) como fuente única.
- `app.js` como módulo; reemplazar los `onclick="fn()"` inline por `addEventListener` (requisito también para endurecer la CSP quitando `'unsafe-inline'`).
- Actualizar `scripts/build-pages.mjs` (allowlist) para incluir `styles.css`, `config.js`, `app.js`.

### Copias divergentes de captura (Fase 7.4)
Hoy existen `index.html`, `app.html` y `documentos-deploy/`. Unificar en una sola fuente parametrizable (modo dashboard / modo captura) y generar las variantes en build, en vez de mantener copias a mano.

## Riesgo si no se hace
Mantenibilidad: archivos de 2.5k–5.4k líneas dificultan revisión y aumentan el riesgo de regresiones. No es un riesgo de seguridad (ya cubierto en Fases 1–4), sino de evolución.
