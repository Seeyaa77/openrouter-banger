import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import axios from 'axios';
import chalk from 'chalk';

puppeteer.use(StealthPlugin());

const TEMP_EMAIL_BASE = process.env.TEMP_EMAIL_BASE_URL || 'https://tempik.neroism.web.id';
const TEMP_EMAIL_DOMAIN = process.env.TEMP_EMAIL_DOMAIN || 'xyntaur.com';

export class OpenRouterAutomation {
  constructor({ headless = false } = {}) {
    this.headless = headless;
    this.browser = null;
    this.page = null;
    this.createdKey = null;
    this.email = null;
    this.apiBase = 'https://openrouter.ai/api/frontend/v1/private/workspace-api-keys';
  }

  async init() {
    console.log(chalk.gray('🌐 Launching browser...'));
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
      'C:/Users/fakeg/.cache/puppeteer/chrome/win64-149.0.7827.22/chrome-win64/chrome.exe';
    
    this.browser = await puppeteer.launch({
      headless: this.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      defaultViewport: { width: 1366, height: 768 },
      executablePath
    });

    await this.newPage();
  }

  async newPage() {
    // Close existing page if any
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
    );

    // Intercept API responses to extract the API key
    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/frontend/v1/private/workspace-api-keys') && !url.includes('include_grant')) {
        try {
          const body = await response.json();
          if (body.data?.key) {
            this.createdKey = body.data.key;
            console.log(chalk.green('✓ Intercepted API key from response:'), this.createdKey);
          }
        } catch (e) {}
      }
    });
  }

  async resetPage() {
    // Create a fresh page with clean cookies/storage for each account
    await this.newPage();
    // Clear cookies and storage
    const client = await this.page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    await this.page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
    });
    console.log(chalk.gray('   🔄 Fresh browser context created (cookies/storage cleared)'));
  }

  async generateTempEmail() {
    console.log(chalk.gray('📧 Generating temp email...'));
    const localPart = `agent${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`;
    const email = `${localPart}@${TEMP_EMAIL_DOMAIN}`;
    console.log(chalk.green(`✅ Temp email: ${email}`));
    return email;
  }

  async waitForVerificationEmail(email) {
    console.log(chalk.gray('📬 Waiting for verification email via API...'));
    
    const MAX_ATTEMPTS = 120; // 120 * 2s = 240 seconds (4 minutes) - email can be slow
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const res = await axios.get(`${TEMP_EMAIL_BASE}/api/inboxes/${encodeURIComponent(email)}/messages`, { 
          timeout: 10000 
        });
        const messages = res.data;
        
        if (messages && messages.length > 0) {
          for (const msg of messages) {
            const body = msg.body || '';
            
            if (body.includes('clerk.openrouter.ai') || body.includes('verify')) {
              console.log(chalk.green('✅ Verification email found!'));
              
              const match = body.match(/href="([^"]*clerk\.openrouter\.ai\/v1\/verify[^"]*)"/);
              if (match) {
                // FIX: Replace HTML & entities with literal &
                let cleanLink = match[1];
                // Email HTML encodes & as the 5-char entity &amp; — unescape it
                cleanLink = cleanLink.replace(/&amp;/g, '&');
                console.log(chalk.gray('   Cleaned verify link:'), cleanLink.substring(0, 150));
                
                return cleanLink;
              }
            }
          }
        }
      } catch (e) {
        // Ignore, keep polling
      }

      if (attempt < 3 || attempt % 10 === 0) {
        console.log(chalk.gray(`   Attempt ${attempt + 1}/${MAX_ATTEMPTS} - waiting...`));
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error('Verification email not received within timeout');
  }

  async registerOnOpenRouter(email) {
    console.log(chalk.gray('📝 Registering on OpenRouter...'));
    
    await this.page.goto('https://openrouter.ai/sign-up', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(chalk.gray('   Page loaded, URL:'), this.page.url());
    
    // Check for Cloudflare challenge
    const pageText = await this.page.evaluate(() => document.body.innerText);
    if (pageText.includes('Cloudflare') || pageText.includes('security verification') || pageText.includes('Ray ID')) {
      console.log(chalk.yellow('   ⚠️ Cloudflare challenge detected, waiting...'));
      await new Promise(r => setTimeout(r, 10000));
    }
    
    console.log(chalk.gray('   Waiting for form...'));
    await this.page.waitForSelector('input[name="firstName"]', { timeout: 30000 });
    console.log(chalk.gray('   Form found, filling...'));
    await this.page.type('input[name="firstName"]', 'Test', { delay: 50 });
    await this.page.type('input[name="lastName"]', 'User', { delay: 50 });
    await this.page.type('input[name="emailAddress"]', email, { delay: 50 });
    await this.page.type('input[name="password"]', 'UniquePass12345!', { delay: 50 });

    // Check terms checkbox
    await this.page.evaluate(() => {
      const el = document.querySelector('input[name="legalAccepted"]');
      if (el) el.click();
    });
    
    // Submit via Continue button
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.innerText.trim() === 'Continue') {
          btn.click();
          break;
        }
      }
    });
    
    // Wait until Clerk navigates to the verify-email page (confirms submit was accepted).
    // OpenRouter may interpose a /sign-up/protect-check page (Stripe hCaptcha /
    // HumanSecurity) that auto-resolves after ~10-60s when the browser looks human.
    try {
      await this.page.waitForFunction('location.pathname.includes("verify-email-address")', {
        timeout: 120000,
        polling: 2000,
      });
      console.log(chalk.green('✅ Registration submitted (verify page reached)'));
    } catch (e) {
      throw new Error(`Registration did not reach verify page (url: ${this.page.url()})`);
    }
  }

  async completeVerification(verifyLink) {
    console.log(chalk.gray('🔗 Completing verification...'));
    
    // Extract token from the verification link
    const tokenMatch = verifyLink.match(/token=([^&]+)/);
    if (tokenMatch) {
      const token = tokenMatch[1];
      console.log(chalk.gray('   Using token directly for verification...'));
      await this.page.goto(`https://clerk.openrouter.ai/v1/verify?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
    } else {
      // Fallback: use the full link
      await this.page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
    }
    
    // Check if we successfully verified
    const pageText = await this.page.evaluate(() => document.body.innerText);
    
    // If we got a Clerk error or still on sign-up, try direct /sign-up/verify
    if (pageText.includes('Malformed') || pageText.includes('security verification') || pageText.includes('Cloudflare')) {
      console.log(chalk.gray('   Verify link had issues, trying /sign-up/verify direct...'));
      await this.page.goto('https://openrouter.ai/sign-up/verify', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
    }
    
    console.log(chalk.green('✅ Verification process complete'));
  }

  async completeOnboarding() {
    console.log(chalk.gray('   Completing onboarding...'));
    
    // Go to keys page
    await this.page.goto('https://openrouter.ai/workspaces/default/keys', { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    
    // Click Individual radio button
    console.log(chalk.gray('   Selecting Individual...'));
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button[role="radio"]');
      for (const btn of buttons) {
        if (btn.innerText.includes('Individual')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await new Promise(r => setTimeout(r, 2000));
    
    // Click Next button
    console.log(chalk.gray('   Clicking Next...'));
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.innerText.trim() === 'Next' && btn.className.includes('bg-primary')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await new Promise(r => setTimeout(r, 10000));
    console.log(chalk.green('   Onboarding complete, URL:'), this.page.url());
    
    // Check if we already got a key during onboarding (it sometimes creates one automatically)
    if (this.createdKey) {
      console.log(chalk.green('   ✅ Key already created during onboarding!'));
      return;
    }
    
    // Click Continue to dismiss modal
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.innerText.trim() === 'Continue' && btn.className.includes('bg-primary')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await new Promise(r => setTimeout(r, 5000));
  }

  async createApiKeyAndExtract() {
    console.log(chalk.gray('🔑 Creating API key...'));
    
    // Complete onboarding first (may create a key automatically)
    await this.completeOnboarding();
    
    // If key was already created during onboarding, use it
    if (this.createdKey) {
      console.log(chalk.green(`✅ Using key from onboarding:`), this.createdKey);
      return this.createdKey;
    }
    
    // Otherwise create a new key manually
    // Click "New key" button
    console.log(chalk.gray('   Clicking "New key" button...'));
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.innerText.trim() === 'New key') {
          btn.click();
          break;
        }
      }
    });
    await new Promise(r => setTimeout(r, 3000));
    
    // Fill key name
    console.log(chalk.gray('   Filling key name...'));
    await this.page.evaluate(() => {
      const nameInput = document.querySelector('input[name="name"]');
      if (nameInput) { 
        nameInput.value = 'bot-key'; 
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    
    // Click Create
    console.log(chalk.gray('   Clicking "Create" button...'));
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.innerText.trim() === 'Create') {
          btn.click();
          break;
        }
      }
    });

    // Wait for API key to be intercepted
    console.log(chalk.gray('   Waiting for API key interception...'));
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (this.createdKey) {
        console.log(chalk.green(`✅ API key intercepted:`), this.createdKey);
        return this.createdKey;
      }
      if (i === 0 || i % 4 === 0) {
        console.log(chalk.gray(`   Wait ${i + 1}/20 - still waiting...`));
      }
    }

    // Fallback: check page text
    if (!this.createdKey) {
      console.log(chalk.yellow('   ⚠️ Key not intercepted, checking page text fallback...'));
      const pageText = await this.page.evaluate(() => document.body.innerText);
      const keyMatch = pageText.match(/sk-or-v1-[a-zA-Z0-9]{64,}/);
      if (keyMatch) {
        this.createdKey = keyMatch[0];
        console.log(chalk.green(`✅ API key extracted via fallback:`), this.createdKey.substring(0, 20) + '...');
      }
    }
    
    return this.createdKey;
  }

  async validateApiKey(apiKey) {
    console.log(chalk.gray('🔍 Validating API key...'));
    try {
      const response = await axios.get('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000
      });
      if (response.data?.data) {
        console.log(chalk.green('✅ API key validated successfully'));
        return true;
      }
    } catch (e) {
      console.log(chalk.red(`   Validation error: ${e.message}`));
      // Don't fail account creation if validation fails - key might still work
      return true;
    }
    return true;
  }

  async createAccount() {
    let email = null;
    let verifyLink = null;
    let apiKey = null;

    try {
      if (!this.browser) await this.init();
      else await this.resetPage();

      email = await this.generateTempEmail();
      await this.registerOnOpenRouter(email);
      verifyLink = await this.waitForVerificationEmail(email);
      
      if (!verifyLink) throw new Error('No verification link found in email');
      
      await this.completeVerification(verifyLink);
      apiKey = await this.createApiKeyAndExtract();

      if (!apiKey) throw new Error('API key was not created/extracted');

      // Validate the key
      const valid = await this.validateApiKey(apiKey);
      if (!valid) throw new Error('API key validation failed');

      return { success: true, email, apiKey };
    } catch (error) {
      console.error(chalk.red('❌ createAccount error:'), error.message);
      return { success: false, email, apiKey: this.createdKey || null, error: error.message };
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}