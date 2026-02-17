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
  inputMint: string,
  outputMint: string,
  amount: number, // In natural units (e.g. 0.1 SOL)
  isInputSol: boolean
): Promise<SwapResult> => {
  try {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error("Wallet not connected");
    }

    // 1. Convert amount to smallest unit (Lamports for SOL, or assume 6 decimals for tokens for simplicity in this demo, 
    // ideally we fetch decimals from metadata)
    // For SOL -> Token, input is SOL (9 decimals)
    // For Token -> SOL, input is Token (Assume 6 for USDC/most memes, but this is a heuristic)
    const decimals = isInputSol ? 9 : 6; 
    const amountInSmallestUnit = Math.floor(amount * Math.pow(10, decimals));

    const input = isInputSol ? SOL_MINT : inputMint;
    const output = outputMint === 'SOL' ? SOL_MINT : outputMint;

    // 2. Get Quote
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${input}&outputMint=${output}&amount=${amountInSmallestUnit}&slippageBps=50`;
    const quoteResponse = await fetch(quoteUrl).then(res => res.json());

    if (!quoteResponse || quoteResponse.error) {
      throw new Error(quoteResponse.error || "Failed to get quote");
    }

    // 3. Get Swap Transaction
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        // Optional: prioritize fees for faster inclusion
        prioritizationFeeLamports: 'auto' 
      })
    }).then(res => res.json());

    if (!swapResponse.swapTransaction) {
      throw new Error("Failed to get swap transaction");
    }

    // 4. Deserialize and Sign
    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    const signature = await wallet.sendTransaction(transaction, connection);
    
    // 5. Confirm
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    
    if (confirmation.value.err) {
      throw new Error("Transaction failed on-chain");
    }

    return { signature };
  } catch (error: any) {
    console.error("Jupiter Swap Error:", error);
    return { error: error.message || "Swap failed" };
  }
};