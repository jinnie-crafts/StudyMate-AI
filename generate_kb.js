const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'server', 'knowledge');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const files = {
  'features.json': {
    category: "Features",
    entries: [
      { id: "feat_notes", question: "Does StudyMate AI have notes?", answer: "Yes, StudyMate AI features Smart Notes, allowing you to save AI-generated responses directly to your digital notebook.", keywords: ["notes", "notebook", "save", "smart notes"] },
      { id: "feat_chat", question: "Can I chat with the AI?", answer: "Absolutely. StudyMate AI includes a conversational AI Assistant capable of resolving complex doubts, tutoring, and providing instant feedback.", keywords: ["chat", "assistant", "talk", "bot"] }
    ]
  },
  'privacy.json': {
    category: "Privacy",
    entries: [
      { id: "priv_data", question: "How is my privacy handled?", answer: "StudyMate AI adheres to strict privacy standards. We do not sell your personal data. Authentication is handled by Firebase.", keywords: ["privacy", "data policy", "sell data"] }
    ]
  },
  'security.json': {
    category: "Security",
    entries: [
      { id: "sec_encryption", question: "Is StudyMate secure?", answer: "We use HTTPS, Firebase Auth, and secure Firestore rules to ensure all user data and study materials are protected.", keywords: ["security", "encryption", "safe"] }
    ]
  },
  'roadmap.json': {
    category: "Roadmap",
    entries: [
      { id: "road_future", question: "What are the future features of StudyMate AI?", answer: "Our roadmap includes Voice Tutoring, Collaborative Study Rooms, and an integrated Pomodoro timer.", keywords: ["future", "roadmap", "upcoming", "next"] }
    ]
  },
  'support.json': {
    category: "Support",
    entries: [
      { id: "sup_help", question: "How do I get help or support?", answer: "You can email us at karshsecurities@gmail.com for technical support, billing inquiries, or general assistance.", keywords: ["help", "support", "ticket", "issue"] }
    ]
  },
  'pricing.json': {
    category: "Pricing",
    entries: [
      { id: "price_tiers", question: "What are the pricing tiers?", answer: "StudyMate AI offers a Free tier for basic use and a Premium tier for advanced models and unlimited chat history.", keywords: ["pricing", "cost", "tiers", "premium"] }
    ]
  },
  'policies.json': {
    category: "Policies",
    entries: [
      { id: "pol_terms", question: "Where are the terms of service?", answer: "You can find our full Terms of Service and Privacy Policy linked in the footer of our website.", keywords: ["policies", "terms", "service", "conditions"] }
    ]
  },
  'announcements.json': {
    category: "Announcements",
    entries: [
      { id: "ann_latest", question: "What are the latest announcements?", answer: "StudyMate AI recently launched Exam Revision Mode and enhanced Coding Mode. Check the dashboard for the latest news.", keywords: ["announcements", "news", "updates"] }
    ]
  },
  'notifications.json': {
    category: "Notifications",
    entries: [
      { id: "notif_how", question: "How do notifications work?", answer: "StudyMate AI provides in-app toast notifications for important system updates, Easter eggs, and study milestones.", keywords: ["notifications", "alerts", "toast"] }
    ]
  },
  'authentication.json': {
    category: "Authentication",
    entries: [
      { id: "auth_methods", question: "How do I log in?", answer: "You can log in using Email/Password authentication securely managed by Google Firebase.", keywords: ["login", "signup", "auth", "password"] }
    ]
  },
  'integrations.json': {
    category: "Integrations",
    entries: [
      { id: "int_list", question: "What does StudyMate AI integrate with?", answer: "StudyMate AI integrates with OpenRouter for AI models, DuckDuckGo for real-time web search, and Firebase for backend services.", keywords: ["integrations", "apis", "third party"] }
    ]
  }
};

for (const [filename, data] of Object.entries(files)) {
  const fullData = {
    version: "1.2.0",
    lastUpdated: "2026-06-23",
    category: data.category,
    entries: data.entries
  };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(fullData, null, 2));
}

console.log("Generated JSON files successfully.");
