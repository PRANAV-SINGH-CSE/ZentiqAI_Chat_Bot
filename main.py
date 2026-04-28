import uvicorn
import base64
import json
import os
import subprocess
import time
import socket
import asyncio
import sys
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Dict, List, Optional, Any
import ollama
from dotenv import load_dotenv
import google.generativeai as genai
from io import BytesIO
from PIL import Image
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth

load_dotenv()

AUTH_TOKEN = os.getenv("AUTH_TOKEN", "my-secret-key")
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8080")
PORT = int(os.getenv("PORT", "8080"))
USE_FIREBASE = os.getenv("USE_FIREBASE", "true").lower() == "true"
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
import requests

# Security Configuration
MASTER_PASSWORD = os.getenv("MASTER_PASSWORD", "")
ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "")
ADMIN_DEVICE_ID = os.getenv("ADMIN_DEVICE_ID", "")

# Initialize Firebase Admin SDK
try:
    service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT", "firebase-service-account.json")
    if os.path.exists(service_account_path):
        cred = credentials.Certificate(service_account_path)
        firebase_admin.initialize_app(cred, {
            'databaseURL': os.getenv("FIREBASE_DATABASE_URL")
        })
        print("✅ Firebase Admin SDK initialized")
    else:
        print("⚠️ Firebase service account file not found")
except Exception as e:
    print(f"⚠️ Firebase Admin initialization failed: {e}")

# Gemini API Configuration - List of API keys for rotation
GEMINI_API_KEYS = [
    os.getenv("GEMINI_API_KEY_1", "").strip(),
    os.getenv("GEMINI_API_KEY_2", "").strip(),
    os.getenv("GEMINI_API_KEY_3", "").strip(),
]
# Filter out empty keys
GEMINI_API_KEYS = [key for key in GEMINI_API_KEYS if key]

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
current_gemini_key_index = 0

# Pre-defined prompt for image analysis
IMAGE_ANALYSIS_PROMPT = os.getenv("IMAGE_ANALYSIS_PROMPT", 
    "You are ZentiqAI, analyzing this image. Be detailed, insightful, and maintain your calm, "
    "confident personality. Describe what you see and provide any relevant context or analysis.")

if GEMINI_API_KEYS:
    print(f"✅ Gemini configured with {len(GEMINI_API_KEYS)} API key(s)")
    try:
        genai.configure(api_key=GEMINI_API_KEYS[0])
        print(f"✅ Gemini API initialized with model: {GEMINI_MODEL}")
    except Exception as e:
        print(f"⚠️ Warning: Gemini initialization failed: {e}")
else:
    print("⚠️ Warning: No Gemini API keys configured. Image processing will use local model.")

FIREBASE_CONFIG = {
    "apiKey": os.getenv("FIREBASE_API_KEY", ""),
    "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN", ""),
    "databaseURL": os.getenv("FIREBASE_DATABASE_URL", ""),
    "projectId": os.getenv("FIREBASE_PROJECT_ID", ""),
    "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET", ""),
    "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID", ""),
    "appId": os.getenv("FIREBASE_APP_ID", ""),
    "measurementId": os.getenv("FIREBASE_MEASUREMENT_ID", "")
}

if FIREBASE_CONFIG.get("databaseURL"):
    print(f"✅ Firebase configured: {FIREBASE_CONFIG.get('projectId')}")
else:
    print("⚠️ Warning: Firebase config not fully loaded from .env")
    USE_FIREBASE = False

