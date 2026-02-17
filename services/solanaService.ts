
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
