
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const getTradorCommentary = async (
  tokenName: string,
  mcapHistory: number[],
  isBuying: boolean,
  isSelling: boolean,
  balance: number
): Promise<{ text: string; sentiment: 'BULLISH' | 'NEUTRAL' | 'BEARISH' }> => {
  try {
    const currentMcap = mcapHistory[mcapHistory.length - 1];
    const prevMcap = mcapHistory[mcapHistory.length - 2] || currentMcap;
    const trend = currentMcap > prevMcap ? "UPWARD" : "DOWNWARD";
    
    const prompt = `You are 'Trador', a world-class professional Solana swing trader and fund manager.
    Reviewing the current chart for ${tokenName}.
    
    Market Data:
    - Recent MCAP Trend: ${mcapHistory.slice(-5).join(' -> ')}
    - Trend: ${trend}
    - Action taken: ${isBuying ? 'ACCUMULATED POSITION' : isSelling ? 'SCALED OUT/PROFIT TAKEN' : 'MONITORING'}
    - Wallet: ${balance.toFixed(2)} SOL
    
    Task: 
    1. Provide 1 punchy professional commentary sentence (use degen slang sparingly like 'jeet', 'liquidity', 'rotation').
    2. Respond in a JSON format matching the schema provided.`;

    // Use generateContent with responseSchema for reliable JSON responses
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            text: {
              type: Type.STRING,
              description: 'The commentary sentence provided by Trador.',
            },
            sentiment: {
              type: Type.STRING,
              description: 'The overall market sentiment for the token.',
              enum: ['BULLISH', 'NEUTRAL', 'BEARISH'],
            },
          },
          required: ["text", "sentiment"],
        },
      },
    });

    // Access the text property directly (property, not a method)
    const result = JSON.parse(response.text || '{"text": "Scanning the order flow...", "sentiment": "NEUTRAL"}');
    return result;
  } catch (error) {
    console.error("Gemini Error:", error);
    return { text: "Volatility is spiking. Maintaining discipline.", sentiment: "NEUTRAL" };
  }
};
