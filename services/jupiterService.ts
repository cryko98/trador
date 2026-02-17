
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface SwapResult {
  signature?: string;
  error?: string;
}

export const executeJupiterSwap = async (
  connection: Connection,
  wallet: any, // WalletContextState
  inputTokenRaw: string,
  outputTokenRaw: string,
  amount: number, // In natural units (e.g. 0.1 SOL or 1000 Token)
  isInputSol: boolean
): Promise<SwapResult> => {
  try {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      throw new Error("Wallet not connected");
    }

    // 1. Resolve Mints
    const inputMint = inputTokenRaw === 'SOL' ? SOL_MINT : inputTokenRaw;
    const outputMint = outputTokenRaw === 'SOL' ? SOL_MINT : outputTokenRaw;

    // 2. Determine Decimals dynamically
    let decimals = 9; // Default to SOL (9 decimals)
    
    if (!isInputSol && inputMint !== SOL_MINT) {
        try {
            // Fetch mint info to get accurate decimals for tokens
            const info = await connection.getParsedAccountInfo(new PublicKey(inputMint));
            const parsedData = (info.value?.data as any)?.parsed?.info;
            if (parsedData && typeof parsedData.decimals === 'number') {
                decimals = parsedData.decimals;
            } else {
                console.warn(`[Jupiter] Could not fetch decimals for ${inputMint}, defaulting to 6.`);
                decimals = 6; 
            }
        } catch (e) {
            console.warn(`[Jupiter] Error fetching mint info for ${inputMint}:`, e);
            decimals = 6; // Fallback for most SPL tokens
        }
    }

    // 3. Convert to Atomic Units
    const amountAtomic = Math.floor(amount * Math.pow(10, decimals));

    if (amountAtomic === 0) {
        throw new Error("Amount too small for transaction");
    }

    // 4. Get Quote from Jupiter V6
    // Slippage: 100 bps = 1%. Essential for volatile meme coins.
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=100`;
    
    const quoteResponse = await fetch(quoteUrl).then(res => res.json());

    if (!quoteResponse || quoteResponse.error) {
      throw new Error(quoteResponse.error || "Failed to get quote from Jupiter");
    }

    // 5. Get Swap Transaction
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 'auto' // vital for congestion
      })
    }).then(res => res.json());

    if (!swapResponse.swapTransaction) {
      throw new Error("Failed to generate swap transaction");
    }

    // 6. Deserialize Transaction
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // 7. Sign and Send
    const signature = await wallet.sendTransaction(transaction, connection, {
        maxRetries: 5,
        skipPreflight: true // Often needed for Jupiter swaps to avoid simulation errors on aggressive slippage
    });
    
    // 8. Confirm Transaction
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    }, 'confirmed');

    return { signature };

  } catch (error: any) {
    console.error("Jupiter Swap Execution Failed:", error);
    
    // Friendly error mapping
    let msg = error.message || "Unknown error";
    if (msg.includes("User rejected")) msg = "User rejected request";
    if (msg.includes("insufficient funds")) msg = "Insufficient funds for transaction";
    
    return { error: msg };
  }
};
