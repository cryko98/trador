
import React, { useState, useEffect, useRef } from 'react';
import { 
  History as HistoryIcon, XCircle, Radar, Zap, TrendingUp, TrendingDown, RotateCcw, Power, Wallet, Play, Square, Briefcase
} from 'lucide-react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { fetchTokenData, fetchTrendingSolanaTokens } from './services/solanaService';
import { getTradorCommentary } from './services/geminiService';
import { executeJupiterSwap } from './services/jupiterService';
import { AppState, Trade, TokenMetadata, ActiveTokenState, PricePoint } from './types';

const INITIAL_SIM_BALANCE = 10; // Demo Money
const REFRESH_INTERVAL = 5000;
const AUTO_PILOT_INTERVAL = 12000; 
const MAX_ACTIVE_TOKENS = 5; // Max concurrent positions for diversification
const MCAP_HISTORY_LIMIT = 20; // For logic calc
const CHART_HISTORY_LIMIT = 60; // For visual chart (5 minutes approx)
const LOGO_URL = "https://wkkeyyrknmnynlcefugq.supabase.co/storage/v1/object/public/peng/trador.png";

const App: React.FC = () => {
  // Solana Wallet Hooks
  const { connection } = useConnection();
  const wallet = useWallet();

  // --- UI Inputs ---
  const [caInput, setCaInput] = useState('');
  const [tradeBudget, setTradeBudget] = useState<number>(1.0); // How much SOL allowed to use
  
  // --- Agent State ---
  const [isScanning, setIsScanning] = useState(false);
  const [agentActive, setAgentActive] = useState(false); // Master Switch (Manual Start)
  const [liveMode, setLiveMode] = useState(false); // Live vs Sim
  const [scannerResults, setScannerResults] = useState<TokenMetadata[]>([]);
  const [realWalletBalance, setRealWalletBalance] = useState<number>(0);
  
  const [state, setState] = useState<AppState>(() => {
    const saved = localStorage.getItem('trador_multi_v2');
    const initial = saved ? JSON.parse(saved) : null;
    
    // Migration: ensure priceHistory exists on old saves
    const migratedActiveTokens = initial?.activeTokens ? { ...initial.activeTokens } : {};
    Object.keys(migratedActiveTokens).forEach(key => {
        if (!migratedActiveTokens[key].priceHistory) {
            migratedActiveTokens[key].priceHistory = [];
        }
    });

    return {
      balance: initial?.balance ?? INITIAL_SIM_BALANCE,
      positions: initial?.positions ?? {},
      avgEntryPrices: initial?.avgEntryPrices ?? {},
      avgEntryMcaps: initial?.avgEntryMcaps ?? {},
      trades: initial?.trades ?? [],
      activeTokens: migratedActiveTokens,
      status: 'IDLE'
    };
  });
  
  const [inputError, setInputError] = useState('');
  const [systemMessage, setSystemMessage] = useState('');
  const stateRef = useRef(state);
  const walletRef = useRef(wallet);
  const budgetRef = useRef(tradeBudget);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { walletRef.current = wallet; }, [wallet]);
  useEffect(() => { budgetRef.current = tradeBudget; }, [tradeBudget]);

  // Fetch Real Balance Logic
  useEffect(() => {
    if (wallet.connected && wallet.publicKey) {
        const fetchBalance = async () => {
            const bal = await connection.getBalance(wallet.publicKey!);
            setRealWalletBalance(bal / LAMPORTS_PER_SOL);
        };
        fetchBalance();
        const interval = setInterval(fetchBalance, 10000);
        return () => clearInterval(interval);
    }
  }, [wallet.connected, connection]);

  // Persist State
  useEffect(() => {
    localStorage.setItem('trador_multi_v2', JSON.stringify({
      balance: state.balance,
      positions: state.positions,
      avgEntryPrices: state.avgEntryPrices,
      avgEntryMcaps: state.avgEntryMcaps,
      trades: state.trades,
      activeTokens: state.activeTokens
    }));
  }, [state.balance, state.positions, state.avgEntryPrices, state.avgEntryMcaps, state.trades, state.activeTokens]);

  // --- EXECUTION ENGINE ---
  const executeAndRecordTrade = async (type: Trade['type'], metadata: TokenMetadata, amount: number, solAmount: number, comment?: string) => {
    
    // LIVE MODE GUARD
    if (liveMode) {
        if (!walletRef.current.connected) {
            setSystemMessage("❌ Wallet not connected for Live Trade");
            setTimeout(() => setSystemMessage(''), 3000);
            return;
        }
        
        // Budget Check for Buys
        if (type === 'BUY') {
            if (solAmount > realWalletBalance) {
                setSystemMessage("❌ Insufficient Wallet Balance for Trade");
                return;
            }
        }

        setSystemMessage(`⚠️ EXECUTING LIVE ${type} on ${metadata.symbol}...`);
        
        let result;
        if (type === 'BUY') {
            result = await executeJupiterSwap(connection, walletRef.current, 'SOL', metadata.address, solAmount, true);
        } else {
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
        
        // Refresh Balance after trade
        const bal = await connection.getBalance(walletRef.current.publicKey!);
        setRealWalletBalance(bal / LAMPORTS_PER_SOL);
    }

    // INTERNAL ACCOUNTING (Sim & Live Tracking)
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
      let newAvgEntryMcap = prev.avgEntryMcaps[metadata.address] || metadata.mcap;
      
      if (type === 'BUY') {
        const totalTokens = currentPos + amount;
        newAvgEntry = ((currentPos * newAvgEntry) + (amount * price)) / totalTokens;
        // Calculate Weighted Average Entry MCAP
        newAvgEntryMcap = ((currentPos * newAvgEntryMcap) + (amount * metadata.mcap)) / totalTokens;
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
        },
        avgEntryMcaps: {
          ...prev.avgEntryMcaps,
          [metadata.address]: type === 'BUY' ? newAvgEntryMcap : (currentPos - amount <= 0 ? 0 : newAvgEntryMcap)
        }
      };
    });
  };

  const resetAgent = () => {
    if (confirm("⚠️ SYSTEM RESET CONFIRMATION\n\n- Reset Sim Balance to 10 SOL\n- Clear Trade History\n- Close All Positions\n\nAre you sure you want to restart?")) {
        const resetState: AppState = {
            balance: INITIAL_SIM_BALANCE,
            positions: {},
            avgEntryPrices: {},
            avgEntryMcaps: {},
            trades: [],
            activeTokens: {},
            status: 'IDLE'
        };
        setState(resetState);
        setAgentActive(false);
        setScannerResults([]);
        localStorage.setItem('trador_multi_v2', JSON.stringify(resetState));
    }
  };

  const handleScanMarkets = async () => {
    setIsScanning(true);
    setScannerResults([]);
    const results = await fetchTrendingSolanaTokens();
    const newResults = results.filter(t => !stateRef.current.activeTokens[t.address]);
    setScannerResults(newResults);
    setIsScanning(false);
    return newResults;
  };

  const deployToken = async (targetCa: string) => {
    if (!targetCa || targetCa.trim().length < 32) return;
    if (stateRef.current.activeTokens[targetCa]) return;

    // Use explicit type union to handle undefined (from find) and null (from fetch)
    let data: TokenMetadata | null | undefined = scannerResults.find(t => t.address === targetCa);
    
    if (!data) {
        data = await fetchTokenData(targetCa);
    }

    if (!data) {
      if (!agentActive) {
        setInputError('Token not found');
        setTimeout(() => setInputError(''), 3000);
      }
      return;
    }

    const currentPrice = parseFloat(data.priceNative);

    setState(prev => ({
      ...prev,
      status: 'TRADING',
      activeTokens: {
        ...prev.activeTokens,
        [targetCa]: {
          metadata: data!,
          currentPrice: currentPrice,
          currentMcap: data!.mcap,
          mcapHistory: [data!.mcap],
          priceHistory: [{ time: Date.now(), price: currentPrice }],
          message: "Initiating tactical monitoring...",
          sentiment: 'NEUTRAL',
          isAiLoading: false
        }
      }
    }));
    setCaInput('');
    setScannerResults(prev => prev.filter(t => t.address !== targetCa));
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

  // --- AUTO PILOT SCANNER ---
  useEffect(() => {
    if (!agentActive) return;

    const runAutoPilot = async () => {
      const currentActiveCount = Object.keys(stateRef.current.activeTokens).length;
      
      // Stop adding tokens if we reached max diversification
      if (currentActiveCount < MAX_ACTIVE_TOKENS) {
        const candidates = await fetchTrendingSolanaTokens();
        const available = candidates.filter(c => !stateRef.current.activeTokens[c.address]);

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
  }, [agentActive]); 

  // --- STRATEGY ENGINE ---
  useEffect(() => {
    // Only run if status is trading AND agent is manually started
    if (state.status !== 'TRADING' && !agentActive) return;

    const interval = setInterval(async () => {
      const tokens = Object.keys(stateRef.current.activeTokens);
      if (tokens.length === 0) return;

      for (const addr of tokens) {
        const data = await fetchTokenData(addr);
        if (!data) continue;

        const activeToken = stateRef.current.activeTokens[addr];
        const currentPrice = parseFloat(data.priceNative);
        
        // Update Histories
        const mcapHistory = [...activeToken.mcapHistory, data.mcap].slice(-MCAP_HISTORY_LIMIT);
        const priceHistory = [...(activeToken.priceHistory || []), { time: Date.now(), price: currentPrice }].slice(-CHART_HISTORY_LIMIT);
        
        const currentPos = stateRef.current.positions[addr] || 0;
        const avgEntry = stateRef.current.avgEntryPrices[addr] || 0;
        const profitPct = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0;
        const shortTermDelta = mcapHistory.length > 3 ? ((data.mcap - mcapHistory[mcapHistory.length - 3]) / mcapHistory[mcapHistory.length - 3]) * 100 : 0;

        let isBuying = false;
        let isSelling = false;

        // --- BUY LOGIC (DIVERSIFIED) ---
        if (currentPos === 0 && shortTermDelta > 0.6 && agentActive) {
           
           // Determine available capital based on mode
           const availableCapital = liveMode 
              ? budgetRef.current // Real SOL Allocation
              : stateRef.current.balance; // Sim Money

           // Diversification: Don't put more than (Budget / Max_Tokens) into one coin
           const maxPerPosition = liveMode 
              ? budgetRef.current / MAX_ACTIVE_TOKENS 
              : 2.0;

           const buySizeSol = Math.min(availableCapital, maxPerPosition);

           if (buySizeSol > 0.05) { // Minimum trade size check
             await executeAndRecordTrade('BUY', data, buySizeSol / currentPrice, buySizeSol, "Momentum ignition detected.");
             isBuying = true;
           }
        }

        // --- SELL LOGIC (RELAXED SL) ---
        if (currentPos > 0 && agentActive) {
          const hasScaled = stateRef.current.trades.some(t => t.address === addr && t.type === 'PARTIAL_SELL');
          
          if (profitPct >= 20 && !hasScaled) {
            const sellAmt = currentPos * 0.5;
            await executeAndRecordTrade('PARTIAL_SELL', data, sellAmt, sellAmt * currentPrice, "Target 1 reached. Securing 50%.");
            isSelling = true;
          } else if (profitPct >= 40 || (hasScaled && shortTermDelta < -2.5)) {
            await executeAndRecordTrade('SELL', data, currentPos, currentPos * currentPrice, "Trend exhausted. Full exit.");
            isSelling = true;
          } else if (profitPct <= -15.0) { 
            // STOP LOSS RELAXED TO -15% (Was -8%)
            await executeAndRecordTrade('SELL', data, currentPos, currentPos * currentPrice, "Stop loss hit (-15%). Preserving capital.");
            isSelling = true;
          }
        }

        // Update State
        setState(prev => ({
          ...prev,
          activeTokens: {
            ...prev.activeTokens,
            [addr]: {
              ...prev.activeTokens[addr],
              currentPrice,
              currentMcap: data.mcap,
              mcapHistory: mcapHistory,
              priceHistory: priceHistory
            }
          }
        }));

        if (Math.random() > 0.85 || isBuying || isSelling) {
          updateAiCommentary(addr, data, mcapHistory, isBuying, isSelling);
        }
      }
    }, REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [state.status, liveMode, agentActive]); 

  const updateAiCommentary = async (addr: string, data: TokenMetadata, history: number[], isBuying: boolean, isSelling: boolean) => {
    const balanceForAi = liveMode ? realWalletBalance : stateRef.current.balance;
    const aiResponse = await getTradorCommentary(data.symbol, history, isBuying, isSelling, balanceForAi);
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

  const formattedMcap = (m: number) => m >= 1000000 ? `$${(m / 1000000).toFixed(2)}M` : m >= 1000 ? `$${(m / 1000).toFixed(2)}K` : `$${m.toFixed(0)}`;
  const formattedChange = (c: number) => `${c > 0 ? '+' : ''}${c.toFixed(2)}%`;

  // Directly use state.trades since filters were removed to clean up code
  const filteredTrades = state.trades;

  return (
    <div className="h-screen flex flex-col bg-[#010409] text-slate-200 selection:bg-[#00FFA3] selection:text-black mono overflow-hidden relative">
      
      {/* Toast Messages */}
      {(inputError || systemMessage) && (
        <div className="fixed top-20 right-6 z-50 animate-bounce">
           <div className={`px-4 py-2 rounded shadow-lg text-xs font-mono flex items-center gap-2 ${systemMessage.includes('SUCCESS') ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200' : 'bg-rose-950/90 border border-rose-500 text-rose-200'}`}>
              {systemMessage.includes('SUCCESS') ? <Zap size={14} /> : <XCircle size={14} />}
              {inputError || systemMessage}
           </div>
        </div>
      )}

      {/* --- COMMAND CENTER NAVBAR --- */}
      <nav className="h-20 border-b border-slate-800/60 bg-[#0d1117]/95 backdrop-blur-xl flex items-center justify-between px-4 z-50 shrink-0">
        
        {/* LEFT: Branding & Agent Control */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <img src={LOGO_URL} alt="Trador" className="w-9 h-9 object-contain" />
            <div className="flex flex-col">
              <span className="text-sm font-black tracking-tighter neon-text leading-none uppercase">Trador</span>
              <span className="text-[7px] text-[#00FFA3] font-bold tracking-[0.3em] uppercase">Multi-Grid V2</span>
            </div>
          </div>
          
          <div className="h-8 w-[1px] bg-slate-800 mx-2"></div>
          
          {/* MASTER SWITCH */}
          <button 
            onClick={() => setAgentActive(!agentActive)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md border transition-all text-xs font-black uppercase tracking-wider ${
              agentActive 
                ? 'bg-[#00FFA3] border-[#00FFA3] text-black shadow-[0_0_15px_rgba(0,255,163,0.3)]' 
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
            }`}
          >
            {agentActive ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
            {agentActive ? 'STOP AGENT' : 'START AGENT'}
          </button>
        </div>

        {/* MIDDLE: Configuration Panel */}
        <div className="flex items-center gap-4 bg-black/40 border border-slate-800 rounded-lg px-4 py-1.5">
           
           {/* Mode Toggle */}
           <div className="flex flex-col items-start gap-1">
             <span className="text-[8px] text-slate-500 font-bold uppercase">Execution Mode</span>
             <button 
                onClick={() => setLiveMode(!liveMode)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-bold uppercase transition-all ${
                liveMode 
                    ? 'bg-rose-950/50 border-rose-500 text-rose-500 animate-pulse' 
                    : 'bg-emerald-950/30 border-emerald-500/50 text-emerald-500'
                }`}
            >
                <Power size={10} />
                <span>{liveMode ? 'REAL SOLANA' : 'PAPER TRADING'}</span>
            </button>
           </div>

           <div className="h-6 w-[1px] bg-slate-800"></div>

           {/* Budget Input */}
           <div className="flex flex-col items-start gap-1">
             <span className="text-[8px] text-slate-500 font-bold uppercase">Trade Budget</span>
             <div className="flex items-center gap-2">
               <input 
                 type="number" 
                 min="0.1" 
                 step="0.1"
                 value={tradeBudget} 
                 onChange={(e) => setTradeBudget(parseFloat(e.target.value))}
                 className="w-16 bg-slate-900 border border-slate-700 text-white text-[10px] px-2 py-1 rounded outline-none focus:border-[#00FFA3]"
               />
               <span className="text-[10px] text-slate-400">SOL</span>
             </div>
           </div>
        </div>

        {/* RIGHT: Wallet & Stats */}
        <div className="flex items-center gap-4">
          
          <div className="flex flex-col items-end">
             <span className="text-[8px] text-slate-500 font-bold uppercase">Available Balance</span>
             <div className="flex items-center gap-2">
               <Wallet size={12} className={liveMode ? "text-rose-500" : "text-[#00FFA3]"} />
               <span className="text-xs font-black text-white">
                  {liveMode ? realWalletBalance.toFixed(3) : (state.balance as number).toFixed(3)} SOL
               </span>
             </div>
          </div>
          
          <div className="wallet-adapter-wrapper">
             <WalletMultiButton style={{ 
                 backgroundColor: '#0f172a', 
                 height: '32px', 
                 fontSize: '10px', 
                 fontFamily: 'JetBrains Mono',
                 borderRadius: '0.5rem',
                 border: '1px solid #334155'
             }} />
          </div>

           <button onClick={resetAgent} className="text-slate-600 hover:text-rose-500 p-2" title="Reset System">
              <RotateCcw size={14} />
          </button>
        </div>
      </nav>

      {/* Grid Content */}
      <div className="flex-1 flex overflow-hidden">
        
        {/* Left: Global Stats */}
        <aside className="w-64 border-r border-slate-800/60 bg-[#0d1117]/60 flex flex-col hidden lg:flex">
          <div className="p-4 border-b border-slate-800/60 flex justify-between items-center bg-black/20">
            <div className="flex items-center gap-2">
                <Briefcase size={12} className="text-[#00FFA3]" />
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Portfolio</span>
            </div>
            <span className="text-[9px] text-slate-600 font-bold">{Object.keys(state.positions).filter(k => state.positions[k] > 0).length} Assets</span>
          </div>
          
          {/* Portfolio List */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
            {Object.entries(state.positions).filter(([_, amt]) => (amt as number) > 0).map(([addr, amount]) => {
               // Try to get metadata from active tokens, or scanner results if available, otherwise just use address
               const activeData = state.activeTokens[addr];
               const symbol = activeData?.metadata.symbol || addr.slice(0, 4).toUpperCase();
               const currentPrice = activeData?.currentPrice || 0;
               const entryPrice = state.avgEntryPrices[addr] || 0;
               const entryMcap = state.avgEntryMcaps[addr] || 0;
               
               let pnlPct = 0;
               if (currentPrice > 0 && entryPrice > 0) {
                   pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
               }

               return (
                  <div key={addr} className="mb-2 p-3 bg-slate-900/40 rounded border border-slate-800/50 hover:border-[#00FFA3]/30 transition-colors">
                    <div className="flex justify-between items-center mb-2">
                      <div className="flex items-center gap-2">
                        {activeData && <div className={`w-1.5 h-1.5 rounded-full ${pnlPct >= 0 ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`}></div>}
                        <span className="text-xs font-black text-white">{symbol}</span>
                      </div>
                      <span className={`text-[10px] font-mono font-bold ${pnlPct >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                        {pnlPct > 0 ? '+' : ''}{pnlPct.toFixed(1)}%
                      </span>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-y-1 gap-x-2 text-[9px] text-slate-400">
                        <div className="flex flex-col">
                            <span className="text-[8px] uppercase tracking-wider opacity-60">Entry MC</span>
                            <span className="font-mono text-slate-300">{formattedMcap(entryMcap)}</span>
                        </div>
                        <div className="flex flex-col text-right">
                            <span className="text-[8px] uppercase tracking-wider opacity-60">Holding</span>
                            <span className="font-mono text-slate-300">{(amount as number).toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
                        </div>
                    </div>
                  </div>
               );
            })}
            
            {Object.keys(state.positions).filter(k => state.positions[k] > 0).length === 0 && (
                <div className="text-center py-6">
                    <p className="text-[9px] text-slate-700 italic">No active positions</p>
                </div>
            )}
          </div>
          
          <div className="p-4 border-t border-slate-800/60 bg-black/20">
             <div className="flex items-center justify-between mb-3">
               <div className="flex items-center gap-2">
                 <HistoryIcon size={12} className="text-[#00FFA3]" />
                 <span className="text-[9px] font-black text-slate-500 uppercase">Trade Log</span>
               </div>
               <span className={`text-[10px] font-black ${(totalPnl as number) >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                {(totalPnl as number) >= 0 ? '+' : ''}{(totalPnl as number).toFixed(4)} SOL
               </span>
             </div>
             
             <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
               {filteredTrades.slice(0, 20).map(t => (
                 <div key={t.id} className="text-[9px] flex justify-between border-b border-slate-800/30 pb-1">
                   <span className={t.type === 'BUY' ? 'text-[#00FFA3]' : 'text-rose-500'}>{t.type === 'PARTIAL_SELL' ? 'SCALE' : t.type} {t.symbol}</span>
                   <span className="text-slate-600 font-mono">{t.solAmount.toFixed(2)}</span>
                 </div>
               ))}
               {filteredTrades.length === 0 && <div className="text-[9px] text-slate-600 text-center py-2 italic">No trades yet</div>}
             </div>
          </div>
        </aside>

        {/* Main Workspace */}
        <main className="flex-1 overflow-hidden flex flex-col relative bg-black">
          {activeCount === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-12 text-center relative overflow-hidden">
               <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10"></div>
               
               <div className="relative z-10 max-w-2xl w-full">
                 <div className="mb-8 flex flex-col items-center">
                   <img src={LOGO_URL} alt="Trador" className="w-16 h-16 md:w-20 md:h-20 mb-6 opacity-80" />
                   {agentActive ? (
                     <>
                      <h2 className="text-2xl md:text-3xl font-black italic tracking-tighter text-[#00FFA3] uppercase neon-text animate-pulse">Scanning Active</h2>
                      <p className="text-[8px] md:text-[10px] text-slate-500 mt-2 uppercase tracking-[0.3em]">Strategy: Diversified Grid | Max Exposure: {MAX_ACTIVE_TOKENS} Assets</p>
                      {liveMode && <p className="text-[8px] md:text-[10px] text-rose-500 font-bold mt-2 uppercase tracking-[0.3em] border border-rose-900/50 bg-rose-950/20 px-2 py-1 rounded">⚠️ LIVE SOLANA TRADING ACTIVE</p>}
                     </>
                   ) : (
                     <>
                      <h2 className="text-2xl md:text-3xl font-black italic tracking-tighter text-white uppercase neon-text">System Idle</h2>
                      <p className="text-[8px] md:text-[10px] text-slate-500 mt-2 uppercase tracking-[0.3em]">Configure Budget and Press Start</p>
                     </>
                   )}
                 </div>

                 <div className="bg-[#0d1117] border border-slate-800 rounded-xl overflow-hidden shadow-2xl min-w-[280px] md:min-w-[320px]">
                    <div className="h-10 bg-slate-900/50 border-b border-slate-800 flex items-center justify-between px-4">
                      <div className="flex items-center gap-2 text-[#00FFA3]">
                         <Radar size={14} className={isScanning ? "animate-spin" : ""} />
                         <span className="text-[10px] font-black uppercase tracking-widest">Scanner</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <input 
                            type="text" 
                            value={caInput} 
                            onChange={(e) => setCaInput(e.target.value)}
                            placeholder="Manual CA..."
                            className="bg-black/50 border border-slate-800 rounded px-2 py-1 text-[9px] w-24 focus:border-[#00FFA3]"
                            onKeyDown={(e) => e.key === 'Enter' && deployToken(caInput)}
                        />
                        <button onClick={handleScanMarkets} className="text-slate-500 hover:text-white"><Radar size={12} /></button>
                      </div>
                    </div>

                    <div className="p-4 min-h-[200px] max-h-[300px] overflow-y-auto custom-scrollbar">
                      {isScanning ? (
                        <div className="flex flex-col items-center justify-center h-40 gap-3">
                          <div className="w-8 h-8 border-2 border-[#00FFA3] border-t-transparent rounded-full animate-spin"></div>
                          <span className="text-[10px] text-slate-500 uppercase animate-pulse">Analyzing Volatility...</span>
                        </div>
                      ) : scannerResults.length > 0 ? (
                        <div className="grid grid-cols-1 gap-2">
                           {scannerResults.map(token => (
                             <div key={token.address} className="bg-black/40 border border-slate-800 hover:border-[#00FFA3] p-2 rounded group transition-all flex justify-between items-center cursor-pointer" onClick={() => deployToken(token.address)}>
                                <div className="flex items-center gap-3">
                                  <img src={`https://dd.dexscreener.com/ds-data/tokens/solana/${token.address}.png`} onError={(e) => e.currentTarget.src = LOGO_URL} className="w-8 h-8 rounded-full bg-slate-900" alt={token.symbol} />
                                  <div className="flex flex-col text-left">
                                    <span className="text-xs font-black text-white">{token.symbol}</span>
                                    <span className="text-[9px] text-slate-500">{formattedMcap(token.mcap)} MCAP</span>
                                  </div>
                                </div>
                                <div className={`flex items-center gap-1 ${token.priceChange24h >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                                    {token.priceChange24h >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                                    <span className="text-[10px] font-black">{formattedChange(token.priceChange24h)}</span>
                                </div>
                             </div>
                           ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-40 text-slate-600">
                          <p className="text-[10px] uppercase tracking-wider mb-4">
                            {agentActive ? "Scanning..." : "Waiting for Start..."}
                          </p>
                        </div>
                      )}
                    </div>
                 </div>
               </div>
            </div>
          ) : (
            <div className={`grid h-full w-full gap-px bg-slate-800/40 ${activeCount === 1 ? 'grid-cols-1' : activeCount <= 4 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'}`}>
              {(Object.values(state.activeTokens) as ActiveTokenState[]).map((token) => {
                const pos = state.positions[token.metadata.address] || 0;
                const avg = state.avgEntryPrices[token.metadata.address] || 0;
                const profit = avg > 0 ? ((token.currentPrice - avg) / avg) * 100 : 0;
                
                const buys = token.metadata.txns24h?.buys || 0;
                const sells = token.metadata.txns24h?.sells || 0;
                const totalTxns = buys + sells;
                const buyRatio = totalTxns > 0 ? (buys / totalTxns) * 100 : 50;

                const tokenTrades = state.trades.filter(t => t.address === token.metadata.address).sort((a, b) => b.timestamp - a.timestamp);

                return (
                  <div key={token.metadata.address} className="bg-[#010409] flex flex-col relative group">
                    <div className="h-10 border-b border-slate-800/40 bg-[#0d1117]/40 flex items-center justify-between px-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-black text-white">{token.metadata.symbol}</span>
                        <span className="text-[8px] text-[#00FFA3] font-black">{formattedMcap(token.currentMcap)}</span>
                         <span className={`text-[8px] flex items-center gap-0.5 border-l border-slate-700 pl-2 ml-1 ${token.metadata.priceChange24h >= 0 ? 'text-[#00FFA3]' : 'text-rose-500'}`}>
                            {formattedChange(token.metadata.priceChange24h)}
                         </span>
                         <div className="flex flex-col gap-0.5 ml-2">
                           <div className="w-12 h-1 bg-rose-900/50 rounded-full overflow-hidden flex">
                             <div className="h-full bg-[#00FFA3]" style={{ width: `${buyRatio}%` }} />
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

                    <div className="flex-1 bg-black relative overflow-hidden">
                      {/* REAL DEXSCREENER CHART */}
                      <iframe 
                        src={`https://dexscreener.com/solana/${token.metadata.address}?embed=1&theme=dark`}
                        className="w-full h-full grayscale-[0.3] hover:grayscale-0 transition-all duration-500"
                        title="DexScreener"
                        frameBorder="0"
                      />
                      
                      <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 items-end pointer-events-none">
                         {/* Optional Floating Trade Tickers can stay if desired, but chart now has markers */}
                      </div>

                      <div className="absolute bottom-2 left-2 right-2 pointer-events-none">
                        <div className="bg-[#00FFA3] text-black p-2 rounded shadow-lg border border-white/20 pointer-events-auto opacity-90 hover:opacity-100 transition-opacity">
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
            <div className={`w-1.5 h-1.5 rounded-full shadow-[0_0_5px] ${liveMode ? 'bg-rose-500 shadow-rose-500 animate-pulse' : agentActive ? 'bg-[#00FFA3] shadow-[#00FFA3]' : 'bg-slate-500'}`}></div> 
            Status: {liveMode ? 'LIVE' : 'SIM'} | {agentActive ? 'ACTIVE' : 'IDLE'}
          </span>
          <span className="hidden sm:inline">Allocated: {tradeBudget} SOL</span>
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
