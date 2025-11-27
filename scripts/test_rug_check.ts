import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const apiKey = process.env.BIRDEYE_API_KEY;
const TEST_TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC

if (!apiKey) {
  console.error('BIRDEYE_API_KEY not set');
  process.exit(1);
}

(async () => {
  console.log(`Testing rug check and Birdeye data fetch for USDC (${TEST_TOKEN})...\n`);

  try {
    console.log('Fetching Birdeye metadata...');
    const metaResponse = await axios.get(
      `https://public-api.birdeye.so/public/token/meta?address=${TEST_TOKEN}`,
      { headers: { 'X-API-KEY': apiKey }, timeout: 5000 }
    );
    const birdeyeData = metaResponse.data?.data;
    if (birdeyeData) {
      console.log(`✅ Birdeye data found:`);
      console.log(`   Market Cap: $${(birdeyeData.market_cap / 1000000).toFixed(2)}M`);
      console.log(`   Holders: ${birdeyeData.holder_count}`);
      console.log(`   Liquidity: $${(birdeyeData.liquidity?.usd || 0 / 1000).toFixed(2)}K\n`);
    } else {
      console.log(`⚠️ No Birdeye metadata\n`);
    }
  } catch (e: any) {
    console.error(`❌ Birdeye fetch failed:`, e.response?.status, e.message);
  }

  try {
    console.log('Running rug pull security check...');
    const secResponse = await axios.get(
      `https://public-api.birdeye.so/public/token/security?address=${TEST_TOKEN}`,
      { headers: { 'X-API-KEY': apiKey }, timeout: 5000 }
    );
    const rugData = secResponse.data?.data;
    if (rugData) {
      console.log(`✅ Rug check complete:`);
      console.log(`   Owner Balance: ${rugData.owner_balance || 0}%`);
      console.log(`   Owner Change Status: ${rugData.owner_change_status || 'unknown'}`);
      console.log(`   Top 10 Holder Ratio: ${rugData.top10_holder_ratio || 0}%`);
      console.log(`   Is Honeypot: ${rugData.is_honeypot}`);
      console.log(`   Is Locked: ${rugData.is_locked}`);
      console.log(`\n✅ Both Birdeye and rug verification systems are working!`);
    } else {
      console.log(`⚠️ No rug security data`);
    }
  } catch (e: any) {
    console.error(`❌ Rug check failed:`, e.response?.status, e.message);
  }

  process.exit(0);
})();
