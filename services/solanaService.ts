
import { TokenMetadata } from '../types';

export const fetchTokenData = async (address: string): Promise<TokenMetadata | null> => {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      return {
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        priceNative: pair.priceNative,
        priceUsd: pair.priceUsd,
        address: pair.baseToken.address,
        fdv: pair.fdv || 0,
        mcap: pair.marketCap || pair.fdv || 0,
        liquidity: pair.liquidity?.usd || 0,
        volume24h: pair.volume?.h24 || 0,
        priceChange24h: pair.priceChange?.h24 || 0,
        priceChange1h: pair.priceChange?.h1 || 0,
        ageHours: (Date.now() - (pair.pairCreatedAt || Date.now())) / (1000 * 60 * 60),
        txns24h: {
          buys: pair.txns?.h24?.buys || 0,
          sells: pair.txns?.h24?.sells || 0
        }
      };
    }
    return null;
  } catch (error) {
    console.error("Error fetching token data:", error);
    return null;
  }
};

export const fetchTrendingSolanaTokens = async (): Promise<TokenMetadata[]> => {
  try {
    // 1. Fetch Top Boosted Tokens (Best source for active new pairs & trending coins)
    const response = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const boosts = await response.json();

    if (!Array.isArray(boosts)) return [];

    // 2. Filter for Solana chain and grab addresses (Grab up to 60 to filter down)
    const solanaAddresses = boosts
      .filter((item: any) => item.chainId === 'solana')
      .slice(0, 60) 
      .map((item: any) => item.tokenAddress)
      .join(',');

    if (!solanaAddresses) return [];

    // 3. Fetch detailed pair data
    const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${solanaAddresses}`);
    const pairsData = await pairsRes.json();

    if (!pairsData.pairs) return [];

    // 4. High-Octane Filters (Txns, Volume, Freshness)
    const candidates = new Map<string, TokenMetadata>();
    
    // CONFIGURATION FOR ACTIVE TRADING
    const MIN_AGE_MS = 5 * 60 * 1000;  // 5 Minutes (Catch them young)
    const MIN_LIQUIDITY = 3000;        // $3k Min Liquidity (Avoid absolute dust)
    const MIN_VOLUME = 10000;          // $10k Min Volume (Needs activity)
    const MIN_TXNS = 300;              // Minimum 300 Txns/24h (Needs active traders)
    
    pairsData.pairs.forEach((pair: any) => {
        const vol24 = pair.volume?.h24 || 0;
        const liq = pair.liquidity?.usd || 0;
        const fdv = pair.fdv || 0;
        const priceChange24 = pair.priceChange?.h24 || 0;
        const createdAt = pair.pairCreatedAt || Date.now(); 
        const age = Date.now() - createdAt;
        
        const buys = pair.txns?.h24?.buys || 0;
        const sells = pair.txns?.h24?.sells || 0;
        const totalTxns = buys + sells;

        const isSolana = pair.chainId === 'solana' && pair.quoteToken.symbol === 'SOL';
        const isLiquid = liq > MIN_LIQUIDITY;
        const hasVolume = vol24 > MIN_VOLUME;
        const hasActivity = totalTxns > MIN_TXNS;
        
        // Allow dips, but avoid complete rug pulls (e.g. -90% in 24h)
        const isNotDead = priceChange24 > -60; 
        const isOldEnough = age > MIN_AGE_MS; 

        if (
            isSolana && 
            isLiquid && 
            hasVolume && 
            hasActivity &&
            isNotDead &&
            isOldEnough &&
            !candidates.has(pair.baseToken.address)
        ) {
             candidates.set(pair.baseToken.address, {
                name: pair.baseToken.name,
                symbol: pair.baseToken.symbol,
                priceNative: pair.priceNative,
                priceUsd: pair.priceUsd,
                address: pair.baseToken.address,
                fdv: fdv,
                mcap: pair.marketCap || fdv,
                liquidity: liq,
                volume24h: vol24,
                priceChange24h: priceChange24,
                priceChange1h: pair.priceChange?.h1 || 0,
                ageHours: age / (1000 * 60 * 60),
                txns24h: { buys, sells }
             });
        }
    });

    // Sort by Transaction Count (Activity) Descending
    return Array.from(candidates.values()).sort((a, b) => {
        const txnsA = a.txns24h.buys + a.txns24h.sells;
        const txnsB = b.txns24h.buys + b.txns24h.sells;
        return txnsB - txnsA;
    });
  } catch (e) {
    console.error("Scanner Error:", e);
    return [];
  }
};
