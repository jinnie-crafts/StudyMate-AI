/**
 * Central Agent Runner for StudyMate AI
 * Orchestrates AI, Backend, and UI agents.
 */

const memoryRunner = require("./memory/memoryRunner");

const IDENTITY_RESPONSES = [
  "StudyMate AI is developed by Rishu Maurya.",
  "This application was created by Rishu Maurya.",
  "Rishu Maurya is the developer of StudyMate AI.",
  "StudyMate AI was built by Rishu Maurya."
];

class AgentRunner {
  constructor() {
    this.agents = {
      identity: new IdentityAgent(),
      intent: new IntentAgent(),
      quiz: new QuizAgent(),
      ui: new UIAgent(),
      memory: new MemoryAgent()
    };
  }

  /**
   * Run pre-processing agents (before AI call)
   */
  async preProcess(context) {
    console.log("[AgentRunner] Starting pre-processing...");
    
    // 1. Intent Agent
    const intent = await this.agents.intent.execute(context);
    context.intent = intent;

    // 2. Identity Agent (Can bypass AI)
    const identityResult = await this.agents.identity.execute(context);
    if (identityResult) {
      console.log("[AgentRunner] IdentityAgent triggered bypass.");
      return { bypass: true, response: identityResult };
    }

    // 3. Prompt Decoration (Skills/Styles)
    context.promptDecoration = this.buildPromptDecoration(context);

    return { bypass: false };
  }

  isMultiPartPrompt(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    const hasNumberedList = /\b(1\.|firstly|first|step 1)\b/i.test(lowerText) && /\b(2\.|secondly|second|step 2)\b/i.test(lowerText);
    const hasComparison = /\b(compare|vs|versus|difference|differences)\b/i.test(lowerText);
    const hasCompoundRequests = /\b(pros and cons|advantages and disadvantages|explain and give|what is .* and how)\b/i.test(lowerText);
    const hasListKeywords = /\b(list|steps|roadmap|guide|examples of)\b/i.test(lowerText) && lowerText.length > 50;
    const isVeryLongQuestion = lowerText.split(/[.?!]+/).filter(s => s.trim().length > 15 && s.includes("?")).length >= 2;

    return hasNumberedList || hasComparison || hasCompoundRequests || hasListKeywords || isVeryLongQuestion;
  }

  buildPromptDecoration(context) {
    const { intent, mode, message } = context;
    const text = String(message || "").toLowerCase();
    let decoration = "";

    // 1. Multi-Part Orchestration
    if (this.isMultiPartPrompt(text)) {
      decoration += "\n\n[MULTI-PART ORCHESTRATION: This is a complex/multi-part prompt.]";
      decoration += "\n- COMPLETENESS: Prioritize answering ALL sections completely before adding excessive detail to any single section.";
      decoration += "\n- TOKEN BUDGET: Allocate response space proportionally across all detected parts.";
      decoration += "\n- STRUCTURE: Force headings (##) and numbered sections for clear segmentation. Do NOT use emojis in code blocks or Mermaid diagrams.";
      decoration += "\n- CONTINUATION: If your answer is extremely long, naturally state 'Continuing with the remaining parts...' to avoid fragmentation.";
      decoration += "\n- SELF-CORRECTION: Before finalizing, internally verify that all parts of the user's request were answered.";
    }

    if (intent === "CODING" || mode === "coding") {
      decoration += "\n[CRITICAL: Provide complete, working code with syntax highlighting.]";
    }

    if (intent === "DIAGRAM") {
      decoration += "\n[CRITICAL: Use Mermaid syntax ( ```mermaid ) for visualizations.]";
    }

    // QuizAgent logic for follow-ups
    if (this.agents.quiz.shouldSuggestQuiz("", intent)) {
      decoration += "\n[Follow-up: Ask exactly ONE natural, engaging question to deepen the conversation. No generic 'Want a quiz?' text.]";
    }

    // UX EMOJI ENHANCEMENT & HALLUCINATION REDUCTION
    decoration += "\n\n[UX & TONE]";
    decoration += "\n- EMOJIS: Use tasteful, rule-based emojis (e.g., 💡 tips, ⚠️ warnings, ✅ completed steps, 🚀 improvements, 🔒 security) subtly to enhance readability. Target a premium productivity app tone. Avoid emojis in every heading, emotional spam, or childish tone.";
    decoration += "\n- ACCURACY & RAG: Retrieved context has priority. Synthesize across all sources and avoid contradicting them. Only disclose uncertainty if evidence is weak or sources conflict. Maintain professional confidence otherwise.";

    return decoration;
  }

