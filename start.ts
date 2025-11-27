import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './core/liquidity';
import { retry } from './core/utils';
import { keypairEncryption } from './core/utils';
import { 
  retrieveEnvVariable, 
  retrieveTokenValueByAddress, 
  sendTelegramNotification, 
  sendCoinScanNotification, 
  CoinScanData, 
  getBirdeyeTokenInfo, 
  checkRugPull,
  formatScanNotification,
  formatBulkScanSummary,
  ScanCoinDetails
} from './core/utils';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './core/market';
import { MintLayout } from './core/types';
import pino from 'pino';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

const transport = pino.transport({
  targets: [
    // {
    //   level: 'trace',
    //   target: 'pino/file',
    //   options: {
    //     destination: 'buy.log',
    //   },
    // },

    {
      level: 'trace',
      target: 'pino-pretty',
      options: {},
    },
  ],
});

export const logger = pino(
  {
    level: 'trace',
    redact: ['poolKeys'],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  buyValue?: number;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

// Pumpfun program ID
const PUMPFUN_PROGRAM_ID = new PublicKey('6EF8rJ3WgAC7tRZ9oJW7Sy8DYbK6mkemqYDhMyW6DExx');
let existingPumpfunCoins: Set<string> = new Set<string>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;

const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
const SCAN_ONLY_MODE = retrieveEnvVariable('SCAN_ONLY_MODE', logger) === 'true';

let snipeList: string[] = [];
let scannedCoins: Array<{ mint: string; timestamp: number; rugScore: number; marketCap?: number }> = [];

// Scan statistics for periodic reporting
let scanStats = {
  totalScanned: 0,
  withData: 0,
  notIndexed: 0,
  lowRisk: 0,
  mediumRisk: 0,
  highRisk: 0,
  notRenounced: 0,
};
const lastStatsLog = { time: Date.now() };
const STATS_LOG_INTERVAL = 60000; // Log stats every 60 seconds

async function init(): Promise<void> {
  // get wallet
  await keypairEncryption();
  const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get quote mint and amount
  const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
  const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
  switch (QUOTE_MINT) {
    case 'SOL':
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are SOL, WSOL, and USDC`);
    }
  }

  logger.info(`Snipe list: ${USE_SNIPE_LIST}`);
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
  logger.info(`🔍 SCAN ONLY MODE: ${SCAN_ONLY_MODE ? '✅ ON (No buying)' : '❌ OFF (Trading enabled)'}`);
  logger.info(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  let tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString());

  if (!tokenAccount) {
    logger.warn(`No ${quoteToken.symbol} token account found. Creating one...`);
    
    // Create ATA for quote token
    const ata = getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey);
    quoteTokenAssociatedAddress = ata;
    
    logger.info(`Created associated token account: ${ata.toBase58()}`);
  } else {
    quoteTokenAssociatedAddress = tokenAccount.pubkey;
  }

  // load tokens to snipe
  loadSnipeList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  const baseMintStr = poolState.baseMint.toBase58();
  const poolIdStr = id.toBase58();

  // Check if mint is renounced
  let isMintRenounced = true;
  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);

    if (mintOption !== true) {
      if (SCAN_ONLY_MODE) {
        scanStats.notRenounced++;
      }
      logger.debug({ mint: poolState.baseMint }, 'Skipping, owner can mint tokens (filtered by renounce check)');
      // Don't send notifications for filtered coins (too spammy)
      return;
    }
    isMintRenounced = true;
  }

  // Send scanning notification with security checks
  try {
    const rugCheck = await checkRugPull(baseMintStr);
    const birdeyeData = await getBirdeyeTokenInfo(baseMintStr);

    const coinDetails = {
      mint: baseMintStr,
      poolId: poolIdStr,
      timestamp: Date.now(),
      marketCap: birdeyeData?.market_cap || 0,
      holders: birdeyeData?.holder_count || 0,
      liquidity: birdeyeData?.liquidity?.usd || 0,
      rugScore: rugCheck.score,
      isHoneypot: rugCheck.score > 70,
      ownerBalance: parseFloat(rugCheck.details.match(/Owner Balance.*?(\d+\.?\d*)/)?.[1] || '0'),
      top10HolderRatio: parseFloat(rugCheck.details.match(/Top 10 Holders.*?(\d+\.?\d*)/)?.[1] || '0'),
    };

    // Store scanned coin data
    scannedCoins.push({
      mint: baseMintStr,
      timestamp: Date.now(),
      rugScore: rugCheck.score,
      marketCap: birdeyeData?.market_cap,
    });

    // Keep only last 1000 scanned coins
    if (scannedCoins.length > 1000) {
      scannedCoins = scannedCoins.slice(-1000);
    }

    if (SCAN_ONLY_MODE) {
      // Update scan statistics
      scanStats.totalScanned++;
      
      // Log scan details at INFO level
      const hasData = birdeyeData && (birdeyeData.market_cap || birdeyeData.holder_count);
      
      if (hasData) {
        scanStats.withData++;
        
        // Categorize by rug score
        if (rugCheck.score < 30) scanStats.lowRisk++;
        else if (rugCheck.score < 60) scanStats.mediumRisk++;
        else scanStats.highRisk++;
        
        const source = birdeyeData?.source === 'dexscreener' ? '📊 DexScreener' : '🦅 Birdeye';
        
        logger.info(
          {
            mint: baseMintStr,
            poolId: poolIdStr,
            rugScore: rugCheck.score,
            marketCap: birdeyeData?.market_cap,
            holders: birdeyeData?.holder_count,
            liquidity: birdeyeData?.liquidity?.usd,
            source: birdeyeData?.source || 'birdeye',
          },
          `${source} ✅ SCANNED - MC: $${(birdeyeData?.market_cap ? (birdeyeData.market_cap / 1000000).toFixed(2) : '0')}M | Holders: ${birdeyeData?.holder_count || '?'} | Rug: ${rugCheck.score}/100`,
        );

        // Send notification only for coins with low rug score
        if (rugCheck.score < 50) {
          const { formatScanNotification } = await import('./core/utils');
          const notification = formatScanNotification(coinDetails);
          await sendTelegramNotification(notification);
          logger.info({ mint: baseMintStr }, `📲 Telegram notification sent (Risk Level: ${rugCheck.score < 30 ? 'LOW' : 'MEDIUM'})`);
        } else {
          logger.debug({ mint: baseMintStr, rugScore: rugCheck.score }, `Skipped notification (risk too high)`);
        }
      } else {
        // Token not yet indexed by either service
        scanStats.notIndexed++;
      }
      
      // Log stats periodically (every 60 seconds)
      if (Date.now() - lastStatsLog.time > STATS_LOG_INTERVAL) {
        logger.info(
          scanStats,
          `📊 SCAN STATS: Scanned ${scanStats.totalScanned} tokens | With Data: ${scanStats.withData} | Not Indexed: ${scanStats.notIndexed} | 🟢 Low Risk: ${scanStats.lowRisk} | 🟡 Medium: ${scanStats.mediumRisk} | 🔴 High: ${scanStats.highRisk}`,
        );
        lastStatsLog.time = Date.now();
      }
    }
  } catch (e) {
    logger.warn({ mint: baseMintStr, error: String(e) }, 'Failed to scan coin');
  }
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    const deserialize = MintLayout.decode(data);
    return deserialize.mintAuthorityOption === 0;
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check if mint is renounced`);
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData?.baseMint }, `Failed to process market`);
  }
}

