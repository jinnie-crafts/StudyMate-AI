/**
 * Memory Extractor — StudyMate AI
 * 
 * Analyzes recent chat messages to extract structured, persistent facts
 * and user preferences for the conversational memory system.
 */
const EXTRACTOR_MODEL = "google/gemma-4-31b-it:free"; // Fast model for internal tasks
const EXTRACTION_TIMEOUT_MS = 6000;

/**
 * Extracts new memories from the latest user message and context.
 * 
 * @param {string} apiKey - OpenRouter API key
 * @param {Array} messages - Recent chat history
 * @returns {Promise<Array>} Array of extracted memory objects
 */
async function extractMemory(apiKey, messages) {
  if (!apiKey || !Array.isArray(messages) || messages.length === 0) return [];

  // Only analyze the most recent user message
  const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
  if (!lastUserMessage || lastUserMessage.content.length < 10) return []; // Skip short/trivial messages

  const systemPrompt = `
You are a memory extraction agent. Your job is to extract long-term reusable facts, preferences, or learning patterns about the user from their message.

Rules:
1. Extract ONLY facts that are useful for future personalization (e.g., "User prefers short explanations", "User struggles with Calculus", "User is building StudyMate AI").
2. DO NOT extract temporary questions, greetings, or trivial noise.
3. If no useful long-term fact is found, return an empty array [].
4. Output MUST be valid JSON in this exact format:
[
  {
    "fact": "String describing the preference or fact",
    "category": "PREFERENCE" | "LEARNING_HABIT" | "PROJECT_CONTEXT" | "INTEREST",
    "confidence": 0.0 to 1.0
  }
]

Do not output any markdown code blocks (\`\`\`json) or other text. Just the raw JSON array.
`;

  const requestMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `User message: ${JSON.stringify(lastUserMessage.content)}` }
  ];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://aadirishi.in/",
        "X-Title": "StudyMate AI Internal"
      },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        messages: requestMessages,
        provider: { allow_fallbacks: false },
        temperature: 0.1
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[MemoryExtractor] HTTP ${response.status} from OpenRouter`);
      return [];
    }

    const data = await response.json();
    let content = data?.choices?.[0]?.message?.content || "[]";
    
    // Clean up possible markdown wraps
    content = content.replace(/```json/gi, "").replace(/```/g, "").trim();

    const memories = JSON.parse(content);
    if (!Array.isArray(memories)) return [];

    // Filter and sanitize extracted memories
    return memories.filter(m => 
      m && 
      typeof m.fact === "string" && 
      m.fact.length >= 5 &&
      m.fact.length <= 150 &&
      m.confidence >= 0.7
    ).map(m => ({
      id: "mem_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      fact: m.fact,
      category: m.category || "PREFERENCE",
      confidence: m.confidence,
      timestamp: Date.now()
    }));

  } catch (error) {
    console.warn(`[MemoryExtractor] Failed: ${error.message}`);
    return [];
  }
}

module.exports = { extractMemory };
