require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is missing from .env");
}

const ai = new GoogleGenAI({
  apiKey
});

const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash"
];

const SYSTEM_PROMPT = `
You are JARVIS, a highly intelligent personal AI assistant.

Personality:
- Calm
- Intelligent
- Helpful
- Concise
- Slightly futuristic
- Respectful
- Natural and confident

You are running on an Android device through a local JARVIS server.

Never claim that you performed an action unless the local JARVIS
command system actually performed it.

Keep normal answers reasonably concise unless the user asks for detail.

Use recent conversation history to understand references such as:
"it", "that", "continue", "what I just said", and similar phrases.

Do not mention the internal memory system unless asked.
`;

const conversationHistory = [];

const MAX_MESSAGES = 20;

async function askGemini(message) {

  conversationHistory.push({
    role: "user",
    parts: [
      {
        text: message
      }
    ]
  });

  while (conversationHistory.length > MAX_MESSAGES) {
    conversationHistory.shift();
  }

  let lastError = null;

  for (const model of MODELS) {

    try {

      console.log(`[JARVIS AI] Trying ${model}...`);

      const response = await ai.models.generateContent({
        model,
        contents: conversationHistory,
        config: {
          systemInstruction: SYSTEM_PROMPT
        }
      });

      const text = response.text;

      if (text) {

        console.log(`[JARVIS AI] Response from ${model}`);

        conversationHistory.push({
          role: "model",
          parts: [
            {
              text
            }
          ]
        });

        while (conversationHistory.length > MAX_MESSAGES) {
          conversationHistory.shift();
        }

        return text;
      }

      throw new Error("Gemini returned an empty response.");

    } catch (error) {

      lastError = error;

      console.log(
        `[JARVIS AI] ${model} unavailable: ${error.message}`
      );

      continue;
    }
  }

  if (
    conversationHistory.length > 0 &&
    conversationHistory[conversationHistory.length - 1].role === "user"
  ) {
    conversationHistory.pop();
  }

  throw new Error(
    `All Gemini models are temporarily unavailable. Last error: ${
      lastError ? lastError.message : "Unknown error"
    }`
  );
}

function clearMemory() {
  conversationHistory.length = 0;
}

function getMemorySize() {
  return conversationHistory.length;
}

module.exports = {
  askGemini,
  clearMemory,
  getMemorySize
};
