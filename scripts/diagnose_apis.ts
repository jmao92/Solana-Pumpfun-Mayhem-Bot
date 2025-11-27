import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const apiKey = process.env.BIRDEYE_API_KEY;

// Test tokens (mix of established and new)
const TEST_TOKENS = [
  { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USDC (should work)' },
  { address: 'So11111111111111111111111111111111111111112', name: 'SOL (wrapped)' },
  { address: '4k3Dyjzvzp8eMZWUUbCApjERKwrZudnMYZQf1s6CEJq', name: 'Marinade (mSOL)' },
];

console.log(`\n🔧 BIRDEYE API DIAGNOSTIC TEST\n`);
console.log(`API Key: ${apiKey ? mask(apiKey) : 'NOT SET'}\n`);

async function mask(s: string) {
  if (s.length <= 8) return s.replace(/./g, '*');
  return s.slice(0, 4) + '...' + s.slice(-4);
}

(async () => {
  for (const token of TEST_TOKENS) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Testing: ${token.name}`);
    console.log(`Address: ${token.address}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Test Birdeye Meta
    console.log(`1️⃣ Birdeye Token Meta...`);
    try {
      const response = await axios.get(
        `https://public-api.birdeye.so/public/token/meta?address=${token.address}`,
        {
          headers: { 'X-API-KEY': apiKey },
          timeout: 5000,
        }
      );
      if (response.data?.data) {
        const data = response.data.data;
        console.log(`   ✅ SUCCESS`);
        console.log(`   Market Cap: $${((data.market_cap || 0) / 1000000).toFixed(2)}M`);
        console.log(`   Holders: ${data.holder_count || '?'}`);
        console.log(`   Liquidity: $${((data.liquidity?.usd || 0) / 1000).toFixed(2)}K\n`);
      } else {
        console.log(`   ⚠️ Empty response\n`);
      }
    } catch (e: any) {
      console.log(`   ❌ FAILED: ${e.response?.status || e.message}\n`);
    }

    // Test Birdeye Security
    console.log(`2️⃣ Birdeye Security Check...`);
    try {
      const response = await axios.get(
        `https://public-api.birdeye.so/public/token/security?address=${token.address}`,
        {
          headers: { 'X-API-KEY': apiKey },
          timeout: 5000,
        }
      );
      if (response.data?.data) {
        const data = response.data.data;
        console.log(`   ✅ SUCCESS`);
        console.log(`   Owner Balance: ${data.owner_balance || 0}%`);
        console.log(`   Top 10 Ratio: ${data.top10_holder_ratio || 0}%`);
        console.log(`   Honeypot: ${data.is_honeypot}`);
        console.log(`   Locked: ${data.is_locked}\n`);
      } else {
        console.log(`   ⚠️ Empty response\n`);
      }
    } catch (e: any) {
      console.log(`   ❌ FAILED: ${e.response?.status || e.message}\n`);
    }

    // Test DexScreener Fallback
    console.log(`3️⃣ DexScreener Fallback...`);
    try {
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${token.address}`,
        { timeout: 5000 }
      );
      if (response.data?.pairs && response.data.pairs.length > 0) {
        const pair = response.data.pairs[0];
        console.log(`   ✅ SUCCESS`);
        console.log(`   FDV: $${((pair.fdv || 0) / 1000000).toFixed(2)}M`);
        console.log(`   Liquidity: $${((pair.liquidity?.usd || 0) / 1000).toFixed(2)}K`);
        console.log(`   Price: $${pair.priceUsd || pair.priceNative}\n`);
      } else {
        console.log(`   ⚠️ No pairs found\n`);
      }
    } catch (e: any) {
      console.log(`   ❌ FAILED: ${e.response?.status || e.message}\n`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📋 SUMMARY`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  console.log(`✅ If Birdeye works: Bot will use Birdeye data (faster, more detailed)`);
  console.log(`✅ If Birdeye fails: Bot falls back to DexScreener (always available)`);
  console.log(`✅ Data is cached for 5-10 minutes to reduce API calls`);
  console.log(`✅ Rug checks run regardless of API source\n`);

  process.exit(0);
})();
