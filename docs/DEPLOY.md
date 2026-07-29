# Runbook de despliegue — COCICP Gastos (multi-entidad + hardening)

> Ejecuta cada paso TÚ. Este documento NO despliega nada.
> Recursos: Worker `cocicp-gastos` · D1 `cocicp-gastos` · R2 `cocicp-soportes` · Pages `cocicp-gastos-ui`.
> Todo desde la carpeta del proyecto: `cd "C:/Users/dfduq/OneDrive/Documents/gastos cocicp"`

---

## 0) Pre-vuelo (local, no despliega) — DEBE pasar antes de todo
```bash
npm ci        # o npm install
npm run preflight
```
Espera: `91 passed`, `0 errores`, `verify:pages OK`, `Total Upload …`, sin errores.

Confirma que estás en la cuenta correcta de Cloudflare (solo lectura):
```bash
npx wrangler whoami
```
Si no hay sesión: `npx wrangler login`.

---

## 1) Secrets del Worker (una sola vez; NO van en wrangler.toml)

Genera valores fuertes para los nuevos (guárdalos en tu gestor de contraseñas):
```bash
# Genera tokens aleatorios (elige uno):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# o:  openssl rand -hex 32
```

Sube los NUEVOS secrets (te pedirá pegar el valor):
```bash
npx wrangler secret put ADMIN_SETUP_TOKEN        # habilita /api/auth/register
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # webhook Telegram (fail-closed)
npx wrangler secret put TWILIO_AUTH_TOKEN        # firma WhatsApp — ROTA el actual antes (fue expuesto)
```

Verifica que los EXISTENTES siguen puestos:
```bash
npx wrangler secret list
```
Deben estar además: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_AUTHORIZED_CHATS`, `TWILIO_ACCOUNT_SID`, `TWILIO_WHATSAPP_FROM`.
(Si `TWILIO_ACCOUNT_SID`/`TWILIO_WHATSAPP_FROM` los tienes como [vars], está bien.)

> Nota CORS: si el dashboard o la app de captura viven en otro subdominio además de
> `https://cocicp.davidduque.com`, define `CORS_ORIGINS` en `wrangler.toml` [vars]
> (coma-separado) ANTES del deploy del worker.

---

## 2) Base de datos D1 — aplicar SOLO la migración 0005

**2a. Backup primero (imprescindible):**
```bash
npx wrangler d1 export cocicp-gastos --remote --output=backup-pre-0005.sql
```

**2b. Aplicar la migración nueva (agrega entidad, deducible, op_id, auditoría; NO destructiva):**
```bash
npx wrangler d1 execute cocicp-gastos --remote --file=migrations/0005_hardening.sql
```
> ⚠️ La base EXISTENTE ya tiene las tablas de 0001–0004; por eso se aplica **solo la 0005**.
> Backfill automático: los gastos previos quedan `entidad='cocicp'`, `deducible_cocicp=1`.

**2c. Verificar:**
```bash
npx wrangler d1 execute cocicp-gastos --remote --command "SELECT COUNT(*) n, SUM(entidad='cocicp') cocicp FROM gastos;"
```

---

## 3) Deploy del Worker
```bash
npm run deploy:worker      # corre test + check y luego: wrangler deploy
```
Si tienes vars puestas desde el panel de Cloudflare que NO están en wrangler.toml,
usa en su lugar:  `npm run test && npm run check && npx wrangler deploy --keep-vars`

---

## 4) Deploy del frontend (Pages) con allowlist
```bash
npm run deploy:pages       # test+check+build:pages+verify:pages + wrangler pages deploy dist-pages
```
Verifica el nombre del proyecto Pages si falla:
```bash
npx wrangler pages project list
```
(el script usa `--project-name=cocicp-gastos-ui`; ajústalo si el tuyo difiere).

---

## 5) Re-registrar el webhook de Telegram con el secret nuevo
Tras el deploy, con una sesión admin (token de login) o el ADMIN_SETUP_TOKEN según tu setup:
```bash
curl -X POST https://cocicp-gastos.ddropero.workers.dev/api/telegram/setup \
  -H "Authorization: Bearer <TU_SESSION_TOKEN_ADMIN>"
```
El cron diario (7am Bogotá) también auto-sana el webhook. Verifica:
```bash
curl https://cocicp-gastos.ddropero.workers.dev/api/telegram/health
```

---

## 6) WhatsApp / Twilio (si lo usas)
1. **Rota** el Auth Token en el panel de Twilio y actualízalo (paso 1).
2. En la consola de Twilio, apunta el webhook de WhatsApp a:
   `https://cocicp-gastos.ddropero.workers.dev/api/whatsapp/webhook`
   (el worker valida la firma `X-Twilio-Signature`; con token equivocado responde 403).

---

## 7) Crear el primer usuario admin (register ahora exige token)
```bash
curl -X POST https://cocicp-gastos.ddropero.workers.dev/api/auth/register \
  -H "Content-Type: application/json" \
  -H "x-admin-token: <ADMIN_SETUP_TOKEN>" \
  -d '{"email":"david@davidduque.com","password":"<min-12-caracteres>","nombre":"David","rol":"admin"}'
```
Roles válidos: `captura` | `revision` | `tesoreria` | `admin`.

---

## 8) Smoke tests post-deploy (manual, en el navegador/app)
- [ ] Login en cocicp.davidduque.com → pide **2FA** (setup con QR local o código manual) → entra.
- [ ] Sube una **foto** de factura por el dashboard → se guarda con soporte.
- [ ] Abre el **📎 soporte** de un gasto (carga autenticada por id).
- [ ] Cambia el **selector de entidad** (COCICP/Restituyo/Personal) → la lista filtra.
- [ ] En Telegram escribe `café 8 mil personal` → responde `#N guardado 👤 Personal`.
- [ ] En Telegram manda una foto con caption `... restituyo` → queda en Restituyo.
- [ ] Genera **1** dispersión de pago de prueba → verifica que excluye créditos/ceros.
- [ ] Descarga el **PDF** fiscal → ábrelo (offsets byte-exactos, multipágina).

---

## Rollback
- **Worker**: `npx wrangler rollback` (o `wrangler deployments list` → `rollback <id>`).
- **Pages**: en el panel, "Rollback to this deployment" sobre el despliegue anterior.
- **D1**: restaurar desde `backup-pre-0005.sql` (0005 es aditiva; normalmente no hace falta).

## Orden resumido
0 preflight → 1 secrets → 2 backup+migración 0005 → 3 worker → 4 pages → 5 telegram → 6 twilio → 7 admin → 8 smoke.
