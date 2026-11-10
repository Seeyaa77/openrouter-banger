# OpenRouter Banger

Automated OpenRouter account creator that registers accounts with disposable
emails, verifies them, creates an API key, and adds the key to **9router**
through 9router's own REST API.

```
npm start        # interactive: asks how many accounts + headless or not
```

---

## Requirements

- Node.js 18+ (tested on Node 26)
- Google Chrome for Puppeteer (auto-downloaded, or point to one with `PUPPETEER_EXECUTABLE_PATH`)
- 9router running locally (default `http://localhost:20128`)
- Access to a [tempik](https://tempik.neroism.web.id) disposable-mail domain

---

## Install

```bash
npm install
cp .env.example .env     # then edit .env
```

---

## Usage

```bash
npm start                # prompts for account count + headless mode
node src/index.js 15 --headless
node src/index.js 3 --headed
```

Each account goes through:

1. Generate a temp email on the configured domain
2. Fill OpenRouter's sign-up form
3. Wait for / pass the `/sign-up/protect-check` bot check (Stripe hCaptcha + HumanSecurity; resolves automatically in a real-looking browser)
4. Fetch the verification link from the tempik API and complete Clerk verification
5. Finish onboarding and create an API key (intercepted from the
   `workspace-api-keys` response)
6. `POST /api/providers/validate` then `POST /api/providers` on 9router
7. Print a summary with email / key / 9router connection id

---

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `TEMP_EMAIL_DOMAIN` | `xyntaur.com` | Domain used for temp addresses |
| `TEMP_EMAIL_BASE_URL` | `https://tempik.neroism.web.id` | tempik API base URL |
| `OPENROUTER_SIGNUP_URL` | `https://openrouter.ai/sign-up` | Sign-up page |
| `OPENROUTER_KEYS_URL` | `https://openrouter.ai/workspaces/default/keys` | Keys page |
| `HEADLESS` | `false` | Default headless flag |
| `BROWSER_TIMEOUT` | `60000` | Navigation timeout (ms) |
| `DELAY_BETWEEN_ACCOUNTS` | `5000` | Pause between accounts (ms) |
| `PUPPETEER_EXECUTABLE_PATH` | bundled Chrome | Path to a Chrome binary |
| `NINEROUTER_BASE_URL` | `http://localhost:20128` | 9router base URL |
| `NINEROUTER_AUTH_TOKEN` | _(empty)_ | Optional `auth_token` cookie value |
| `NINEROUTER_PASSWORD` | _(empty)_ | Optional dashboard password (used to refresh the token) |
| `NINEROUTER_DATA_DIR` | `%APPDATA%/9router` | Where 9router stores `jwt-secret` |

### 9router authentication

The client resolves auth in this order:

1. `NINEROUTER_AUTH_TOKEN` if set
2. `POST /api/auth/login` with `NINEROUTER_PASSWORD`
3. **Auto-mint** a JWT by signing `{ authenticated: true, iat, exp }` with the
   local install's HS256 secret (`%APPDATA%/9router/jwt-secret`)

Option 3 is the default (leave both vars empty) and never expires, so you do not
need to copy cookies from the browser.

---

## Project layout

```
src/
  index.js        CLI entrypoint (prompts, loop, summary)
  automation.js   Puppeteer flow: signup -> verify -> onboarding -> API key
  nineapi.js      9router REST client + auth (token / login / JWT mint)
.env.example      Config template
```

The tool talks to 9router over HTTP only. It does **not** write to any SQLite
file, so changes show up immediately in the dashboard at
`http://localhost:20128/dashboard/providers/openrouter`.

---

## How it works (key details)

- **Verification link**: emails encode `&` as the literal `&amp;`, so the link
  is unescaped with `replace(/&amp;/g, '&')` before opening Clerk.
- **API key**: intercepted from the network response of
  `POST /api/frontend/v1/private/workspace-api-keys`; onboarding also creates a
  default key, which is reused when interception already produced one.
- **Bot check**: `puppeteer-extra-plugin-stealth` plus a 120 s wait handles the
  `protect-check` interstitial without solving a captcha manually.
- **Fresh context per account**: cookies, cache, `localStorage` and
  `sessionStorage` are cleared between accounts.
- **Connection name**: random (`or-xxxxxxxx`) with `priority: 1`,
  `proxyPoolId: null`, `testStatus: "active"`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Registration did not reach verify page` | Increase wait / try `--headed`; the protect-check may need more time |
| `Verification email not received` | tempik delivery can lag up to ~4 min; the poll window is 4 min |
| `9router create failed (HTTP 401)` | Check `NINEROUTER_BASE_URL` and that 9router is running |
| `Waiting for selector input[name="firstName"] failed` | Page changed or blocked; re-run or run headed |

> Only use this on accounts you are allowed to create. Respect OpenRouter's
> Terms of Service.
