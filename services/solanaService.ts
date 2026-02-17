
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
    // 1. Fetch Top Boosted Tokens (Source of candidates)
    const response = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const boosts = await response.json();

    if (!Array.isArray(boosts)) return [];

    // 2. Filter for Solana chain and grab addresses (Grab more to allow for strict filtering)
    const solanaAddresses = boosts
      .filter((item: any) => item.chainId === 'solana')
      .slice(0, 50) 
      .map((item: any) => item.tokenAddress)
      .join(',');

    if (!solanaAddresses) return [];

    // 3. Fetch detailed pair data
    const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${solanaAddresses}`);
    const pairsData = await pairsRes.json();

    if (!pairsData.pairs) return [];

    // 4. Smart Swing Filter Logic (Relaxed for Simulation)
    const candidates = new Map<string, TokenMetadata>();
    
    // RELAXED CONSTRAINTS
    const MIN_AGE_MS = 15 * 60 * 1000; // 15 Minutes (was 6 hours)
    const MIN_LIQUIDITY = 5000;        // $5k (was $100k)
    const MIN_VOLUME = 10000;          // $10k (was $250k)
    
    pairsData.pairs.forEach((pair: any) => {
        const vol24 = pair.volume?.h24 || 0;
        const liq = pair.liquidity?.usd || 0;
        const fdv = pair.fdv || 0;
        const priceChange24 = pair.priceChange?.h24 || 0;
        const createdAt = pair.pairCreatedAt || Date.now(); // If missing, assume new
        const age = Date.now() - createdAt;

        const isSolana = pair.chainId === 'solana' && pair.quoteToken.symbol === 'SOL';
        const isLiquid = liq > MIN_LIQUIDITY;
        const hasVolume = vol24 > MIN_VOLUME;
        // Relaxed crash check: Allow drops up to -30% (dip buying)
        const isNotCrashing = priceChange24 > -30; 
        const isMature = age > MIN_AGE_MS; 
        // Relaxed manipulation check
        const isNotManipulated = fdv > 0; 

        if (
            isSolana && 
            isLiquid && 
            hasVolume && 
            isNotCrashing &&
            isMature &&
            isNotManipulated &&
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
                txns24h: {
                    buys: pair.txns?.h24?.buys || 0,
                    sells: pair.txns?.h24?.sells || 0
                }
             });
        }
    });

    // Sort by Volume (Momentum)
    return Array.from(candidates.values()).sort((a, b) => b.volume24h - a.volume24h);
  } catch (e) {
    console.error("Scanner Error:", e);
    return [];
  }
};
