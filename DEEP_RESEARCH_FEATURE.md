# Deep Research Mode - Feature Documentation

## Overview

The **Deep Research Mode** is a premium feature in ZentiqAI that provides users with access to advanced AI capabilities powered by Google's Gemini API. This mode is designed for complex queries, in-depth analysis, and research-oriented conversations.

## Key Features

### 1. **Daily Message Limit**
- Users can send **6 messages per day** in Deep Research Mode
- The limit resets automatically at midnight (based on local time)
- Message count is tracked using browser localStorage
- A visual badge shows remaining messages

### 2. **Separate Chat Session**
- Deep Research has its own dedicated chat session
- History is stored separately from normal chats
- Cannot be deleted or renamed
- Automatically pinned to the sidebar

### 3. **Enhanced AI Processing**
- Uses Google Gemini API (gemini-2.5-flash by default)
- Provides more detailed, comprehensive responses
- **Sends last 12 messages for context** (maintains conversation flow)
- Optimized for research and analysis queries
- **Strict system prompt** prevents random stories and keeps responses focused
- Images analyzed with full conversation context

### 4. **Visual Design**
- Purple/violet theme to distinguish from normal chat
- Animated popup with orbital graphics
- Special header indicator when in Deep Research Mode
- Custom styling for system messages

## User Experience Flow

### Entering Deep Research Mode

1. User clicks the **"🔬 Deep Research Mode"** button in sidebar
2. Animated popup appears showing:
   - Orbital animation with research icon
   - Title: "Deep Knowledge Mode"
   - Description of the feature
   - Remaining message count
   - "Enter Deep Mode" button

3. On confirmation:
   - Modal closes with animation
   - Deep Research chat session opens
   - Header changes to show "🔬 Deep Research Mode"
   - Welcome message displays in chat

### Using Deep Research Mode

1. User types their research query
2. Message is sent to Gemini API via `/api/deep-research` endpoint
3. Loading indicator shows "🔬 Deep analyzing..."
4. Response appears in chat
5. Message count decrements by 1
6. Badge updates to show remaining messages

### Exiting Deep Research Mode

1. User switches to another chat from sidebar
2. Header automatically reverts to normal "ZentiqAI"
3. Deep Research session remains available for future use

## Technical Implementation

### Frontend (script.js)

**Key Variables:**
```javascript
let deepResearchMode = false;
let deepResearchSessionId = "deep-research-session";
let deepResearchMessages = [];
```

**Core Functions:**
- `getDeepResearchCount()` - Retrieves remaining messages from localStorage
- `saveDeepResearchCount(count)` - Saves message count with date stamp
- `updateDeepResearchBadge()` - Updates the visual badge display
- `openDeepResearchPopup()` - Shows the animated modal
- `closeDeepResearchPopup()` - Hides the modal
- `enterDeepResearchMode()` - Initializes deep research session
- `exitDeepResearchMode()` - Restores normal UI
- `sendDeepResearchMessage()` - Sends message via Gemini API

**Message Tracking:**
```javascript
// Stored in localStorage as:
{
    date: "Sat Feb 22 2026",  // Current date string
    remaining: 4               // Messages left today
}
```

### Backend (main.py)

**New Endpoint:**
```python
@app.post("/api/deep-research")
async def deep_research_endpoint(req: ChatRequest, x_auth: str = Header(None))
```

**Features:**
- Requires Gemini API keys to be configured
- Maintains conversation history for context
- Uses enhanced prompts for research-quality responses
- Handles API errors with key rotation
- Stores history separately from normal chats

**Enhanced Prompt Structure:**
```python
STRICT_SYSTEM_PROMPT = """You are ZentiqAI Deep Research Assistant. Follow these STRICT rules:

1. STAY ON TOPIC: Only answer what is directly asked.
2. BE FACTUAL: Provide accurate, well-researched information.
3. BE CONCISE: Be thorough but avoid unnecessary verbosity.
4. BE STRUCTURED: Use clear sections, bullet points, or numbered lists.
5. NO FICTION: Never make up stories or fictional examples.
6. ACKNOWLEDGE LIMITS: If you don't know something, say so directly.
7. CONTEXT AWARE: Use the conversation history intelligently.
8. FOCUS ON VALUE: Every sentence should add meaningful information.

Remember: Deep Research Mode is for serious analysis, not storytelling."""
```

**Context Management:**
- Sends **last 12 messages** to Gemini for context
- Includes text from previous image messages (marked as "[Previous image context]")
- Current image is sent with full quality for analysis
- History is maintained server-side for persistent conversations

### UI Components

**HTML Structure:**
```html
<!-- Sidebar Button -->
<button class="deep-research-btn" id="deep-research-btn">
    <span class="deep-research-icon">🔬</span>
    <span class="deep-research-text">Deep Research Mode</span>
    <span class="deep-research-badge" id="deep-research-count">6</span>
</button>

<!-- Popup Modal -->
<div id="deep-research-popup" class="modal-overlay hidden">
    <div class="deep-research-popup-box">
        <!-- Animated orbits -->
        <!-- Title and description -->
        <!-- Stats display -->
        <!-- Action buttons -->
    </div>
</div>
```

**CSS Highlights:**
- Purple gradient theme (`#8a2be2`, `#4b0082`)
- Animated orbital rings
- Pulsing icon animation
- Smooth transitions and transforms