export async function processPumpfunCoin(updatedAccountInfo: KeyedAccountInfo) {
  const accountId = updatedAccountInfo.accountId.toString();
  
  if (existingPumpfunCoins.has(accountId)) {
    return;
  }

  existingPumpfunCoins.add(accountId);

  try {
    // Extract token mint from account data
    // Pumpfun events contain token information
    const tokenData = updatedAccountInfo.accountInfo.data;
    
    // Try to extract mint address (typically in the account data)
    // For now, we'll get basic info and send notification
    logger.info({ account: accountId }, `🍆 New Pumpfun coin detected`);

    // Send notification for Pumpfun coin
    const notification = `🍆 **PUMPFUN COIN DETECTED**\n📍 Account: \`${accountId}\`\n[View on Solscan](https://solscan.io/account/${accountId})`;
    await sendTelegramNotification(notification);
  } catch (e) {
    logger.debug('Failed to process Pumpfun coin', e);
}
  }

// BUYING FUNCTION REMOVED - SCAN ONLY MODE

// SELLING FUNCTION REMOVED - SCAN ONLY MODE

// async function getMarkPrice(connection: Connection, baseMint: PublicKey, quoteMint?: PublicKey): Promise<number> {
//   const marketAddress = await Market.findAccountsByMints(
//     solanaConnection,
//     baseMint,
//     quoteMint === undefined ? Token.WSOL.mint : quoteMint,
//     TOKEN_PROGRAM_ID,
//   );

//   const market = await Market.load(solanaConnection, marketAddress[0].publicKey, {}, TOKEN_PROGRAM_ID);

//   const bestBid = (await market.loadBids(solanaConnection)).getL2(1)[0][0];
//   const bestAsk = (await market.loadAsks(solanaConnection)).getL2(1)[0][0];

//   return (bestAsk + bestBid) / 2;
// }

function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  try {
    await init();
    const runTimestamp = Math.floor(new Date().getTime() / 1000);
    const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
      RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
      async (updatedAccountInfo) => {
        const key = updatedAccountInfo.accountId.toString();
        const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
        const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
        const existing = existingLiquidityPools.has(key);

        if (!existing) {
          existingLiquidityPools.add(key);
          logger.info({ poolOpenTime, key }, 'Processing raydium pool (new or untracked)');
          const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
        }
      },
      commitment,
      [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: quoteToken.mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
            bytes: OPENBOOK_PROGRAM_ID.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
            bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
          },
        },
      ],
    );

    const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
      OPENBOOK_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const key = updatedAccountInfo.accountId.toString();
        const existing = existingOpenBookMarkets.has(key);
        if (!existing) {
          existingOpenBookMarkets.add(key);
          const _ = processOpenBookMarket(updatedAccountInfo);
        }
      },
      commitment,
      [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: quoteToken.mint.toBase58(),
          },
        },
      ],
    );

    // Pumpfun listener
    const pumpfunSubscriptionId = solanaConnection.onProgramAccountChange(
      PUMPFUN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const _ = processPumpfunCoin(updatedAccountInfo);
      },
      commitment,
    );

    // Wallet tracking removed - Scan only mode

    logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
    logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);
    logger.info(`Listening for pumpfun changes: ${pumpfunSubscriptionId}`);

    if (USE_SNIPE_LIST) {
      setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
    }
  } catch (error) {
    logger.error(`Failed to initialize bot: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

runListener();