  /**
   * Run post-processing agents (after AI call)
   */
  async postProcess(context, aiResponse) {
    console.log("[AgentRunner] Starting post-processing...");
    
    let processedResponse = { ...aiResponse };

    // 1. Quiz Agent
    const quizResult = await this.agents.quiz.execute(context, processedResponse);
    processedResponse = { ...processedResponse, ...quizResult };

    // 2. UI Agent (Metadata for frontend)
    const uiMetadata = await this.agents.ui.execute(context, processedResponse);
    processedResponse.ui = uiMetadata;

    // 3. Memory Agent
    // Extract new memories asynchronously so we don't delay the final JSON processing
    // (Wait, actually we should await it if we want it in the response metadata synchronously)
    const memoryUpdates = await this.agents.memory.execute(context);
    if (memoryUpdates && memoryUpdates.length > 0) {
      processedResponse.ui.memoryUpdates = memoryUpdates;
    }

    console.log("[AgentRunner] Post-processing complete.");
    return processedResponse;
  }
}

class IdentityAgent {
  async execute(context) {
    const { message } = context;
    const text = String(message || "").toLowerCase();
    
    const identityKeywords = [
      "who made", "who created", "who built", "who developed", "who coded", 
      "who is the owner", "who is the creator", "your developer", "your owner", 
      "who built this app", "anthropic", "openai", "google", "meta"
    ];

    const isMatch = identityKeywords.some(kw => text.includes(kw));
    
    if (isMatch) {
      console.log("[IdentityAgent] Detected identity query. Providing hardcoded response.");
      const responseText = IDENTITY_RESPONSES[Math.floor(Math.random() * IDENTITY_RESPONSES.length)];
      return {
        text: responseText,
        reply: responseText,
        intent: "identity"
      };
    }
    return null;
  }
}

class IntentAgent {
  async execute(context) {
    const { message, mode } = context;
    const text = String(message || "").toLowerCase();
    
    console.log(`[IntentAgent] Classifying intent for mode: ${mode}`);

    const DIAGRAM_QUERY_REGEX = /diagram|chart|graph|flow|flowchart|structure|architecture/i;
    const CODE_QUERY_REGEX = /code|program|example|debug|script|function|snippet|coding/i;

    if (DIAGRAM_QUERY_REGEX.test(text)) return "DIAGRAM";
    if (CODE_QUERY_REGEX.test(text) || mode === "coding") return "CODING";

    const explanationKeywords = ["explain", "how", "why", "what is", "define", "concept", "theory"];
    if (explanationKeywords.some(kw => text.includes(kw))) return "EXPLANATION";

    return "GENERAL";
  }
}

class QuizAgent {
  async execute(context, response) {
    const { intent } = context;
    const text = response.text || "";
    
    console.log("[QuizAgent] Evaluating response for quiz/follow-up potential.");

    const quizContent = this.extractQuiz(text);
    const suggestQuiz = this.shouldSuggestQuiz(text, intent);

    // Ensure ChatGPT-style follow-up logic
    let finalReply = text;
    if (suggestQuiz && !text.toLowerCase().includes("?")) {
      // If we should suggest something but haven't asked a question yet
      console.log("[QuizAgent] Adding contextual follow-up suggestion.");
      // This is dynamic, but for now we just mark it
    }

    return {
      quiz: quizContent,
      suggestQuiz: suggestQuiz
    };
  }

  extractQuiz(text) {
    if (!text) return null;
    const match = text.match(/Quiz:\s*(.*)/i);
    return match ? match[1].trim() : null;
  }

  shouldSuggestQuiz(text, intent) {
    // Fixed: Now allows suggestions for educational intents
    if (intent === "identity" || intent === "system_error") return false;
    
    const educationalIntents = ["EXPLANATION", "CODING", "DIAGRAM", "GENERAL"];
    const hasEnoughContent = text.length > 100; // Only suggest for substantial answers
    
    return educationalIntents.includes(intent) && hasEnoughContent;
  }
}

class UIAgent {
  async execute(context, response) {
    console.log("[UIAgent] Preparing UI sync metadata.");
    return {
      action: response.quiz ? "SHOW_QUIZ_PROMPT" : "NONE",
      syncState: {
        currentQuestion: context.currentQuestion || null
      }
    };
  }
}

class MemoryAgent {
  async execute(context) {
    console.log("[MemoryAgent] Analyzing conversation for persistent memory facts.");
    const { messages, userMemory } = context;
    const apiKey = process.env.OPENROUTER_API_KEY;
    
    // Extract new memories based on the messages, avoiding duplicates in userMemory
    const memoryUpdates = await memoryRunner.extractNewMemories(apiKey, messages, userMemory);
    return memoryUpdates;
  }
}

module.exports = new AgentRunner();
