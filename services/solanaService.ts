
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
        liquidity: pair.liquidity?.usd || 0
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
    // 1. Fetch Top Boosted Tokens (Proxy for trending/hot)
    const response = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const boosts = await response.json();

    if (!Array.isArray(boosts)) return [];

    // 2. Filter for Solana chain and grab addresses
    const solanaAddresses = boosts
      .filter((item: any) => item.chainId === 'solana')
      .slice(0, 20) // Limit to top 20 to avoid URL length issues
      .map((item: any) => item.tokenAddress)
      .join(',');

    if (!solanaAddresses) return [];

    // 3. Fetch detailed pair data for these addresses
    const pairsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${solanaAddresses}`);
    const pairsData = await pairsRes.json();

    if (!pairsData.pairs) return [];

    // 4. Map to TokenMetadata and Filter for Swing Trade Suitability
    // Criteria: Must be Solana pair, Valid Liquidity, Not already a tiny microcap (for swing safety)
    const candidates = new Map<string, TokenMetadata>();
    
    pairsData.pairs.forEach((pair: any) => {
        if (
            pair.chainId === 'solana' && 
            pair.quoteToken.symbol === 'SOL' && 
            (pair.liquidity?.usd || 0) > 10000 && // Min $10k liquidity
            !candidates.has(pair.baseToken.address)
        ) {
             candidates.set(pair.baseToken.address, {
                name: pair.baseToken.name,
                symbol: pair.baseToken.symbol,
                priceNative: pair.priceNative,
                priceUsd: pair.priceUsd,
                address: pair.baseToken.address,
                fdv: pair.fdv || 0,
                mcap: pair.marketCap || pair.fdv || 0,
                liquidity: pair.liquidity?.usd || 0
             });
        }
    });

    // Sort by Liquidity (High liquidity = better swing candidates generally)
    return Array.from(candidates.values()).sort((a, b) => b.liquidity - a.liquidity);
  } catch (e) {
    console.error("Scanner Error:", e);
    return [];
  }
};
