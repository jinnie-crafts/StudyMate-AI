# 🚀 StudyMate AI — Premium AI Study Companion

[![StudyMate Banner](https://img.shields.io/badge/StudyMate-AI-3b82f6?style=for-the-badge&logo=study&logoColor=white)](https://github.com/your-username/studymate)
[![Firebase](https://img.shields.io/badge/Firebase-039BE5?style=for-the-badge&logo=Firebase&logoColor=white)](https://firebase.google.com/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-Production--Ready-success?style=for-the-badge)](https://github.com/your-username/studymate)

StudyMate AI is a cutting-edge, AI-powered study companion designed for students preparing for competitive exams like **UPSC, JEE, and NEET**. It leverages advanced LLMs via OpenRouter to provide structured reasoning, technical solutions, and natural Hinglish support.

---

## ✨ Features

- **🎯 Specialized Study Modes**: Context-aware AI tutoring for UPSC (Deep Analysis), JEE (Step-by-Step Solving), and NEET (Biology Focus).
- **📝 Intelligent Notes Generation**: Instantly transform queries into Bullet Points, Structured Revision Notes, or Flashcards.
- **🗣️ Native Hinglish Support**: Balanced bilingual responses (Hindi + English) for conceptual clarity that feels natural.
- **📊 Performance Tracking**: Built-in Study Tracker with daily question counters and activity streaks.
- **🔒 Secure Custom Auth**: Fully custom Firebase authentication flow with intercepted action handlers for a white-labeled experience.
- **🎨 Elite UI/UX**: Dark-themed, glassmorphic dashboard with smooth animations and responsive design.

---

## 🏗️ Architecture

```mermaid
graph TD
    User(User Browser) --> Frontend(Vanilla JS / CSS Dashboard)
    Frontend --> Firebase_Auth(Firebase Auth)
    Frontend --> Firestore(Firestore Database)
    Frontend --> Backend(Node.js / Express Proxy)
    Backend --> OpenRouter(OpenRouter API / Llama 3)
```

### Key Technical highlights
- **AI Fallback System**: Automatic multi-model fallback (DeepSeek, Mistral, Qwen) to ensure 99.9% AI availability.
- **Secure Proxy**: Backend proxy architecture to keep sensitive API keys safe from the client side.
- **Audit-Ready History**: Append-only message architecture to maintain conversation integrity.

---

## 🚀 Quick Start

### 1. Backend Setup
1. Navigate to the `server` directory:
   ```bash
   cd server
   npm install
   ```
2. Create your `.env` file:
   ```bash
   cp .env.example .env
   ```
3. Add your [OpenRouter API Key](https://openrouter.ai/keys) to the `.env` file.
4. **Firebase Admin Configuration (Required)**:
   The backend uses Firebase Admin for knowledge base operations and security. Configure authentication using ONE of these methods:
   - **Method A (Recommended / Production)**: Add these to your `.env`:
     ```env
     FIREBASE_PROJECT_ID="your_project_id"
     FIREBASE_CLIENT_EMAIL="your_client_email@your_project.iam.gserviceaccount.com"
     FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
     ```
   - **Method B (Local Development)**: Place your `serviceAccountKey.json` inside the `server/` directory. This is safely ignored by Git and will be loaded automatically if `NODE_ENV` is not production.
5. Start the proxy:
   ```bash
   npm start
   ```

### Health & Monitoring
The backend exposes a detailed health endpoint to verify initialization status and subsystem connectivity.
```bash
curl http://localhost:3001/api/health
```
**Example Response:**
```json
{
  "status": "healthy",
  "service": "StudyMate AI Backend",
  "firebaseAdmin": "initialized",
  "firestore": "connected",
  "authentication": "connected",
  "credentialSource": "Environment Variables",
  "uptime": 120.5,
  "version": "1.0.0",
  "timestamp": "2023-10-25T10:00:00.000Z"
}
```
*Note: Status will be `degraded` if a subsystem fails, and `unhealthy` if Firebase fails to initialize.*

### Common Troubleshooting (Backend)
- **`Error: Missing Firebase credentials`**: Ensure your `.env` contains valid credentials or `serviceAccountKey.json` is correctly placed in the `server/` directory.
- **`Warning: Local serviceAccountKey.json detected but ignored`**: You are running in production (`NODE_ENV=production`). Local files are strictly ignored. Use environment variables.
- **`Failed to parse environment variables`**: Ensure your `FIREBASE_PRIVATE_KEY` has proper `\n` characters and includes the `-----BEGIN PRIVATE KEY-----` header.

### 2. Frontend Setup
1. Update `firebase.js` with your Firebase project credentials.
2. Initialize your Firestore database with the required rules (see Security section).
3. Serve the application:
   ```bash
   # Using serve (recommended)
   npx serve .
   ```

---

## 🔒 Security & Privacy

- **Action Interceptor**: Custom `action-handler.html` completely bypasses the default Firebase UI for password resets and email verifications.
- **Data Isolation**: Firestore Security Rules ensure users can only access their own study history and tracker data.
- **Zero-Key Exposure**: All LLM requests are proxied via the Node.js backend.

---

## 🛠️ Technology Stack

- **Core**: Vanilla HTML5, CSS3 (Modern Flex/Grid), JavaScript (ESM).
- **Cloud**: Firebase Firestore & Firebase Authentication.
- **Intelligence**: OpenRouter API Integration.
- **Runtime**: Node.js & Express.js.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

---

## 👨‍💻 Developer

StudyMate AI is developed by **Rishu Maurya**.

---

<p align="center">Made with ❤️ for Students by Rishu Maurya</p>
