import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const apiKey = process.env.BIRDEYE_API_KEY;
console.log(`Using API Key: ${apiKey?.slice(0, 8)}...${apiKey?.slice(-4)}\n`);

// Test different token addresses
const testTokens = {
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenErt9',
  'SOL (WSOL)': 'So11111111111111111111111111111111111111112',
};

async function testEndpoint(name: string, url: string, method: 'GET' | 'POST' = 'GET') {
  try {
    console.log(`Testing ${name}...`);
    const config: any = {
      headers: { 'X-API-KEY': apiKey },
      timeout: 8000,
    };

    let response;
    if (method === 'POST') {
      response = await axios.post(url, {}, config);
    } else {
      response = await axios.get(url, config);
    }

    if (response.status === 200) {
      console.log(`✅ ${name} - Status: ${response.status}`);
      if (response.data?.data) {
        const data = response.data.data;
        if (data.market_cap !== undefined) {
          console.log(`   Market Cap: $${(data.market_cap / 1000000).toFixed(2)}M`);
        }
        if (data.holder_count !== undefined) {
          console.log(`   Holders: ${data.holder_count}`);
        }
        if (data.owner_balance !== undefined) {
          console.log(`   Owner Balance: ${data.owner_balance}%`);
        }
      }
      return true;
    }
  } catch (e: any) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    console.log(`❌ ${name} - Status: ${status} - ${msg}`);
    return false;
  }
  console.log(`\n`);
}

async function testDexScreener(tokenAddr: string, label: string) {
  try {
    console.log(`Testing DexScreener fallback for ${label}...`);
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`,
      { timeout: 8000 }
    );
    if (response.data?.pairs && response.data.pairs.length > 0) {
      const pair = response.data.pairs[0];
      console.log(`✅ DexScreener - Found pair`);
      console.log(`   Price: $${pair.priceUsd || pair.priceNative}`);
      console.log(`   Liquidity: $${(pair.liquidity?.usd || 0).toFixed(2)}`);
      console.log(`   FDV: $${(pair.fdv || 0).toFixed(2)}`);
      return true;
    }
  } catch (e: any) {
    console.log(`❌ DexScreener - ${e.message}`);
  }
  return false;
}

(async () => {
  console.log('='.repeat(60));
  console.log('BIRDEYE API DIAGNOSTIC TEST');
  console.log('='.repeat(60));
  console.log();

  // Test main endpoints
  for (const [label, addr] of Object.entries(testTokens)) {
    console.log(`\n--- Testing ${label} (${addr}) ---\n`);

    await testEndpoint(`Birdeye Meta - ${label}`, `https://public-api.birdeye.so/public/token/meta?address=${addr}`);
    console.log();

    await testEndpoint(`Birdeye Security - ${label}`, `https://public-api.birdeye.so/public/token/security?address=${addr}`);
    console.log();

    await testDexScreener(addr, label);
    console.log();
  }

  console.log('\n' + '='.repeat(60));
  console.log('RECOMMENDATIONS:');
  console.log('='.repeat(60));
  console.log(`1. If Birdeye endpoints work → use them (more detailed)`);
  console.log(`2. If Birdeye fails → use DexScreener as fallback`);
  console.log(`3. If both fail → use minimal data (just log scanning)`);
  console.log();

  process.exit(0);
})();
