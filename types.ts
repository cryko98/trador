
export interface PricePoint {
  time: number;
  price: number;
}

export interface Trade {
  id: string;
  type: 'BUY' | 'SELL' | 'PARTIAL_SELL';
  symbol: string;
  address: string;
  price: number;
  mcap: number;
  amount: number;
  solAmount: number;
  timestamp: number;
  pnl?: number;
  comment?: string;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  priceNative: string;
  priceUsd: string;
  address: string;
  fdv: number;
  mcap: number;
  liquidity: number;
  volume24h: number;
  priceChange24h: number;
  priceChange1h?: number;
  ageHours?: number;
  txns24h: { buys: number; sells: number };
}

export interface ActiveTokenState {
  metadata: TokenMetadata;
  currentPrice: number;
  currentMcap: number;
  mcapHistory: number[];
  message: string;
  sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  isAiLoading: boolean;
}

export interface AppState {
  balance: number;
  positions: { [address: string]: number };
  avgEntryPrices: { [address: string]: number };
  trades: Trade[];
  activeTokens: { [address: string]: ActiveTokenState };
  status: 'IDLE' | 'TRADING' | 'WAITING';
}
