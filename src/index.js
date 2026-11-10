import 'dotenv/config';
import chalk from 'chalk';
import readline from 'readline';
import { OpenRouterAutomation } from './automation.js';
import { NineRouterAPI, randomName } from './nineapi.js';

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function main() {
  console.log(chalk.cyan.bold('\n🚀 OpenRouter Banger - Automated Account Creator\n'));

  // 9router auth: token, password, or auto-mint from the local install's secret
  if (!process.env.NINEROUTER_AUTH_TOKEN && !process.env.NINEROUTER_PASSWORD) {
    console.log(chalk.gray('ℹ️  No 9router token/password set — will mint one from the local install secret.'));
  }

  // Prompt for number of accounts to create
  const args = process.argv.slice(2);
  let count;
  
  if (args.length > 0 && !isNaN(parseInt(args[0]))) {
    count = parseInt(args[0]);
  } else {
    const input = await askQuestion(chalk.yellow('📋 How many accounts do you want to create? ') + chalk.gray('(default: 1): '));
    count = parseInt(input) || 1;
  }

  // Prompt for headless mode
  let headless = args.includes('--headless') || process.env.HEADLESS === 'true';
  
  if (!args.includes('--headless') && !args.includes('--headed')) {
    const input = await askQuestion(chalk.yellow('🖥️  Run in headless mode? ') + chalk.gray('(y/N): '));
    headless = input.toLowerCase() === 'y' || input.toLowerCase() === 'yes';
  }

  console.log(chalk.gray(`\nConfig: ${count} account(s), headless: ${headless}\n`));

  const nine = new NineRouterAPI({
    baseUrl: process.env.NINEROUTER_BASE_URL || 'http://localhost:20128',
    token: process.env.NINEROUTER_AUTH_TOKEN,
    password: process.env.NINEROUTER_PASSWORD,
  });
  const automation = new OpenRouterAutomation({ headless });

  const results = [];

  for (let i = 1; i <= count; i++) {
    console.log(chalk.blue.bold(`\n━━━ Account ${i}/${count} ━━━\n`));

    try {
      const result = await automation.createAccount();
      
      if (result.success) {
        console.log(chalk.green('✅ Account created successfully'));
        console.log(chalk.gray(`   Email: ${result.email}`));
        console.log(chalk.gray(`   API Key: ${result.apiKey.substring(0, 20)}...`));

        // Validate + add to 9router through its REST API (same calls the dashboard uses)
        const check = await nine.validate(result.apiKey);
        if (!check.valid) {
          throw new Error(`9router rejected the key: ${check.error || 'invalid'}`);
        }
        const name = randomName('or');
        const conn = await nine.addConnection({ name, apiKey: result.apiKey });
        console.log(chalk.green(`✅ Added to 9router as "${conn.name}" (connection: ${conn.id.substring(0, 8)}...)`));

        results.push({ ...result, connectionId: conn.id, connectionName: conn.name, success: true });
      } else {
        console.log(chalk.red(`❌ Failed: ${result.error}`));
        results.push({ ...result, success: false });
      }
    } catch (error) {
      console.log(chalk.red(`❌ Error: ${error.message}`));
      results.push({ success: false, error: error.message });
    }

    // Delay between accounts
    if (i < count) {
      const delay = parseInt(process.env.DELAY_BETWEEN_ACCOUNTS) || 5000;
      console.log(chalk.yellow(`⏳ Waiting ${delay}ms before next account...`));
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // Summary
  console.log(chalk.cyan.bold('\n━━━ Summary ━━━'));
  const successful = results.filter(r => r.success);
  console.log(chalk.green(`✅ Successful: ${successful.length}/${count}`));
  console.log(chalk.red(`❌ Failed: ${results.length - successful.length}/${count}`));

  if (successful.length > 0) {
    console.log(chalk.cyan('\n📋 Created Accounts (all added to 9router):'));
    successful.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.email} | ${r.apiKey.substring(0, 25)}... | 9router: ${r.connectionName} (${r.connectionId.substring(0, 8)}...)`);
    });
  }

  await automation.close();
  console.log(chalk.cyan('\n✨ Done!'));
}

main().catch(console.error);