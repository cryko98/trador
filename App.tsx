
import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, History as HistoryIcon, XCircle, Radar, Bot, Zap, BarChart3, TrendingUp, TrendingDown, Filter, RotateCcw, Power
} from 'lucide-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { fetchTokenData, fetchTrendingSolanaTokens } from './services/solanaService';
import { getTradorCommentary } from './services/geminiService';
import { executeJupiterSwap } from './services/jupiterService';
import { AppState, Trade, TokenMetadata, ActiveTokenState } from './types';

const INITIAL_SOL_BALANCE = 10;
const REFRESH_INTERVAL = 5000;
const AUTO_PILOT_INTERVAL = 12000; // Check for new tokens every 12s
const MAX_ACTIVE_TOKENS = 6;
const MCAP_HISTORY_LIMIT = 20;
const LOGO_URL = "https://wkkeyyrknmnynlcefugq.supabase.co/storage/v1/object/public/peng/trador.png";

const App: React.FC = () => {
  // Solana Wallet Hooks
  const { connection } = useConnection();
  const wallet = useWallet();

  const [caInput, setCaInput] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [autoMode, setAutoMode] = useState(true); // Auto-pilot on by default
  const [liveMode, setLiveMode] = useState(false); // Live Trading Switch
  const [scannerResults, setScannerResults] = useState<TokenMetadata[]>([]);
  
  // Trade Filter State
  const [tradeFilterSymbol, setTradeFilterSymbol] = useState('');
  const [tradeFilterType, setTradeFilterType] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('trador_multi_v1');
    const initial = saved ? JSON.parse(saved) : null;
    return {
      balance: initial?.balance ?? INITIAL_SOL_BALANCE,
      positions: initial?.positions ?? {},
      avgEntryPrices: initial?.avgEntryPrices ?? {},
      trades: initial?.trades ?? [],
      activeTokens: {},
      status: 'IDLE'
    };
  });
  
  const [inputError, setInputError] = useState('');
  const [systemMessage, setSystemMessage] = useState('');
  const stateRef = useRef(state);
  const walletRef = useRef(wallet);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { walletRef.current = wallet; }, [wallet]);

  // Persist balance and trade history (Sim mode only mostly, but keeps UI in sync)
  useEffect(() => {
    localStorage.setItem('trador_multi_v1', JSON.stringify({
      balance: state.balance,
      positions: state.positions,
      avgEntryPrices: state.avgEntryPrices,
      trades: state.trades
    }));
  }, [state.balance, state.positions, state.avgEntryPrices, state.trades]);

  // Unified Trade Handler (Sim & Live)
  const executeAndRecordTrade = async (type: Trade['type'], metadata: TokenMetadata, amount: number, solAmount: number, comment?: string) => {
    
    // LIVE MODE GUARD
    if (liveMode) {
        if (!walletRef.current.connected) {
            setSystemMessage("❌ Wallet not connected for Live Trade");
            setTimeout(() => setSystemMessage(''), 3000);
            return;
        }
        
        setSystemMessage(`⚠️ EXECUTING LIVE ${type} on ${metadata.symbol}...`);
        
        let result;
        if (type === 'BUY') {
            // Swap SOL -> Token
            result = await executeJupiterSwap(connection, walletRef.current, 'SOL', metadata.address, solAmount, true);
        } else {
            // Swap Token -> SOL (Selling `amount` of tokens)
            result = await executeJupiterSwap(connection, walletRef.current, metadata.address, 'SOL', amount, false);
        }

        if (result.error) {
            setSystemMessage(`❌ LIVE TRADE FAILED: ${result.error}`);
            setTimeout(() => setSystemMessage(''), 5000);
            return; // Stop local state update on failure
        }

        comment = `${comment} [TX: ${result.signature?.slice(0,6)}...]`;
        setSystemMessage(`✅ LIVE TRADE SUCCESS: ${result.signature?.slice(0,8)}`);
        setTimeout(() => setSystemMessage(''), 3000);
    }

    // LOCAL STATE UPDATE (Simulates logic or tracks live record)
    const id = Math.random().toString(36).substr(2, 9);
    const price = parseFloat(metadata.priceNative);
    
    let pnl: number | undefined = undefined;
    const currentAvgEntry = stateRef.current.avgEntryPrices[metadata.address] || price;

    if (type === 'SELL' || type === 'PARTIAL_SELL') {
      const entryValue = amount * currentAvgEntry;
      pnl = solAmount - entryValue;
    }

    const newTrade: Trade = {
      id, type, symbol: metadata.symbol, address: metadata.address,
      price, mcap: metadata.mcap, amount, solAmount, timestamp: Date.now(), pnl, comment
    };

    setState(prev => {
      const currentPos = prev.positions[metadata.address] || 0;
      let newAvgEntry = prev.avgEntryPrices[metadata.address] || 0;
      
      if (type === 'BUY') {
        const totalTokens = currentPos + amount;
        newAvgEntry = ((currentPos * newAvgEntry) + (amount * price)) / totalTokens;
      }

      // If Live mode, we don't update 'balance' variable based on calc, we should technically fetch it,
      // but for UI continuity we simulate the deduction so the charts look right.
      return {
        ...prev,
        trades: [newTrade, ...prev.trades].slice(0, 100),
        balance: type === 'BUY' ? prev.balance - solAmount : prev.balance + solAmount,
        positions: {
          ...prev.positions,
          [metadata.address]: type === 'BUY' ? currentPos + amount : Math.max(0, currentPos - amount)
        },
        avgEntryPrices: {
          ...prev.avgEntryPrices,
          [metadata.address]: type === 'BUY' ? newAvgEntry : (currentPos - amount <= 0 ? 0 : newAvgEntry)
        }
      };
    });
  };

  const resetAgent = () => {
    if (confirm("⚠️ SYSTEM RESET CONFIRMATION\n\n- Reset Balance to 10 SOL\n- Clear Trade History\n- Close All Positions\n\nAre you sure you want to restart?")) {
        const resetState: AppState = {
            balance: INITIAL_SOL_BALANCE,
            positions: {},
            avgEntryPrices: {},
            trades: [],
            activeTokens: {},
            status: 'IDLE'
        };
        setState(resetState);
        setScannerResults([]);
        localStorage.setItem('trador_multi_v1', JSON.stringify(resetState));
    }
  };

  const handleScanMarkets = async () => {
    setIsScanning(true);
    setScannerResults([]);
    const results = await fetchTrendingSolanaTokens();
    // Filter out already active tokens
    const newResults = results.filter(t => !stateRef.current.activeTokens[t.address]);
    setScannerResults(newResults);
    setIsScanning(false);
    return newResults;
  };

  const deployToken = async (targetCa: string) => {
    if (!targetCa || targetCa.trim().length < 32) {
      if (!autoMode) {
        setInputError('Invalid CA');
        setTimeout(() => setInputError(''), 3000);
      }
      return;
    }
    // Use ref to check current state to prevent race conditions in auto mode
    if (stateRef.current.activeTokens[targetCa]) return;

    // Check if we have metadata from scanner first to avoid extra fetch
    const preloaded = scannerResults.find(t => t.address === targetCa);
    // Fix: Explicitly type data to allow null assignment from fetchTokenData
    let data: TokenMetadata | null | undefined = preloaded;

    if (!data) {
        data = await fetchTokenData(targetCa);
    }

    if (!data) {
      if (!autoMode) {
        setInputError('Token not found');
        setTimeout(() => setInputError(''), 3000);
      }
      return;
    }

    setState(prev => ({
      ...prev,
      status: 'TRADING',
      activeTokens: {
        ...prev.activeTokens,
        [targetCa]: {
          metadata: data!,
          currentPrice: parseFloat(data!.priceNative),
          currentMcap: data!.mcap,
          mcapHistory: [data!.mcap],
          message: "Initiating tactical monitoring...",
          sentiment: 'NEUTRAL',
          isAiLoading: false
        }
      }
    }));
    setCaInput('');
    setScannerResults(prev => prev.filter(t => t.address !== targetCa)); // Remove from scanner list
    if (!autoMode) setInputError('');
  };

  const removeToken = (address: string) => {
    setState(prev => {
      const newActive = { ...prev.activeTokens };
      delete newActive[address];
      return {
        ...prev,
        activeTokens: newActive,
        status: Object.keys(newActive).length > 0 ? 'TRADING' : 'IDLE'
      };
    });
  };

  // --- AUTO PILOT ENGINE ---
  useEffect(() => {
    if (!autoMode) return;

    const runAutoPilot = async () => {
      const currentActiveCount = Object.keys(stateRef.current.activeTokens).length;
      
      // Only deploy new tokens if we have space
      if (currentActiveCount < MAX_ACTIVE_TOKENS) {
        const candidates = await fetchTrendingSolanaTokens();
        const available = candidates.filter(c => !stateRef.current.activeTokens[c.address]);

        // Scoring Logic
        const scoredCandidates = available.map(token => {
           let score = 0;
           const p1h = token.priceChange1h || 0;
           if (p1h > 0 && p1h < 15) score += 35;       
           else if (p1h >= 15 && p1h < 50) score += 20; 
           else if (p1h >= 50) score -= 10;
           else if (p1h >= -5 && p1h <= 0) score += 10;
           else if (p1h < -5) score -= 50;

           const buys = token.txns24h?.buys || 0;
           const sells = token.txns24h?.sells || 0;
           const total = buys + sells;
           const buyRatio = total > 0 ? buys / total : 0.5;
           
           if (buyRatio > 0.60) score += 30;      
           else if (buyRatio > 0.50) score += 10; 
           else score -= 10; 

           const age = token.ageHours || 0.1; 
           if (age < 24) score += 25;       
           else if (age < 72) score += 10;

           return { token, score };
        });

        scoredCandidates.sort((a, b) => b.score - a.score);
        const bestMatch = scoredCandidates[0];
        
        if (bestMatch && bestMatch.score > -20) {
          await deployToken(bestMatch.token.address);
        }
      }
    };

    runAutoPilot();
    const interval = setInterval(runAutoPilot, AUTO_PILOT_INTERVAL);
    return () => clearInterval(interval);
  }, [autoMode]); 


  // --- TRADING ENGINE ---
  useEffect(() => {
    if (state.status !== 'TRADING') return;

    const interval = setInterval(async () => {
      const tokens = Object.keys(stateRef.current.activeTokens);
      if (tokens.length === 0) return;

      for (const addr of tokens) {
        const data = await fetchTokenData(addr);
        if (!data) continue;

        const activeToken = stateRef.current.activeTokens[addr];
        const currentPrice = parseFloat(data.priceNative);
        const history = [...activeToken.mcapHistory, data.mcap].slice(-MCAP_HISTORY_LIMIT);
        
        const currentPos = stateRef.current.positions[addr] || 0;
        const avgEntry = stateRef.current.avgEntryPrices[addr] || 0;
        const profitPct = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0;
        const shortTermDelta = history.length > 3 ? ((data.mcap - history[history.length - 3]) / history[history.length - 3]) * 100 : 0;

        let isBuying = false;
        let isSelling = false;

        // BUY LOGIC
        if (currentPos === 0 && shortTermDelta > 0.6) {
           // Check balance in ref to avoid staleness
           const balance = stateRef.current.balance;
           if (balance > 0.5) {
             const buySize = Math.min(balance * 0.2, 2.0); // Uses local balance for sizing
             await executeAndRecordTrade('BUY', data, buySize / currentPrice, buySize, "Momentum ignition detected.");
             isBuying = true;
           }
        }

        // SELL LOGIC
        if (currentPos > 0) {
          const hasScaled = stateRef.current.trades.some(t => t.address === addr && t.type === 'PARTIAL_SELL');
          
          if (profitPct >= 15 && !hasScaled) {
            const sellAmt = currentPos * 0.5;
            await executeAndRecordTrade('PARTIAL_SELL', data, sellAmt, sellAmt * currentPrice, "Initial target reached. Securing 50%.");
            isSelling = true;
          } else if (profitPct >= 35 || (hasScaled && shortTermDelta < -2.5)) {
            await executeAndRecordTrade('SELL', data, currentPos, currentPos * currentPrice, "Position fully realized.");
            isSelling = true;
          } else if (profitPct <= -8.0) {
            await executeAndRecordTrade('SELL', data, currentPos, currentPos * currentPrice, "Stop loss execution.");
            isSelling = true;
          }
        }

        // Update individual token state
        setState(prev => ({
          ...prev,
          activeTokens: {
            ...prev.activeTokens,
            [addr]: {
              ...prev.activeTokens[addr],
              currentPrice,
              currentMcap: data.mcap,
              mcapHistory: history
            }
          }
        }));

        // Occasional AI Update
        if (Math.random() > 0.85 || isBuying || isSelling) {
          updateAiCommentary(addr, data, history, isBuying, isSelling);
        }
      }
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [state.status, liveMode]); // Trigger re-bind if liveMode changes

  const updateAiCommentary = async (addr: string, data: TokenMetadata, history: number[], isBuying: boolean, isSelling: boolean) => {
    const aiResponse = await getTradorCommentary(data.symbol, history, isBuying, isSelling, stateRef.current.balance);
    setState(prev => {
      if (!prev.activeTokens[addr]) return prev;
      return {
        ...prev,
        activeTokens: {
          ...prev.activeTokens,
          [addr]: {
            ...prev.activeTokens[addr],
            message: aiResponse.text,
            sentiment: aiResponse.sentiment
          }
        }
      };
    });
  };

  const totalPnl: number = state.trades.reduce((acc: number, t: Trade) => acc + (t.pnl || 0), 0);
  const activeCount = Object.keys(state.activeTokens).length;

  const formattedMcap = (m: number) => {
    if (m >= 1000000) return `$${(m / 1000000).toFixed(2)}M`;
    if (m >= 1000) return `$${(m / 1000).toFixed(2)}K`;
    return `$${m.toFixed(0)}`;
  };
  
  const formattedVol = (v: number) => {
     if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
     if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
     return `$${v.toFixed(0)}`;
  };

  const formattedChange = (c: number) => {
    return `${c > 0 ? '+' : ''}${c.toFixed(2)}%`;
  };

  const formatPrice = (p: number) => {
    if (p < 0.000001) return p.toExponential(2);
    if (p < 0.001) return p.toFixed(6);
    return p.toFixed(4);
  };

  const filteredTrades = state.trades.filter(t => {
    const matchesSymbol = t.symbol.toLowerCase().includes(tradeFilterSymbol.toLowerCase());
    const matchesType = tradeFilterType === 'ALL' 
      ? true 
      : tradeFilterType === 'BUY' 
        ? t.type === 'BUY' 
        : (t.type === 'SELL' || t.type === 'PARTIAL_SELL');
    return matchesSymbol && matchesType;
  });

  return (
    <div className="h-screen flex flex-col bg-[#010409] text-slate-200 selection:bg-[#00FFA3] selection:text-black mono overflow-hidden relative">
      
      {/* Messages / Toasts */}
      {(inputError || systemMessage) && (
        <div className="fixed top-20 right-6 z-50 animate-bounce">
           <div className={`
              px-4 py-2 rounded shadow-lg text-xs font-mono flex items-center gap-2
              ${systemMessage.includes('SUCCESS') ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200' : 'bg-rose-950/90 border border-rose-500 text-rose-200'}
           `}>
              {systemMessage.includes('SUCCESS') ? <Zap size={14} /> : <XCircle size={14} />}
              {inputError || systemMessage}
           </div>
        </div>
      )}

      {/* Dynamic Navigation */}
      <nav className="h-16 border-b border-slate-800/60 bg-[#0d1117]/95 backdrop-blur-xl flex items-center justify-between px-3 md:px-6 z-50 shrink-0">
        <div className="flex items-center gap-2 md:gap-4">
          <div className="flex items-center gap-2">
            <img src={LOGO_URL} alt="Trador" className="w-8 h-8 object-contain" />
            <div className="flex flex-col">
              <span className="text-sm md:text-md font-black tracking-tighter neon-text leading-none uppercase">Trador<span className="hidden sm:inline"> Multi-Grid</span></span>
              <span className="text-[7px] text-[#00FFA3] font-bold tracking-[0.3em] uppercase hidden sm:block">Sovereign Cluster</span>
            </div>
          </div>
          
          <div className="h-4 w-[1px] bg-slate-800 hidden md:block"></div>
          
          {/* Mode Toggles */}
          <div className="flex items-center gap-2">
            <button 
                onClick={() => setAutoMode(!autoMode)}
                className={`flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-lg border transition-all text-[9px] md:text-[10px] font-bold uppercase tracking-wider ${
                autoMode 
                    ? 'bg-[#00FFA3]/10 border-[#00FFA3] text-[#00FFA3]' 
                    : 'bg-slate-900 border-slate-800 text-slate-500'
                }`}
            >
                <Bot size={12} className={autoMode ? "animate-pulse" : ""} />
                <span className="hidden md:inline">Auto</span>
            </button>

            <button 
                onClick={() => setLiveMode(!liveMode)}
                className={`flex items-center gap-1.5 px-2 md:px-3 py-1.5 rounded-lg border transition-all text-[9px] md:text-[10px] font-bold uppercase tracking-wider ${
                liveMode 
                    ? 'bg-rose-500/20 border-rose-500 text-rose-500 animate-pulse' 
                    : 'bg-slate-900 border-slate-800 text-slate-500'
                }`}
            >
                <Power size={12} />
                <span>{liveMode ? 'LIVE' : 'SIM'}</span>
            </button>
          </div>

          <div className="relative group hidden md:flex items-center ml-2">
            <Search className="absolute left-3 text-slate-500" size={14} />
            <input 
              type="text" 
              value={caInput}
              onChange={(e) => setCaInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && deployToken(caInput)}
              placeholder="Deploy Manually..."
              className="bg-black/50 border border-slate-800 rounded-lg py-1.5 pl-9 pr-3 text-[10px] w-48 lg:w-64 outline-none focus:border-[#00FFA3] transition-all"
            />
          </div>
          
          <button 
            onClick={handleScanMarkets} 
            disabled={isScanning}
            className="hidden md:flex items-center gap-2 bg-slate-900 border border-slate-800 hover:border-[#00FFA3] text-slate-400 hover:text-[#00FFA3] px-3 py-1.5 rounded-lg transition-all text-[10px] font-bold uppercase tracking-wider"
          >
             <Radar size={12} className={isScanning ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="flex items-center gap-2 md:gap-4">
          <div className="flex flex-col items-end hidden sm:flex">
            <span className="text-[8px] text-slate-500 font-black uppercase">Cluster PNL</span>
            <span className={`text-[10px] md:text-xs font-black ${(totalPnl as number) >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
              {(totalPnl as number) >= 0 ? '+' : ''}{(totalPnl as number).toFixed(4)} <span className="hidden sm:inline">SOL</span>
            </span>
          </div>
          
          {/* Wallet Connect */}
          <div className="wallet-adapter-wrapper scale-90 md:scale-100">
             <WalletMultiButton style={{ 
                 backgroundColor: liveMode ? '#9f1239' : '#0f172a', 
                 height: '32px', 
                 fontSize: '10px', 
                 fontFamily: 'JetBrains Mono',
                 borderRadius: '0.5rem',
                 border: '1px solid #334155'
             }} />
          </div>

           {/* Reset Button */}
           <button 
              onClick={resetAgent}
              className="bg-slate-900/50 hover:bg-rose-950/30 border border-slate-900 hover:border-rose-900 text-slate-500 hover:text-rose-500 p-1.5 md:p-2 rounded-lg transition-all"
              title="Reset System Agent"
          >
              <RotateCcw size={14} />
          </button>
        </div>
      </nav>

      {/* Grid Content */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left: Global Stats - Hidden on Mobile/Tablet */}
        <aside className="w-64 border-r border-slate-800/60 bg-[#0d1117]/60 flex flex-col hidden lg:flex">
          <div className="p-4 border-b border-slate-800/60">
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Active Exposure</span>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
            {Object.entries(state.positions).filter(([_, amt]) => (amt as number) > 0).map(([addr, amount]) => (
              <div key={addr} className="mb-2 p-3 bg-slate-900/40 rounded border border-slate-800/50">
                <div className="flex justify-between text-[10px] font-black mb-1">
                  <span className="text-[#00FFA3]">{addr.slice(0, 4)}...{addr.slice(-4)}</span>
                </div>
                <div className="text-[11px] text-white font-bold">{(amount as number).toLocaleString()} tokens</div>
              </div>
            ))}
          </div>
          
          <div className="p-4 border-t border-slate-800/60 bg-black/20">
             <div className="flex items-center justify-between mb-3">
               <div className="flex items-center gap-2">
                 <HistoryIcon size={12} className="text-[#00FFA3]" />
                 <span className="text-[9px] font-black text-slate-500 uppercase">Global Fills</span>
               </div>
             </div>
             
             {/* Filter Controls */}
             <div className="flex flex-col gap-2 mb-3">
               <div className="relative">
                 <Filter size={10} className="absolute left-2 top-1.5 text-slate-500" />
                 <input 
                   type="text" 
                   placeholder="Filter Symbol..." 
                   value={tradeFilterSymbol}
                   onChange={(e) => setTradeFilterSymbol(e.target.value)}
                   className="w-full bg-slate-900/50 border border-slate-800 rounded px-2 py-1 pl-6 text-[9px] text-white focus:border-[#00FFA3] outline-none placeholder:text-slate-600"
                 />
               </div>
               <div className="flex gap-1">
                 {['ALL', 'BUY', 'SELL'].map(type => (
                   <button
                     key={type}
                     onClick={() => setTradeFilterType(type as any)}
                     className={`flex-1 py-1 text-[8px] font-bold uppercase rounded border transition-colors ${
                       tradeFilterType === type 
                         ? 'bg-[#00FFA3]/20 border-[#00FFA3] text-[#00FFA3]' 
                         : 'bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-400'
                     }`}
                   >
                     {type}
                   </button>
                 ))}
               </div>
             </div>

             <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
               {filteredTrades.slice(0, 20).map(t => (
                 <div key={t.id} className="text-[9px] flex justify-between border-b border-slate-800/30 pb-1">
                   <span className={t.type === 'BUY' ? 'text-[#00FFA3]' : 'text-rose-500'}>{t.type === 'PARTIAL_SELL' ? 'SCALE' : t.type} {t.symbol}</span>
                   <span className="text-slate-600 font-mono">{t.solAmount.toFixed(2)}</span>
                 </div>
               ))}
               {filteredTrades.length === 0 && (
                   <div className="text-[9px] text-slate-600 text-center py-2 italic">No fills found</div>
               )}
             </div>
          </div>
        </aside>

        {/* Main Workspace */}
        <main className="flex-1 overflow-hidden flex flex-col relative bg-black">
          {activeCount === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 text-center relative overflow-hidden">
               {/* Background Grid Animation */}
               <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10"></div>
               
               <div className="relative z-10 max-w-2xl w-full">
                 <div className="mb-8 flex flex-col items-center">
                   <img src={LOGO_URL} alt="Trador" className="w-16 h-16 md:w-20 md:h-20 mb-6 opacity-80" />
                   {autoMode ? (
                     <>
                      <h2 className="text-2xl md:text-3xl font-black italic tracking-tighter text-[#00FFA3] uppercase neon-text animate-pulse">Auto-Pilot Engaged</h2>
                      <p className="text-[8px] md:text-[10px] text-slate-500 mt-2 uppercase tracking-[0.3em]">Acquiring High-Grade Swing Targets...</p>
                      {liveMode && <p className="text-[8px] md:text-[10px] text-rose-500 font-bold mt-2 uppercase tracking-[0.3em] border border-rose-900/50 bg-rose-950/20 px-2 py-1 rounded">⚠️ LIVE TRADING ENABLED - REAL SOLANA IN USE</p>}
                     </>
                   ) : (
                     <>
                      <h2 className="text-2xl md:text-3xl font-black italic tracking-tighter text-white uppercase neon-text">System Idle</h2>
                      <p className="text-[8px] md:text-[10px] text-slate-500 mt-2 uppercase tracking-[0.3em]">Deploy Contracts or Enable Auto-Pilot</p>
                     </>
                   )}
                 </div>

                 {/* Scanner Module */}
                 <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden shadow-2xl min-w-[280px] md:min-w-[320px]">
                    <div className="h-10 bg-slate-900/50 border-b border-slate-800 flex items-center justify-between px-4">
                      <div className="flex items-center gap-2 text-[#00FFA3]">
                         <Radar size={14} className={isScanning ? "animate-spin" : ""} />
                         <span className="text-[10px] font-black uppercase tracking-widest">Smart Swing Scan</span>
                      </div>
                      <button onClick={handleScanMarkets} className="text-slate-500 hover:text-white transition-colors">
                        <Radar size={12} className={isScanning ? "animate-spin" : ""} />
                      </button>
                    </div>

                    <div className="p-4 min-h-[200px] max-h-[300px] overflow-y-auto custom-scrollbar">
                      {isScanning ? (
                        <div className="flex flex-col items-center justify-center h-40 gap-3">
                          <div className="w-8 h-8 border-2 border-[#00FFA3] border-t-transparent rounded-full animate-spin"></div>
                          <span className="text-[10px] text-slate-500 uppercase animate-pulse">Filtering Noise...</span>
                        </div>
                      ) : scannerResults.length > 0 ? (
                        <div className="grid grid-cols-1 gap-2">
                           {scannerResults.map(token => (
                             <div key={token.address} className="bg-black/40 border border-slate-800 hover:border-[#00FFA3] p-2 rounded group transition-all flex justify-between items-center cursor-pointer" onClick={() => deployToken(token.address)}>
                                <div className="flex items-center gap-3">
                                  <img 
                                    src={`https://dd.dexscreener.com/ds-data/tokens/solana/${token.address}.png`} 
                                    onError={(e) => e.currentTarget.src = LOGO_URL}
                                    className="w-8 h-8 rounded-full bg-slate-900" 
                                    alt={token.symbol}
                                  />
                                  <div className="flex flex-col text-left">
                                    <span className="text-xs font-black text-white">{token.symbol}</span>
                                    <div className="flex gap-2">
                                        <span className="text-[9px] text-slate-500">{formattedMcap(token.mcap)} MCAP</span>
                                    </div>
                                  </div>
                                </div>
                                <div className="flex flex-col items-end">
                                    <div className="flex items-center gap-2">
                                      <div className={`flex items-center gap-1 ${token.priceChange24h >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                                          {token.priceChange24h >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                                          <span className="text-[10px] font-black">{formattedChange(token.priceChange24h)}</span>
                                      </div>
                                      <div className="flex items-center gap-1 text-slate-400">
                                          <BarChart3 size={10} />
                                          <span className="text-[10px] font-bold">{formattedVol(token.volume24h)}</span>
                                      </div>
                                    </div>
                                </div>
                             </div>
                           ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-40 text-slate-600">
                          <p className="text-[10px] uppercase tracking-wider mb-4">
                            {autoMode ? "Scanning..." : "No Quality Targets"}
                          </p>
                        </div>
                      )}
                    </div>
                 </div>
               </div>
            </div>
          ) : (
            <div className={`grid h-full w-full gap-px bg-slate-800/40 ${
              activeCount === 1 ? 'grid-cols-1' : 
              activeCount <= 4 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
            }`}>
              {(Object.values(state.activeTokens) as ActiveTokenState[]).map((token) => {
                const pos = state.positions[token.metadata.address] || 0;
                const avg = state.avgEntryPrices[token.metadata.address] || 0;
                const profit = avg > 0 ? ((token.currentPrice - avg) / avg) * 100 : 0;
                
                // Calculate Buy Ratio
                const buys = token.metadata.txns24h?.buys || 0;
                const sells = token.metadata.txns24h?.sells || 0;
                const totalTxns = buys + sells;
                const buyRatio = totalTxns > 0 ? (buys / totalTxns) * 100 : 50;

                // Filter execution history for this token
                const tokenTrades = state.trades
                  .filter(t => t.address === token.metadata.address)
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .slice(0, 5);

                return (
                  <div key={token.metadata.address} className="bg-[#010409] flex flex-col relative group">
                    {/* Grid Cell Header */}
                    <div className="h-10 border-b border-slate-800/40 bg-[#0d1117]/40 flex items-center justify-between px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-black text-white">{token.metadata.symbol}</span>
                        <span className="text-[8px] text-[#00FFA3] font-black">{formattedMcap(token.currentMcap)}</span>
                         <span className={`text-[8px] flex items-center gap-0.5 border-l border-slate-700 pl-2 ml-1 ${token.metadata.priceChange24h >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                            {token.metadata.priceChange24h >= 0 ? <TrendingUp size={8} /> : <TrendingDown size={8} />}
                            {formattedChange(token.metadata.priceChange24h)}
                         </span>
                         {/* Pressure Bar */}
                         <div className="flex flex-col gap-0.5 ml-2">
                           <div className="flex items-center justify-between text-[6px] font-black uppercase tracking-wider text-slate-500 w-12">
                             <span className="text-[#00FFA3]">B</span>
                             <span className="text-rose-500">S</span>
                           </div>
                           <div className="w-12 h-1 bg-rose-900/50 rounded-full overflow-hidden flex">
                             <div 
                               className="h-full bg-[#00FFA3]" 
                               style={{ width: `${buyRatio}%` }} 
                             />
                           </div>
                         </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {pos > 0 && (
                          <span className={`text-[10px] font-black mono ${profit >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                            {profit >= 0 ? '+' : ''}{profit.toFixed(1)}%
                          </span>
                        )}
                        <button onClick={() => removeToken(token.metadata.address)} className="text-slate-600 hover:text-rose-500 transition-colors">
                          <XCircle size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Iframe Chart */}
                    <div className="flex-1 bg-black relative overflow-hidden">
                      <iframe 
                        src={`https://dexscreener.com/solana/${token.metadata.address}?embed=1&theme=dark&trades=0&info=0`}
                        className="w-full h-full border-none opacity-80"
                        title={token.metadata.symbol}
                      />
                      
                      {/* Trade Execution Overlay (New) */}
                      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 items-end pointer-events-none">
                        {tokenTrades.map(trade => (
                          <div key={trade.id} className={`
                            flex items-center gap-2 px-2 py-1 rounded-md border backdrop-blur-md shadow-lg
                            ${trade.type === 'BUY' 
                              ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-400' 
                              : 'bg-rose-950/80 border-rose-500/50 text-rose-400'}
                            animate-in slide-in-from-right-8 fade-in duration-300
                          `}>
                            <div className={`w-1.5 h-1.5 rounded-full ${trade.type === 'BUY' ? 'bg-emerald-400' : 'bg-rose-400'} shadow-[0_0_5px_currentColor]`} />
                            <div className="flex flex-col items-end leading-none">
                               <span className="text-[9px] font-black uppercase tracking-wider">
                                 {trade.type === 'PARTIAL_SELL' ? 'SCALE' : trade.type}
                               </span>
                               <span className="text-[9px] font-mono opacity-80">
                                 @{formatPrice(trade.price)}
                               </span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Individual Token HUD */}
                      <div className="absolute bottom-2 left-2 right-2 pointer-events-none">
                        <div className="bg-[#00FFA3] text-black p-2 rounded shadow-lg border border-white/20 pointer-events-auto">
                           <div className="flex justify-between items-center mb-1">
                             <div className="flex items-center gap-1">
                                <Zap size={8} className="text-black fill-black" />
                                <span className="text-[7px] font-black uppercase tracking-widest bg-black text-[#00FFA3] px-1 rounded">Trador AI</span>
                             </div>
                             <div className="flex gap-0.5">
                               {[1,2,3].map(i => <div key={i} className="w-1 h-1 bg-black/30 rounded-full animate-pulse"></div>)}
                             </div>
                           </div>
                           <p className="text-[9px] font-black italic leading-tight truncate">"{token.message}"</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      <footer className="h-8 border-t border-slate-800/60 bg-[#0d1117] flex items-center justify-between px-6 text-[8px] font-black text-slate-500 tracking-[0.2em] uppercase shrink-0">
        <div className="flex gap-6">
          <span className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full shadow-[0_0_5px] ${liveMode ? 'bg-rose-500 shadow-rose-500 animate-pulse' : autoMode ? 'bg-[#00FFA3] shadow-[#00FFA3]' : 'bg-slate-500'}`}></div> 
            Cluster {liveMode ? 'LIVE' : (autoMode ? 'Autonomous' : 'Manual')}
          </span>
          <span className="hidden sm:inline">Latency: 22ms</span>
        </div>
        <span>Trador Grid Protocol © 2025</span>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #00FFA3; }
        @keyframes float {
          0% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
          100% { transform: translateY(0px); }
        }
        .neon-text { text-shadow: 0 0 10px rgba(0, 255, 163, 0.4); }
      `}</style>
    </div>
  );
};

export default App;
