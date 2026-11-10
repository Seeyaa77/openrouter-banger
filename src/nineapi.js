import axios from 'axios';
import chalk from 'chalk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 9router REST API client.
 *
 * Instead of writing directly to the SQLite file (which the running app does not
 * pick up / cache-busts), we drive the same endpoints the dashboard uses:
 *
 *   POST /api/providers/validate  { provider, apiKey }        -> { valid, error }
 *   POST /api/providers           { provider, name, apiKey,
 *                                   priority, proxyPoolId,
 *                                   testStatus }              -> { connection: {...} }
 *
 * Auth is the `auth_token` cookie. It can be supplied directly
 * (NINEROUTER_AUTH_TOKEN) or minted on demand from the dashboard password
 * (NINEROUTER_PASSWORD) via POST /api/auth/login.
 */
export class NineRouterAPI {
  constructor({ baseUrl, token, password } = {}) {
    this.baseUrl = (baseUrl || 'http://localhost:20128').replace(/\/+$/, '');
    this.password = password || '';
    this.cookie = token ? `auth_token=${token}` : null;
    console.log(chalk.gray(`📂 9router API: ${this.baseUrl}`));
  }

  /**
   * Mint a valid auth_token without any credentials by signing a JWT with the
   * 9router installation's own HS256 secret. This secret lives in the app's
   * data dir (`%APPDATA%/9router/jwt-secret` on Windows) and the token format
   * is `{ authenticated: true, iat, exp }`, identical to /api/auth/login.
   */
  mintTokenFromSecret() {
    const candidates = [
      process.env.NINEROUTER_DATA_DIR,
      process.env.DATA_DIR,
      process.env.APPDATA ? path.join(process.env.APPDATA, '9router') : null,
      path.join(os.homedir(), 'AppData', 'Roaming', '9router'),
      path.join(os.homedir(), '.9router'),
    ].filter(Boolean);

    for (const dir of candidates) {
      const file = path.join(dir, 'jwt-secret');
      try {
        const secret = fs.readFileSync(file, 'utf8').trim();
        if (!secret) continue;
        const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const header = b64({ alg: 'HS256', typ: 'JWT' });
        const payload = b64({ authenticated: true, iat: now, exp: now + 86400 });
        const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
        this.cookie = `auth_token=${header}.${payload}.${sig}`;
        console.log(chalk.gray(`   🔑 9router token minted from ${file}`));
        return true;
      } catch {}
    }
    return false;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.cookie) h.Cookie = this.cookie;
    return h;
  }

  /** Mint a fresh auth_token cookie from the dashboard password. */
  async login() {
    if (!this.password) return false;
    try {
      const res = await axios.post(
        `${this.baseUrl}/api/auth/login`,
        { password: this.password },
        { headers: { 'Content-Type': 'application/json' }, validateStatus: () => true, timeout: 15000 }
      );
      if (res.status !== 200 || !res.data?.success) {
        console.log(chalk.yellow(`   ⚠️ 9router login failed (${res.status}): ${res.data?.error || 'unknown'}`));
        return false;
      }
      const setCookie = res.headers['set-cookie'] || [];
      const found = [].concat(setCookie).find((c) => String(c).startsWith('auth_token='));
      if (!found) return false;
      this.cookie = String(found).split(';')[0];
      console.log(chalk.gray('   🔑 9router token refreshed via login'));
      return true;
    } catch (e) {
      console.log(chalk.yellow(`   ⚠️ 9router login error: ${e.message}`));
      return false;
    }
  }

  async ensureAuth() {
    if (this.cookie) return true;
    if (await this.login()) return true;
    return this.mintTokenFromSecret();
  }

  async shouldRetryAuth(res) {
    if (res.status !== 401 && res.status !== 403) return false;
    this.cookie = null;
    if (await this.login()) return true;
    return this.mintTokenFromSecret();
  }

  /** Validate an OpenRouter key. Returns {valid, error}. */
  async validate(apiKey) {
    await this.ensureAuth();
    const res = await axios.post(
      `${this.baseUrl}/api/providers/validate`,
      { provider: 'openrouter', apiKey },
      { headers: this.headers(), validateStatus: () => true, timeout: 30000 }
    );
    if (await this.shouldRetryAuth(res)) return this.validate(apiKey);
    if (res.status !== 200) return { valid: false, error: `HTTP ${res.status}` };
    return { valid: res.data?.valid === true, error: res.data?.error || null };
  }

  /** Create an openrouter connection. Returns the connection object. */
  async addConnection({ name, apiKey, priority = 1 }) {
    await this.ensureAuth();
    const payload = {
      provider: 'openrouter',
      name,
      apiKey,
      priority,
      proxyPoolId: null,
      testStatus: 'active',
    };
    const res = await axios.post(`${this.baseUrl}/api/providers`, payload, {
      headers: this.headers(),
      validateStatus: () => true,
      timeout: 30000,
    });
    if (await this.shouldRetryAuth(res)) return this.addConnection({ name, apiKey, priority });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`9router create failed (HTTP ${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    const conn = res.data?.connection;
    if (!conn?.id) {
      throw new Error(`9router create returned no connection id: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    return conn;
  }
}

/** Random connection name like `auto-a1b2c3d4`. */
export function randomName(prefix = 'auto') {
  const s = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${s}`;
}
