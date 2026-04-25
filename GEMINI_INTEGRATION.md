# Gemini API Integration Guide for ZentiqAI

## Overview

The system now intelligently handles image processing using **Google's Gemini API** while maintaining **text conversations with your local Ollama model**. This hybrid approach gives you the best of both worlds:

- **Images**: Processed by Gemini API (superior image understanding capabilities)
- **Text**: Processed by local Ollama model (privacy, speed, no API costs)
- **Context**: Image analysis from Gemini is added to conversation history so the local model can continue discussing that image

## Setup Instructions

### 1. Get Gemini API Keys

1. Visit [Google AI Studio](https://ai.google.dev/)
2. Click "Get API Key" and create a new free API key
3. You can create multiple keys for key rotation and quota management
4. Keep these keys safe and never commit them to version control

### 2. Update `.env` File

Copy `.env.example` to `.env` and add your Gemini API keys:

```env
# Add individual API keys (you can have up to 3)
GEMINI_API_KEY_1=sk-xxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY_2=sk-yyyyyyyyyyyyyyyyyyyyy
GEMINI_API_KEY_3=sk-zzzzzzzzzzzzzzzzzzzzz

# Optional: Choose model (default: gemini-1.5-flash)
# Use gemini-1.5-flash for speed (faster responses, free tier friendly)
# Use gemini-1.5-pro for better quality (slower, requires paid API)
GEMINI_MODEL=gemini-1.5-flash

# Optional: Custom image analysis prompt
IMAGE_ANALYSIS_PROMPT=You are ZentiqAI analyzing images...
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

The `google-generativeai` package is now included.

## How It Works

### Image Processing Flow

```
User sends message + image
         ↓
    Has Gemini keys?
         ↓
       YES → Use Gemini API to analyze image
         ↓
    Response + image context added to conversation history
         ↓
    User continues chat → Local model can discuss the image
```

### Automatic API Key Rotation

The system automatically rotates through your API keys when:

- **Quota exceeded** - Switches to next key automatically
- **Rate limit hit** - Tries the next key in rotation
- **Auth error** - Moves to next key (invalid key scenario)
- **Other errors** - Attempts remaining keys before failing

**Example with 3 keys:**
```
Key 1 quota exceeded → Try Key 2
Key 2 works → Continue
```

### Fallback Behavior

1. **If all Gemini keys fail** → Falls back to local Ollama model
2. **If no Gemini keys configured** → Uses local Ollama model for all messages
3. **If local model fails** → Returns detailed error

## Error Handling

The system provides comprehensive error handling:

```python
try:
    # Use Gemini for images
except GeminiError:
    # Fall back to local model
except LocalModelError:
    # Return error with details
```

### Common Errors & Solutions

| Error | Cause | Solution |
|-------|-------|----------|
| "Invalid API key" | Wrong key format | Check your .env file, regenerate key from Google AI Studio |
| "Quota exceeded" | Too many API calls | Use multiple keys for rotation, or upgrade to paid plan |
| "Rate limit" | Too many requests | Wait a moment, add more API keys for better distribution |
| "Empty response" | Gemini couldn't process image | Try with clearer image, check image format (JPG/PNG) |

## Usage Examples

### Scenario 1: Image Analysis
```
User: [uploads medical scan image]
        ↓
System: Uses Gemini to analyze medical image
        ↓
Response: Detailed medical analysis from Gemini
        ↓
User: "What part of the body is this?"
        ↓
System: Local model answers using Gemini's context
```

### Scenario 2: Text-Only Chat
```
User: "What is machine learning?"
        ↓
System: Local Ollama model handles (no API cost)
        ↓
Response: Instant answer from local model
```

## Configuration Options

### Model Selection

**Gemini Models Available:**
- `gemini-1.5-flash` (Recommended for free tier)
  - Faster responses
  - Suitable for general image analysis
  - Better for free quota
  
- `gemini-1.5-pro` (For premium)
  - Higher quality analysis
  - Better for complex images
  - Requires paid API key

### Environment Variables

```env
GEMINI_API_KEY_1=key1                       # First API key
GEMINI_API_KEY_2=key2                       # Second API key (optional)
GEMINI_API_KEY_3=key3                       # Third API key (optional)
GEMINI_MODEL=gemini-1.5-flash               # Which Gemini model to use
IMAGE_ANALYSIS_PROMPT=Custom prompt...      # Custom system prompt for images
AUTH_TOKEN=my-secret-key                    # API authentication
API_BASE_URL=http://localhost:8080          # Server endpoint
```

## Performance Tips

1. **Use Multiple API Keys** - Distributes quota load across keys
2. **Use Flash Model** - Faster for most image analysis tasks
3. **Compress Large Images** - Reduces processing time
4. **Cache Responses** - Store Gemini responses for similar queries
5. **Local Model for Follow-ups** - Uses cached image context

## Cost Calculation

**Gemini API Pricing (as of 2024):**
- Free tier: 60 requests/minute
- Flash model: Cheapest option for images
- Pro model: Higher quality, higher cost

**Sample Monthly Cost:**
- 100 image analyses/month = ~$0.01-0.05 (Flash model)
- Unlimited text chats with local model = $0
- **Total: Minimal cost**

## Monitoring & Logging

The server logs all API interactions:

```
✅ Gemini configured with 2 API key(s)
✅ Gemini API initialized with model: gemini-1.5-flash

📸 Processing image with Gemini API...
✅ Image processed successfully by Gemini
```

Watch for these log messages:
- `✅` = Success
- `⚠️` = Warning (key rotated, fallback used)
- `❌` = Error (all systems failed)

## Troubleshooting

### No API keys configured
```
⚠️ Warning: No Gemini API keys configured. Image processing will use local model.
```
**Fix:** Add at least one key (`GEMINI_API_KEY_1`) to `.env` file

### All keys failing
```
❌ All Gemini API keys failed. Last error: ...
⚠️ Falling back to local model for image processing...
```
**Fix:** Check your API keys are valid, check rate limits, add more keys

### Local model also failing
```
Error processing request: Both Gemini and local model failed
```
**Fix:** Ensure Ollama is running with `ollama serve`

## API Endpoint Details

### POST `/api/chat`

**Request:**
```json
{
  "session_id": "session-123",
  "message": "Analyze this diagram",
  "image_base64": "data:image/png;base64,iVBORw0KGgoAAAANS..."
}
```

**Response:**
```json
{
  "response": "The diagram shows... [Gemini analysis or local response]"
}
```

**Features:**
- Image context automatically added to history
- Local model can reference image in follow-up messages
- Automatic fallback if Gemini unavailable

## Security Notes

1. **Never commit `.env` file** - Add to `.gitignore`
2. **Rotate API keys** - Replace periodically in Google AI Studio
3. **Monitor quote usage** - Check API dashboard regularly
4. **Use auth token** - Set `AUTH_TOKEN` to secure your endpoint

## Advanced Configuration

### Custom Image Prompt

Modify `IMAGE_ANALYSIS_PROMPT` in `.env`:

```env
IMAGE_ANALYSIS_PROMPT=You are a medical AI. Analyze this medical image in detail. Be precise and professional.
```

This prompt is combined with the user's question automatically.

### Key Rotation Strategy

The system uses **round-robin rotation**:
- Distributes requests across all keys
- Prevents single key quota exhaustion
- Automatic on errors

## Future Enhancements

Potential improvements:
1. ✅ Vision model integration (Done: Gemini API)
2. ⏳ Image caching for identical images
3. ⏳ Batch image processing
4. ⏳ Custom model fine-tuning
5. ⏳ Cost monitoring dashboard

## Support

For issues:
1. Check `.env` configuration
2. Review server logs
3. Verify API keys are valid
4. Ensure Ollama is running
5. Check internet connection

---

**Created:** Feb 2025  
**Model:** Claude Haiku 4.5  
**Status:** Production Ready