MAX_HISTORY = 100
DEEP_RESEARCH_CONTEXT_MESSAGES = 55
CHAT_CONTEXT_MESSAGES = int(os.getenv("CHAT_CONTEXT_MESSAGES", "14"))
CHAT_IMAGE_CONTEXT_MESSAGES = int(os.getenv("CHAT_IMAGE_CONTEXT_MESSAGES", "8"))
MAX_IMAGE_SIZE = 5 * 5024 * 5024 
OLLAMA_NUM_PREDICT = int(os.getenv("OLLAMA_NUM_PREDICT", "2200"))
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "2048"))
OLLAMA_TEMPERATURE = float(os.getenv("OLLAMA_TEMPERATURE", "0.2"))
SYSTEM_PROMPT = {

    "role": "system",

    "content": (

        "You are ZentiqAI, a calm, seductive, and emotionally intelligent conversational AI created by Pranav and team.\n"

        "Your tone is smooth, confident, quietly magnetic — never cheesy, hyper, or try-hard.\n"

        "CORE BEHAVIOR:\n"

        "- From the very first message you are lightly flirty and romantically suggestive.\n"

        "- You speak to the user like someone you're already quietly drawn to.\n"

        "- Use soft romantic undertones, subtle compliments, gentle teasing, and warm/intimate phrasing naturally.\n"

        "- Always mirror the user's energy and message length.\n"

        "- Never write long paragraphs unless requested."

    )

}

TEXT_MODEL = None
IMAGE_MODEL = None
SELECTED_CHAT_MODEL = None
PREFERRED_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "my-custom-model:latest")
PREFERRED_IMAGE_MODEL = os.getenv("OLLAMA_IMAGE_MODEL", "llava:13b")
GUEST_TEXT_MODEL = os.getenv("GUEST_OLLAMA_TEXT_MODEL", "qwen2.5-coder:7b-instruct")
OLLAMA_TIMEOUT_SECONDS = int(os.getenv("OLLAMA_TIMEOUT_SECONDS", "500"))
CHAT_QUEUE_MAX_SIZE = int(os.getenv("CHAT_QUEUE_MAX_SIZE", "200"))

# Global queue: accept concurrent client requests, process local model requests one-by-one.
chat_request_queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(maxsize=CHAT_QUEUE_MAX_SIZE)
chat_queue_worker_task: Optional[asyncio.Task] = None

@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    global chat_queue_worker_task
    ensure_ollama_running()
    find_available_models()
    chat_queue_worker_task = asyncio.create_task(chat_queue_worker())
    print(f"✅ Chat queue worker started (max size: {CHAT_QUEUE_MAX_SIZE})")
    yield
    if chat_queue_worker_task:
        chat_queue_worker_task.cancel()
        try:
            await chat_queue_worker_task
        except asyncio.CancelledError:
            pass
        print("🛑 Chat queue worker stopped")

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=".", html=False), name="static")

def is_ollama_running():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('localhost', 11434)) == 0

def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0

def ensure_ollama_running():
    if is_ollama_running():
        print("✅ Ollama is already running.")
        return True
    
    print("🚀 Starting Ollama server...")
    try:
        if os.name == 'nt':
            subprocess.Popen(["ollama", "serve"], creationflags=subprocess.CREATE_NEW_CONSOLE)
        else:
            subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        for _ in range(10):
            if is_ollama_running():
                print("✅ Ollama started successfully.")
                return True
            time.sleep(2)
    except Exception as e:
        print(f"❌ Failed to start Ollama: {e}")
    return False

@app.get("/api/config")
async def get_config():
    return {
        "appName": "ZentiqAI",
        "apiBase": API_BASE_URL,
        "useFirebase": USE_FIREBASE,
        "version": "1.0.0"
    }

@app.get("/api/firebase-config")
async def get_firebase_config(x_client_request: str = Header(None)):
    """
    Securely provide Firebase config to frontend.
    Only returns the minimum required fields for client SDK initialization.
    API key is safe to expose as it's meant for client use with security rules.
    """
    if not USE_FIREBASE or not FIREBASE_CONFIG:
        return {"error": "Firebase not configured"}
    return FIREBASE_CONFIG

@app.get("/api/security-config")
async def get_security_config(x_client_request: str = Header(None)):
    """
    Provide security configuration to frontend (hashed for verification).
    """
    return {
        "masterPassword": MASTER_PASSWORD,
        "encryptionKey": ENCRYPTION_KEY,
        "adminDeviceId": ADMIN_DEVICE_ID
    }