## API Configuration

### Required Environment Variables

Add to your `.env` file:
```env
# Gemini API Keys for Deep Research
GEMINI_API_KEY_1=your-api-key-here
GEMINI_API_KEY_2=your-backup-key-here
GEMINI_API_KEY_3=your-third-key-here

# Optional: Model selection
GEMINI_MODEL=gemini-2.5-flash
```

### API Key Rotation

The system automatically rotates through available API keys when:
- Quota is exceeded
- Rate limits are hit
- Authentication errors occur

## Normal Chat Behavior

### Changes to Regular Chat

**Image Processing:**
- Gemini API integration **removed** from normal chat
- Images are now processed using **local Ollama model only**
- Reduces API costs and quota usage
- Makes deep research more valuable

### Image Handling in Deep Research

**How Images Work:**
1. **Current Image**: Sent to Gemini at full quality for analysis
2. **Previous Images**: Marked in history as "[Previous image context]" for conversation continuity
3. **Context**: Last 12 messages include references to previous images so Gemini understands the full conversation
4. **Storage**: Image data not stored permanently (only marked as "[Image]" in history)

**Example Flow:**
```
Message 1: User sends image of a graph + "What is this?"
→ Gemini analyzes image with 0 previous context

Message 2: User asks "What are the trends?"  
→ Gemini sees: 
  - Message 1: "What is this? [Previous image context]"
  - Message 1 Response: "This is a graph showing..."
  - Message 2: "What are the trends?"
  
Message 3: User sends another image + "Compare this"
→ Gemini sees:
  - Last 12 messages including context about first image
  - New image at full quality
  - Can make comparisons based on conversation history
```

**Code Changes:**
```python
# Before: Used Gemini for images in normal chat
if has_image and GEMINI_API_KEYS:
    reply = process_image_with_gemini(...)

# After: Always use local model
model_to_use = IMAGE_MODEL if has_image else TEXT_MODEL
response = ollama.chat(model=model_to_use, messages=history)
```

## User Protections

### Deep Research Chat Protection

1. **Cannot Delete:**
   - Deletion attempt shows popup: "Cannot Delete"
   - Message: "Deep Research Mode is a permanent feature..."

2. **Cannot Rename:**
   - Rename attempt shows popup: "Cannot Rename"
   - Message: "Deep Research Mode has a fixed name..."

3. **Always Available:**
   - Session persists across logins
   - History preserved in Firebase
   - Pinned to sidebar automatically

## Future Enhancements

Possible improvements for future versions:

1. **Premium Tiers:**
   - Free: 6 messages/day
   - Premium: 20 messages/day
   - Pro: Unlimited messages

2. **Advanced Features:**
   - Export research findings
   - Generate PDF reports
   - Save favorite research queries
   - Research templates

3. **Analytics:**
   - Track most researched topics
   - Time spent in deep research
   - Response quality ratings

4. **Collaboration:**
   - Share research sessions
   - Collaborate on queries
   - Team research mode

## Testing Checklist

- [ ] Click Deep Research button shows popup
- [ ] Popup displays correct remaining count
- [ ] Enter Deep Mode switches to research chat
- [ ] Header changes to purple theme
- [ ] Welcome message displays correctly
- [ ] Sending message decrements count
- [ ] Badge updates after each message
- [ ] Limit of 6 messages enforced
- [ ] Popup shows when limit reached
- [ ] Count resets at midnight
- [ ] Switching chats exits deep mode
- [ ] Cannot delete deep research chat
- [ ] Cannot rename deep research chat
- [ ] History persists across sessions
- [ ] Mobile responsive design works
- [ ] Normal chat uses local model only
- [ ] **Deep research sends last 12 messages for context**
- [ ] **Image messages marked as "[Previous image context]" in history**
- [ ] **Current image analyzed with full conversation context**
- [ ] **Strict prompt prevents random stories/tangents**
- [ ] **Gemini stays on topic and provides factual answers**

## Troubleshooting

### "Deep Research requires backend connection"
**Cause:** Backend server not running  
**Solution:** Start server with `python main.py`

### "Deep Research requires Gemini API"
**Cause:** No GEMINI_API_KEY configured  
**Solution:** Add API keys to `.env` file

### Message count not resetting
**Cause:** Browser localStorage issue  
**Solution:** Clear localStorage or change date manually

### Popup not appearing
**Cause:** JavaScript error or missing element  
**Solution:** Check browser console for errors

### Normal chat still using Gemini
**Cause:** Old cached JavaScript  
**Solution:** Hard refresh (Ctrl+Shift+R) to reload

## File Changes Summary

### Modified Files:
1. **index.html** - Added deep research button and popup modal
2. **style.css** - Added deep research styling and animations
3. **script.js** - Added deep research logic and message handling
4. **main.py** - Added `/api/deep-research` endpoint, removed Gemini from normal chat

### New Files:
- **DEEP_RESEARCH_FEATURE.md** - This documentation file

## Support

For issues or questions about Deep Research Mode:
1. Check browser console for errors
2. Verify Gemini API keys are valid
3. Ensure backend server is running
4. Check daily message count in localStorage

---

**Created:** February 22, 2026  
**Version:** 1.0  
**Feature Status:** ✅ Complete and Production Ready
