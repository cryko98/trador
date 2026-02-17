
import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, Wallet, History as HistoryIcon, XCircle, Radar, RefreshCw, PlusCircle, Bot, Zap
} from 'lucide-react';
import { fetchTokenData, fetchTrendingSolanaTokens } from './services/solanaService';
import { getTradorCommentary } from './services/geminiService';
import { AppState, Trade, TokenMetadata, ActiveTokenState } from './types';

const INITIAL_SOL_BALANCE = 10;
const REFRESH_INTERVAL = 5000;
const AUTO_PILOT_INTERVAL = 12000; // Check for new tokens every 12s
const MAX_ACTIVE_TOKENS = 6;
const MCAP_HISTORY_LIMIT = 20;
const LOGO_URL = "https://wkkeyyrknmnynlcefugq.supabase.co/storage/v1/object/public/peng/trador.png";

const App: React.FC = () => {
  const [caInput, setCaInput] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [autoMode, setAutoMode] = useState(true); // Auto-pilot on by default
  const [scannerResults, setScannerResults] = useState<TokenMetadata[]>([]);
  
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
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Persist balance and trade history
  useEffect(() => {
    localStorage.setItem('trador_multi_v1', JSON.stringify({
      balance: state.balance,
      positions: state.positions,
      avgEntryPrices: state.avgEntryPrices,
      trades: state.trades
    }));
  }, [state.balance, state.positions, state.avgEntryPrices, state.trades]);

  const addTrade = (type: Trade['type'], metadata: TokenMetadata, amount: number, solAmount: number, comment?: string) => {
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
    let data = preloaded;

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
        // console.log("Auto-Pilot: Scanning for targets...");
        const candidates = await fetchTrendingSolanaTokens();
        
        // Find the best candidate that is NOT already active
        const bestCandidate = candidates.find(c => !stateRef.current.activeTokens[c.address]);
        
        if (bestCandidate) {
          // console.log(`Auto-Pilot: Deploying ${bestCandidate.symbol}`);
          await deployToken(bestCandidate.address);
        }
      }
    };

    // Initial run
    runAutoPilot();

    const interval = setInterval(runAutoPilot, AUTO_PILOT_INTERVAL);
    return () => clearInterval(interval);
  }, [autoMode]); 
  // Dependency is only autoMode. We use stateRef inside to get fresh state without re-triggering the effect.


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

        // Shared capital management: Only use 20% of remaining balance per trade
        if (currentPos === 0 && shortTermDelta > 0.6 && stateRef.current.balance > 0.5) {
          const buySize = Math.min(stateRef.current.balance * 0.2, 2.0);
          addTrade('BUY', data, buySize / currentPrice, buySize, "Momentum ignition detected.");
          isBuying = true;
        }

        if (currentPos > 0) {
          const hasScaled = stateRef.current.trades.some(t => t.address === addr && t.type === 'PARTIAL_SELL');
          
          if (profitPct >= 15 && !hasScaled) {
            const sellAmt = currentPos * 0.5;
            addTrade('PARTIAL_SELL', data, sellAmt, sellAmt * currentPrice, "Initial target reached. Securing 50%.");
            isSelling = true;
          } else if (profitPct >= 35 || (hasScaled && shortTermDelta < -2.5)) {
            addTrade('SELL', data, currentPos, currentPos * currentPrice, "Position fully realized.");
            isSelling = true;
          } else if (profitPct <= -8.0) {
            addTrade('SELL', data, currentPos, currentPos * currentPrice, "Stop loss execution.");
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
  }, [state.status]);

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

  // Explicitly type totalPnl to prevent 'unknown' inference and fix operator issues
  const totalPnl: number = state.trades.reduce((acc: number, t: Trade) => acc + (t.pnl || 0), 0);
  const activeCount = Object.keys(state.activeTokens).length;

  const formattedMcap = (m: number) => {
    if (m >= 1000000) return `$${(m / 1000000).toFixed(2)}M`;
    if (m >= 1000) return `$${(m / 1000).toFixed(2)}K`;
    return `$${m.toFixed(0)}`;
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#010409] text-slate-200 selection:bg-[#00FFA3] selection:text-black mono overflow-hidden relative">
      
      {/* Error Toast */}
      {inputError && (
        <div className="fixed top-20 right-6 z-50 animate-bounce">
           <div className="bg-rose-950/90 border border-rose-500 text-rose-200 px-4 py-2 rounded shadow-lg text-xs font-mono flex items-center gap-2">
              <XCircle size={14} />
              {inputError}
           </div>
        </div>
      )}

      {/* Dynamic Navigation */}
      <nav className="h-16 border-b border-slate-800/60 bg-[#0d1117]/95 backdrop-blur-xl flex items-center justify-between px-6 z-50">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <img src={LOGO_URL} alt="Trador" className="w-8 h-8 object-contain" />
            <div className="flex flex-col">
              <span className="text-md font-black tracking-tighter neon-text leading-none uppercase">Trador Multi-Grid</span>
              <span className="text-[7px] text-[#00FFA3] font-bold tracking-[0.3em] uppercase">Sovereign Cluster</span>
            </div>
          </div>
          
          <div className="h-4 w-[1px] bg-slate-800 hidden md:block"></div>
          
          {/* Auto Pilot Toggle */}
          <button 
            onClick={() => setAutoMode(!autoMode)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all text-[10px] font-bold uppercase tracking-wider ${
              autoMode 
                ? 'bg-[#00FFA3]/10 border-[#00FFA3] text-[#00FFA3]' 
                : 'bg-slate-900 border-slate-800 text-slate-500'
            }`}
          >
            <Bot size={14} className={autoMode ? "animate-pulse" : ""} />
            <span className="hidden md:inline">Auto-Pilot: {autoMode ? 'ON' : 'OFF'}</span>
          </button>

          <div className="relative group hidden md:flex items-center">
            <Search className="absolute left-3 text-slate-500" size={14} />
            <input 
              type="text" 
              value={caInput}
              onChange={(e) => setCaInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && deployToken(caInput)}
              placeholder="Deploy Manually..."
              className="bg-black/50 border border-slate-800 rounded-lg py-1.5 pl-9 pr-3 text-[10px] w-64 outline-none focus:border-[#00FFA3] transition-all"
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

        <div className="flex items-center gap-8">
          <div className="flex flex-col items-end">
            <span className="text-[8px] text-slate-500 font-black uppercase">Cluster PNL</span>
            <span className={`text-xs font-black ${(totalPnl as number) >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
              {(totalPnl as number) >= 0 ? '+' : ''}{(totalPnl as number).toFixed(4)} SOL
            </span>
          </div>
          <div className="bg-slate-900 border border-slate-800 px-4 py-2 rounded-lg flex items-center gap-3">
            <Wallet size={14} className="text-[#00FFA3]" />
            <span className="text-xs font-black text-[#00FFA3]">{(state.balance as number).toFixed(3)} SOL</span>
          </div>
        </div>
      </nav>

      {/* Grid Content */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left: Global Stats */}
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
             <div className="flex items-center gap-2 mb-3">
               <HistoryIcon size={12} className="text-[#00FFA3]" />
               <span className="text-[9px] font-black text-slate-500 uppercase">Recent Global Fills</span>
             </div>
             <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
               {state.trades.slice(0, 10).map(t => (
                 <div key={t.id} className="text-[9px] flex justify-between border-b border-slate-800/30 pb-1">
                   <span className={t.type === 'BUY' ? 'text-[#00FFA3]' : 'text-rose-500'}>{t.type} {t.symbol}</span>
                   <span className="text-slate-600 font-mono">{t.solAmount.toFixed(2)}</span>
                 </div>
               ))}
             </div>
          </div>
        </aside>

        {/* Main Workspace */}
        <main className="flex-1 overflow-hidden flex flex-col relative bg-black">
          {activeCount === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center relative overflow-hidden">
               {/* Background Grid Animation */}
               <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10"></div>
               
               <div className="relative z-10 max-w-2xl w-full">
                 <div className="mb-8 flex flex-col items-center">
                   <img src={LOGO_URL} alt="Trador" className="w-20 h-20 mb-6 opacity-80" />
                   {autoMode ? (
                     <>
                      <h2 className="text-3xl font-black italic tracking-tighter text-[#00FFA3] uppercase neon-text animate-pulse">Auto-Pilot Engaged</h2>
                      <p className="text-[10px] text-slate-500 mt-2 uppercase tracking-[0.3em]">Acquiring High-Liquid Targets...</p>
                     </>
                   ) : (
                     <>
                      <h2 className="text-3xl font-black italic tracking-tighter text-white uppercase neon-text">System Idle</h2>
                      <p className="text-[10px] text-slate-500 mt-2 uppercase tracking-[0.3em]">Deploy Contracts or Enable Auto-Pilot</p>
                     </>
                   )}
                 </div>

                 {/* Scanner Module - Always visible but functional manually */}
                 <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden shadow-2xl opacity-60 hover:opacity-100 transition-opacity">
                    <div className="h-10 bg-slate-900/50 border-b border-slate-800 flex items-center justify-between px-4">
                      <div className="flex items-center gap-2 text-[#00FFA3]">
                         <Radar size={14} className={isScanning ? "animate-spin" : ""} />
                         <span className="text-[10px] font-black uppercase tracking-widest">Global Market Scan</span>
                      </div>
                    </div>

                    <div className="p-4 min-h-[100px] max-h-[200px] overflow-y-auto custom-scrollbar flex items-center justify-center">
                         <div className="text-[10px] text-slate-600 uppercase tracking-wider flex items-center gap-2">
                            {autoMode && <div className="w-2 h-2 bg-[#00FFA3] rounded-full animate-ping"></div>}
                            {autoMode ? "Continuous Scanning Active" : "Waiting for manual scan"}
                         </div>
                    </div>
                 </div>
               </div>
            </div>
          ) : (
            <div className={`grid h-full w-full gap-px bg-slate-800/40 ${
              activeCount === 1 ? 'grid-cols-1' : 
              activeCount === 2 ? 'grid-cols-1 md:grid-cols-2' : 
              activeCount <= 4 ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'
            }`}>
              {(Object.values(state.activeTokens) as ActiveTokenState[]).map((token) => {
                const pos = state.positions[token.metadata.address] || 0;
                const avg = state.avgEntryPrices[token.metadata.address] || 0;
                const profit = avg > 0 ? ((token.currentPrice - avg) / avg) * 100 : 0;
                
                return (
                  <div key={token.metadata.address} className="bg-[#010409] flex flex-col relative group">
                    {/* Grid Cell Header */}
                    <div className="h-10 border-b border-slate-800/40 bg-[#0d1117]/40 flex items-center justify-between px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-black text-white">{token.metadata.symbol}</span>
                        <span className="text-[8px] text-[#00FFA3] font-black">{formattedMcap(token.currentMcap)}</span>
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

      <footer className="h-8 border-t border-slate-800/60 bg-[#0d1117] flex items-center justify-between px-6 text-[8px] font-black text-slate-500 tracking-[0.2em] uppercase">
        <div className="flex gap-6">
          <span className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full shadow-[0_0_5px] ${autoMode ? 'bg-[#00FFA3] shadow-[#00FFA3]' : 'bg-slate-500'}`}></div> 
            Cluster {autoMode ? 'Autonomous' : 'Manual'}
          </span>
          <span>Latency: 22ms</span>
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