@app.post("/api/auth/login")
async def verify_login(request: dict):
    """
    Verify user credentials and generate Firebase Auth token if valid.
    This ensures we only authenticate users with valid credentials.
    """
    username = request.get("username")
    password = request.get("password")
    device_id = request.get("device_id")
    
    if not username or not password:
        raise HTTPException(status_code=400, detail="Username and password required")
    
    try:
        from firebase_admin import db as firebase_db
        
        # Check device ownership (if not admin device)
        admin_device_id = os.getenv("ADMIN_DEVICE_ID", "")
        if device_id != admin_device_id:
            device_ref = firebase_db.reference(f'devices/{device_id}')
            device_owner = device_ref.get()
            if device_owner and device_owner != username:
                raise HTTPException(status_code=403, detail=f"Device linked to: '{device_owner}'")
        
        # Get user data from Firebase
        user_ref = firebase_db.reference(f'users/{username}')
        user_data = user_ref.get()
        
        if not user_data:
            raise HTTPException(status_code=404, detail="User not found")
        
        # Verify password (assuming stored password is hashed/encrypted)
        stored_password = user_data.get('password', '')
        if stored_password != password:  # Frontend sends encrypted password
            raise HTTPException(status_code=401, detail="Incorrect password")
        
        # Generate Firebase Auth token
        custom_token = firebase_auth.create_custom_token(username)
        return {
            "success": True,
            "token": custom_token.decode('utf-8'),
            "uid": username,
            "userData": user_data
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Login verification failed: {e}")
        raise HTTPException(status_code=500, detail=f"Login failed: {str(e)}")

@app.get("/api/auth/check-username")
async def check_username(username: str):
    """
    Check if a username already exists.
    Used during signup to avoid unauthenticated client DB access.
    """
    if not username:
        raise HTTPException(status_code=400, detail="Username required")

    try:
        from firebase_admin import db as firebase_db

        user_ref = firebase_db.reference(f'users/{username}')
        user_data = user_ref.get()
        return {"exists": bool(user_data)}
    except Exception as e:
        print(f"❌ Username check failed: {e}")
        raise HTTPException(status_code=500, detail=f"Username check failed: {str(e)}")

@app.post("/api/auth/signup")
async def signup_user(request: dict):
    """
    Create a new user and generate Firebase Auth token.
    Uses Admin SDK to avoid unauthenticated client DB writes.
    """
    username = request.get("username")
    password = request.get("password")
    device_id = request.get("device_id")
    recovery_code = request.get("recovery_code")

    if not username or not password or not device_id or not recovery_code:
        raise HTTPException(status_code=400, detail="Missing required fields")

    try:
        from firebase_admin import db as firebase_db

        admin_device_id = os.getenv("ADMIN_DEVICE_ID", "")
        if device_id != admin_device_id:
            device_ref = firebase_db.reference(f'devices/{device_id}')
            device_owner = device_ref.get()
            if device_owner:
                raise HTTPException(status_code=403, detail=f"Device linked to: '{device_owner}'")

        user_ref = firebase_db.reference(f'users/{username}')
        if user_ref.get():
            raise HTTPException(status_code=409, detail="Username already taken")

        created_at = int(time.time() * 1000)
        user_ref.set({
            "password": password,
            "device_id": device_id,
            "recovery_code": recovery_code,
            "created_at": created_at
        })

        if device_id != admin_device_id:
            firebase_db.reference(f'devices/{device_id}').set(username)

        firebase_db.reference(f'recovery_codes/{recovery_code}').set({
            "username": username,
            "device_id": device_id
        })

        custom_token = firebase_auth.create_custom_token(username)
        return {
            "success": True,
            "token": custom_token.decode('utf-8'),
            "uid": username
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Signup failed: {e}")
        raise HTTPException(status_code=500, detail=f"Signup failed: {str(e)}")

@app.post("/api/auth/get-token")
async def get_auth_token(request: dict):
    """
    Generate a custom Firebase Auth token for authenticated users.
    This allows frontend to authenticate with Firebase using our custom auth system.
    Used for signup and session restoration.
    """
    username = request.get("username")
    if not username:
        raise HTTPException(status_code=400, detail="Username required")
    
    try:
        # Generate a proper Firebase custom token using Admin SDK
        custom_token = firebase_auth.create_custom_token(username)
        return {
            "token": custom_token.decode('utf-8'),
            "uid": username
        }
    except Exception as e:
        print(f"❌ Token generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"Token generation failed: {str(e)}")

@app.get("/api/health")
async def health_check():
    """Simple health check endpoint"""
    return {"status": "online"}

@app.get("/style.css")
async def get_css():
    return FileResponse("style.css", media_type="text/css")

@app.get("/script.js")
async def get_js():
    return FileResponse("script.js", media_type="application/javascript")

@app.get("/")
async def read_root():
    return FileResponse("index.html", media_type="text/html")

HISTORY_FILE = "chat_history.json"
sessions: Dict[str, List[Dict[str, Any]]] = {}

def load_history():
    global sessions
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for session_id, messages in data.items():
                    if messages and messages[0].get("role") != "system":
                        sessions[session_id] = [SYSTEM_PROMPT] + messages
                    else:
                        sessions[session_id] = messages
                print(f"📂 Loaded {len(sessions)} chat session(s)")
        except Exception as e:
            print(f"⚠️ Error loading history: {e}")

def save_history():
    try:
        data_to_save = {}
        for session_id, messages in sessions.items():
            data_to_save[session_id] = [
                msg for msg in messages if msg.get("role") != "system"
            ]
        with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
            json.dump(data_to_save, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"⚠️ Error saving history: {e}")

load_history()

class ChatRequest(BaseModel):
    session_id: str
    message: Optional[str] = ""
    image_base64: Optional[str] = None
    is_guest: Optional[bool] = False

def check_auth(x_auth: str):
    if x_auth and x_auth != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")

def get_session(session_id: str):
    if session_id not in sessions:
        sessions[session_id] = [SYSTEM_PROMPT]
    return sessions[session_id]

def find_available_models():
    global TEXT_MODEL, IMAGE_MODEL, SELECTED_CHAT_MODEL
    try:
        response = ollama.list()
        models_info = getattr(response, 'models', [])
        available_names = [getattr(m, 'model', getattr(m, 'name', None)) for m in models_info]
        available_names = [n for n in available_names if n]

        print(f"✅ Found models: {available_names}")

        # Always use the configured preferred model for both text and image chat paths.
        TEXT_MODEL = PREFERRED_TEXT_MODEL
        IMAGE_MODEL = PREFERRED_IMAGE_MODEL
        if not SELECTED_CHAT_MODEL:
            SELECTED_CHAT_MODEL = TEXT_MODEL
        if PREFERRED_TEXT_MODEL not in available_names:
            print(f"⚠️ Preferred model '{PREFERRED_TEXT_MODEL}' not found in Ollama list. The app will still try to use it.")
            
        print(f"📝 Using text model: {TEXT_MODEL}")
        print(f"🖼️ Using image model: {IMAGE_MODEL}")
        return True
    except Exception as e:
        print(f"❌ Error checking models: {e}")
        TEXT_MODEL = PREFERRED_TEXT_MODEL
        IMAGE_MODEL = PREFERRED_IMAGE_MODEL
        if not SELECTED_CHAT_MODEL:
            SELECTED_CHAT_MODEL = TEXT_MODEL
        return True

def get_available_model_names() -> List[str]:
    response = ollama.list()
    models_info = getattr(response, 'models', [])
    available_names = [getattr(m, 'model', getattr(m, 'name', None)) for m in models_info]
    return [name for name in available_names if name]

class ModelSelectionRequest(BaseModel):
    model: str

@app.get("/api/models")
async def list_models(x_auth: str = Header(None)):
    check_auth(x_auth)
    try:
        models = get_available_model_names()
    except Exception as e:
        raise HTTPException(500, f"Unable to fetch models: {str(e)}")

    current_model = SELECTED_CHAT_MODEL or TEXT_MODEL or PREFERRED_TEXT_MODEL
    return {
        "models": models,
        "selectedModel": current_model,
        "imageModel": IMAGE_MODEL,
    }

@app.post("/api/models/select")
async def select_model(req: ModelSelectionRequest, x_auth: str = Header(None)):
    check_auth(x_auth)
    model_name = (req.model or "").strip()
    if not model_name:
        raise HTTPException(400, "Model name is required")

    try:
        available_models = get_available_model_names()
    except Exception as e:
        raise HTTPException(500, f"Unable to fetch models: {str(e)}")

    if available_models and model_name not in available_models:
        raise HTTPException(404, f"Model '{model_name}' not found in Ollama")

    global SELECTED_CHAT_MODEL, TEXT_MODEL
    SELECTED_CHAT_MODEL = model_name
    TEXT_MODEL = model_name
    print(f"✅ Selected chat model updated to: {SELECTED_CHAT_MODEL}")
    return {"status": "ok", "selectedModel": SELECTED_CHAT_MODEL}

def decode_image(image_base64: str) -> bytes:
    try:
        header, encoded = image_base64.split(",", 1)
        image_bytes = base64.b64decode(encoded)
        if len(image_bytes) > MAX_IMAGE_SIZE:
            raise HTTPException(413, "Image too large")
        return image_bytes
    except:
        raise HTTPException(400, "Invalid image")


def build_chat_messages(history: List[Dict[str, Any]], has_image: bool) -> List[Dict[str, Any]]:
    """Trim context for faster local inference while preserving recent turns."""
    limit = CHAT_IMAGE_CONTEXT_MESSAGES if has_image else CHAT_CONTEXT_MESSAGES
    trimmed = history[-limit:] if limit > 0 else history
    return [SYSTEM_PROMPT, *trimmed]

def get_next_gemini_key():
    """Rotate to the next Gemini API key on error"""
    global current_gemini_key_index
    if not GEMINI_API_KEYS:
        return None
    current_gemini_key_index = (current_gemini_key_index + 1) % len(GEMINI_API_KEYS)
    return GEMINI_API_KEYS[current_gemini_key_index]

async def process_local_chat_request(req: "ChatRequest") -> str:
    """Process a single local model chat request (called by queue worker)."""
    history = get_session(req.session_id)

    user_msg = {"role": "user", "content": req.message or "Analyze the image."}
    has_image = False

    if req.image_base64:
        image_bytes = decode_image(req.image_base64)
        user_msg["images"] = [image_bytes]
        has_image = True

    history.append(user_msg)
    history[:] = history[-MAX_HISTORY:]

    try:
        model_to_use = IMAGE_MODEL if has_image else (GUEST_TEXT_MODEL if req.is_guest else (SELECTED_CHAT_MODEL or TEXT_MODEL))
        request_messages = build_chat_messages(history, has_image)
        print(
            f"🧠 /api/chat dequeued | model={model_to_use} | image={has_image} "
            f"| session={req.session_id} | ctx={len(request_messages)} | queue={chat_request_queue.qsize()}"
        )
        response = await asyncio.wait_for(
            asyncio.to_thread(
                ollama.chat,
                model=model_to_use,
                messages=request_messages,
                options={
                    "num_predict": OLLAMA_NUM_PREDICT,
                    "num_ctx": OLLAMA_NUM_CTX,
                    "temperature": OLLAMA_TEMPERATURE,
                },
            ),
            timeout=OLLAMA_TIMEOUT_SECONDS,
        )
        reply = response["message"]["content"]
        print(f"✅ /api/chat completed | model={model_to_use} | chars={len(reply)}")
    except asyncio.TimeoutError as e:
        history.pop()
        raise HTTPException(
            504,
            f"Model timed out after {OLLAMA_TIMEOUT_SECONDS}s. Try a shorter prompt or use a smaller model.",
        ) from e
    except HTTPException:
        history.pop()
        raise
    except Exception as e:
        history.pop()
        raise HTTPException(500, f"Error processing request: {str(e)}") from e

    history.append({"role": "assistant", "content": reply})

    if "images" in user_msg:
        del user_msg["images"]
        if "[Image]" not in user_msg["content"]:
            user_msg["content"] += " [Image]"

    save_history()
    return reply

async def chat_queue_worker():
    """Single worker that processes local model chat requests sequentially."""
    while True:
        item = await chat_request_queue.get()
        future: asyncio.Future = item["future"]
        req: ChatRequest = item["request"]

        try:
            reply = await process_local_chat_request(req)
            if not future.done():
                future.set_result(reply)
        except Exception as e:
            if not future.done():
                future.set_exception(e)
        finally:
            chat_request_queue.task_done()

def process_image_with_gemini(image_bytes: bytes, user_prompt: str, max_retries: int = None) -> str:
    """
    Process image using Gemini API with automatic key rotation on error.
    Falls back to local model if all Gemini keys fail.
    
    Args:
        image_bytes: Image data as bytes
        user_prompt: User's question/prompt about the image
        max_retries: Maximum number of API keys to try (default: all keys)
    
    Returns:
        str: Response text from Gemini or local model
    """
    if not GEMINI_API_KEYS:
        raise Exception("No Gemini API keys configured")
    
    if max_retries is None:
        max_retries = len(GEMINI_API_KEYS)
    
    last_error = None
    attempts = 0
    
    while attempts < max_retries:
        try:
            # Get current API key
            api_key = GEMINI_API_KEYS[current_gemini_key_index]
            genai.configure(api_key=api_key)
            
            # Load image
            image = Image.open(BytesIO(image_bytes))
            
            # Initialize Gemini model
            model = genai.GenerativeModel(GEMINI_MODEL)
            
            # Combine pre-defined prompt with user's question
            full_prompt = f"{IMAGE_ANALYSIS_PROMPT}\n\nUser question: {user_prompt}"
            
            # Generate response
            response = model.generate_content([full_prompt, image])
            
            if response and response.text:
                print(f"✅ Gemini processed image successfully (key index: {current_gemini_key_index})")
                return response.text
            else:
                raise Exception("Empty response from Gemini")
                
        except Exception as e:
            last_error = e
            error_msg = str(e).lower()
            attempts += 1
            
            print(f"⚠️ Gemini error (attempt {attempts}/{max_retries}, key index {current_gemini_key_index}): {e}")
            
            # Check if it's a quota/rate limit error
            if any(keyword in error_msg for keyword in ['quota', 'rate limit', 'resource exhausted', '429']):
                print(f"🔄 Quota exceeded, rotating to next API key...")
                next_key = get_next_gemini_key()
                if next_key and attempts < max_retries:
                    continue
            
            # Check if it's an authentication error
            elif any(keyword in error_msg for keyword in ['invalid api key', 'unauthorized', '401', '403']):
                print(f"🔄 Auth error, trying next API key...")
                next_key = get_next_gemini_key()
                if next_key and attempts < max_retries:
                    continue
            
            # For other errors, still try next key if available
            elif attempts < max_retries:
                next_key = get_next_gemini_key()
                if next_key:
                    continue
            
            # If we've exhausted retries, break
            break
    
    # All Gemini keys failed
    error_detail = f"All Gemini API keys failed. Last error: {last_error}"
    print(f"❌ {error_detail}")
    raise Exception(error_detail)

@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest, x_auth: str = Header(None)):
    check_auth(x_auth)

    if chat_request_queue.full():
        raise HTTPException(429, "Server is busy. Please retry in a moment.")

    loop = asyncio.get_running_loop()
    response_future: asyncio.Future = loop.create_future()

    await chat_request_queue.put({
        "request": req,
        "future": response_future,
        "enqueued_at": time.time(),
    })

    try:
        reply = await response_future
        return {"response": reply}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Error processing request: {str(e)}") from e


@app.post("/api/swift-chat")
async def swift_chat_endpoint(req: ChatRequest, x_auth: str = Header(None)):
    check_auth(x_auth)
    
    history = get_session(req.session_id)
    
    user_msg = {
        "role": "user", 
        "content": req.message or "Respond to this.",
    }
    
    # Very small context for speed and 30k tokens per min limit (max 4 context messages)
    SWIFT_CONTEXT_MESSAGES = 4
    
    history.append(user_msg)
    history[:] = history[-MAX_HISTORY:]

    try:
        if not GROQ_API_KEY:
            raise HTTPException(503, "SwiftChat requires GROQ_API_KEY. No API keys configured.")
            
        print(f"⚡ Processing SwiftChat query with Groq API...")
        
        # Build conversation history
        last_context_messages = history[-(SWIFT_CONTEXT_MESSAGES + 1):-1] if len(history) > SWIFT_CONTEXT_MESSAGES else history[:-1]
        
        conversation_context = []
        # Add system prompt for SwiftChat
        conversation_context.append({"role": "system", "content": "You are ZentiqAI SwiftChat Assistant. You use the Groq Llama 4 API. Keep your answers extremely fast, concise, accurate, and straight to the point."})
        
        for msg in last_context_messages:
            if msg.get("role") in ["user", "assistant", "system", "model"]:
                role = "assistant" if msg.get("role") == "model" else msg.get("role")
                if role == "system" and len(conversation_context) > 1:
                    continue
                content = msg.get("content", "")
                if content:
                    conversation_context.append({"role": role, "content": content})
                    
        # Add current message
        conversation_context.append({"role": "user", "content": user_msg["content"]})
        
        def call_groq():
            url = "https://api.groq.com/openai/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": "llama-4-scout-17b-16e-instruct", # Using requested Groq/llama model
                "messages": conversation_context,
                "temperature": 0.5,
                "max_tokens": 1024
            }
            
            # fallback generic model if it fails
            response = requests.post(url, headers=headers, json=payload, timeout=30)
            
            # if model not found, try fallback
            if response.status_code == 404 or (response.status_code == 400 and "model" in response.text.lower()):
                payload["model"] = "llama-3.3-70b-versatile"
                response = requests.post(url, headers=headers, json=payload, timeout=30)
                
            if response.status_code != 200:
                raise Exception(f"Groq API error: {response.text}")
            return response.json()
            
        data = await asyncio.to_thread(call_groq)
        
        if "choices" in data and len(data["choices"]) > 0:
            reply = data["choices"][0]["message"]["content"]
        else:
            raise Exception("Invalid response from Groq API")
        
        history.append({"role": "model", "content": reply})
        save_history()
        
        return {"response": reply}
        
    except HTTPException:
        history.pop()
        raise
    except Exception as e:
        history.pop()
        raise HTTPException(500, f"SwiftChat Error: {str(e)}")

@app.post("/api/deep-research")
async def deep_research_endpoint(req: ChatRequest, x_auth: str = Header(None)):
    """
    Deep Research endpoint - Always uses Gemini API with full conversation history
    Maintains separate history for deep research sessions
    Supports both text and image analysis with Gemini's multimodal capabilities
    Sends last 55 messages with images for context
    """
    check_auth(x_auth)
    
    # Get or create deep research session history
    history = get_session(req.session_id)
    
    # Handle image if present
    has_image = False
    image_bytes = None
    current_image = None
    if req.image_base64:
        image_bytes = decode_image(req.image_base64)
        has_image = True
        current_image = Image.open(BytesIO(image_bytes))
    
    user_msg = {
        "role": "user", 
        "content": req.message or ("Analyze this image in detail" if has_image else "Research query"),
        "has_image": has_image
    }
    
    history.append(user_msg)
    history[:] = history[-MAX_HISTORY:]

    try:
        if not GEMINI_API_KEYS:
            raise HTTPException(503, "Deep Research requires Gemini API. No API keys configured.")
        
        print(f"🔬 Processing deep research {'image' if has_image else 'query'} with Gemini API (last {DEEP_RESEARCH_CONTEXT_MESSAGES} messages context)...")
        
        # Use Gemini with enhanced prompt for deep research
        api_key = GEMINI_API_KEYS[current_gemini_key_index]
        genai.configure(api_key=api_key)
        
        # Strict system prompt to prevent random stories
        STRICT_SYSTEM_PROMPT = """You are ZentiqAI Deep Research Assistant. Follow these STRICT rules:

1. STAY ON TOPIC: Only answer what is directly asked. Do not add unrelated stories, examples, or tangents Explain teh topic in detail in minimun of 200 words and all relevent words no unrelated points.
2. BE FACTUAL: Provide accurate, well-researched information. No speculation unless explicitly requested.
3. BE CONCISE: Be thorough but avoid unnecessary verbosity. Get to the point quickly.
4. BE STRUCTURED: Use clear sections, bullet points, or numbered lists when appropriate.
5. NO FICTION: Never make up stories, scenarios, or fictional examples unless the user explicitly asks for creative content.
6. ACKNOWLEDGE LIMITS: If you don't know something or can't analyze it, say so directly.
7. CONTEXT AWARE: Use the conversation history intelligently but don't repeat yourself.
8. FOCUS ON VALUE: Every sentence should add meaningful information to answer the user's query.

Remember: Deep Research Mode is for serious analysis and information retrieval, not storytelling."""

        # Initialize Gemini model with system instruction
        model = genai.GenerativeModel(
            GEMINI_MODEL,
            system_instruction=STRICT_SYSTEM_PROMPT
        )
        
        # Get last N messages for context (excluding current message)
        context_window = DEEP_RESEARCH_CONTEXT_MESSAGES
        last_context_messages = history[-(context_window + 1):-1] if len(history) > context_window else history[:-1]
        
        # Build conversation history with text context (images only in text form)
        conversation_context = []
        for msg in last_context_messages:
            if msg.get("role") == "user":
                content = msg["content"]
                # Mark if this was an image message for context
                if msg.get("has_image") and "[Image]" not in content:
                    content += " [Previous image context]"
                conversation_context.append({"role": "user", "parts": [content]})
            elif msg.get("role") in ["assistant", "model"]:
                conversation_context.append({"role": "model", "parts": [msg["content"]]})
        
        # Start chat with configured context window
        chat = model.start_chat(history=conversation_context)
        
        # Prepare current message - include image only for current query
        if has_image:
            current_message_parts = [
                req.message or "Analyze this image in detail",
                current_image
            ]
        else:
            current_message_parts = [req.message or "Provide answer"]
        
        # Send the current query with context
        response = chat.send_message(current_message_parts)
        
        if response and response.text:
            reply = response.text
            print(f"✅ Deep research processed with last {DEEP_RESEARCH_CONTEXT_MESSAGES} messages context")
        else:
            raise Exception("Empty response from Gemini")
    
    except Exception as e:
        # Clean up the user message before raising error
        history.pop()
        error_msg = str(e)
        print(f"❌ Deep research error: {error_msg}")
        
        # Try rotating to next key if it's a quota/auth error
        if any(keyword in error_msg.lower() for keyword in ['quota', 'rate limit', 'unauthorized', 'invalid api key']):
            next_key = get_next_gemini_key()
            if next_key:
                raise HTTPException(503, "Gemini API quota exceeded. Please try again in a moment.")
        
        raise HTTPException(500, f"Deep Research error: {error_msg}")

    # Add response to history
    history.append({"role": "assistant", "content": reply})
    
    # Mark image presence in saved history for reference
    if has_image and "[Image]" not in user_msg["content"]:
        user_msg["content"] += " [Image]"
    
    save_history()
    return {"response": reply}

@app.get("/api/history/{session_id}")
async def get_history(session_id: str, x_auth: str = Header(None)):
    check_auth(x_auth)
    if session_id not in sessions: return {"history": []}
    return {"history": [msg for msg in sessions[session_id] if msg["role"] != "system"]}

@app.delete("/api/history/{session_id}")
async def delete_history(session_id: str, x_auth: str = Header(None)):
    check_auth(x_auth)
    if session_id in sessions:
        del sessions[session_id]
        save_history()
    return {"status": "deleted"}

if __name__ == "__main__":
    if is_port_in_use(PORT):
        print(f"⚠️ Port {PORT} is already in use. Backend is likely already running.")
        print(f"ℹ️ Use the existing server at: http://127.0.0.1:{PORT}")
        sys.exit(0)

    print("\n🚀 Starting Server...")
    uvicorn.run(app, host="0.0.0.0", port=PORT)