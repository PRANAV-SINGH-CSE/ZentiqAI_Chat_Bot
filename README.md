# AI Chatbot - Local Setup

A local AI chatbot application using Ollama models.

## Frontend-Only Firebase Auth (Vercel)

The login/signup/chat-history flow now works directly from the frontend with Firebase.
This means users can still sign in and view their chat history even when the Python backend is offline.

### Required Vercel Environment Variables

Set these in your Vercel project settings:

```env
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_DATABASE_URL=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
FIREBASE_MEASUREMENT_ID=

# Optional security values used in frontend logic
MASTER_PASSWORD=
ENCRYPTION_KEY=
ADMIN_DEVICE_ID=

# Optional: AI backend URL for /api/chat and /api/deep-research
API_BASE=

# Optional Ollama tuning
OLLAMA_TEXT_MODEL=my-custom-model:latest
OLLAMA_IMAGE_MODEL=llava:13b
OLLAMA_NUM_PREDICT=1024
OLLAMA_NUM_CTX=2048
OLLAMA_TIMEOUT_SECONDS=300
```

During build, `generate-env.js` creates `env.js` from these values.

### Important Firebase Rule Pattern

Username login is mapped to Firebase email auth as:

`<username>@zentiq.local`

Apply `FIREBASE_DATABASE_RULES.json` to allow users to access only their own username-scoped records.

## Prerequisites

1. **Python 3.8+** installed on your computer
2. **Ollama** installed and running locally
   - Download from: https://ollama.ai
   - After installation, pull the required models:
     ```bash
   ollama pull my-custom-model:latest
     ```

## Installation

1. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Running the Application

1. Make sure Ollama is running on your computer (it should start automatically)

2. Start the FastAPI server:
   ```bash
   python main.py
   ```

3. Open your web browser and navigate to:
   ```
   http://localhost:8000
   ```

## Features

- 💬 Text chat using the configured Ollama model
- 🖼️ Image analysis using the configured Ollama model
- 💾 Conversation history stored in browser localStorage
- 🎨 Modern, responsive UI

## Troubleshooting

### "Model 'my-custom-model:latest' not found" Error

If you see this error, you need to install the Ollama models:

**Windows:**
```bash
# Run the installer script
install_models.bat

# Or manually:
ollama pull my-custom-model:latest
```

**Linux/Mac:**
```bash
# Make script executable and run
chmod +x install_models.sh
./install_models.sh

# Or manually:
ollama pull my-custom-model:latest
```

### Other Common Issues

- **"Model failed" error**: Make sure Ollama is running and you have pulled the models
- **"Cannot connect to Ollama"**: 
  - Make sure Ollama is installed from https://ollama.ai
  - On Windows, ensure Ollama service is running
  - Try restarting Ollama
- **Connection refused**: Ensure the server is running on port 8000 and no other application is using that port
- **Static files not loading**: Make sure you're accessing the app via `http://localhost:8000` (not `file://`)

## Notes

- The application runs entirely on your local machine
- No internet connection required after initial setup
- All data stays on your computer
