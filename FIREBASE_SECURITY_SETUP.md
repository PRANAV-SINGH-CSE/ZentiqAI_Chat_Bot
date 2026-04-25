# 🔐 Firebase Security Setup Guide

## ⚠️ Update (Frontend-Only Auth)

The app now uses Firebase client email/password auth directly from the frontend for login/signup/history.
Backend custom-token endpoints are no longer required for normal auth flow.

Use Vercel environment variables and `generate-env.js` to build `env.js` at deploy time.
Keep Python backend only for AI response endpoints (`/api/chat`, `/api/deep-research`) when needed.

## ✅ What's Been Done

1. **Moved credentials to `.env`**: Firebase config, master password, encryption key, and admin device ID are now secure
2. **Added Firebase Authentication**: Frontend now imports `getAuth` and `signInWithCustomToken`
3. **Backend endpoints created**: `/api/security-config` and `/api/auth/get-token`
4. **Authentication flow updated**: Login and signup now authenticate with Firebase Auth

## 🔧 Required Setup

### Step 1: Install Firebase Admin SDK

Open PowerShell in your project folder and run:

```powershell
pip install firebase-admin
```

### Step 2: Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: **autotype-1d493**
3. Click the gear icon ⚙️ → **Project settings**
4. Go to **Service accounts** tab
5. Click **Generate new private key**
6. Save the JSON file as `firebase-service-account.json` in your project root

### Step 3: Update `.env` File

Add this line to your `.env`:

```env
FIREBASE_SERVICE_ACCOUNT=firebase-service-account.json
```

### Step 4: Update `main.py` Backend Code

Replace the auth token generation code with proper Firebase Admin SDK:

**At the top of `main.py`, add:**

```python
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth
```

**After loading environment variables, add:**

```python
# Initialize Firebase Admin SDK
try:
    service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT", "firebase-service-account.json")
    if os.path.exists(service_account_path):
        cred = credentials.Certificate(service_account_path)
        firebase_admin.initialize_app(cred, {
            'databaseURL': FIREBASE_CONFIG.get("databaseURL")
        })
        print("✅ Firebase Admin SDK initialized")
    else:
        print("⚠️ Firebase service account file not found")
except Exception as e:
    print(f"⚠️ Firebase Admin initialization failed: {e}")
```

**Replace the `/api/auth/get-token` endpoint with:**

```python
@app.post("/api/auth/get-token")
async def get_auth_token(request: dict):
    """
    Generate a custom Firebase Auth token for authenticated users.
    This allows frontend to authenticate with Firebase using our custom auth system.
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
```

## 🛡️ Firebase Security Rules

Copy and paste these rules into your Firebase Realtime Database Rules:

```json
{
  "rules": {
    // Users data - authenticated users can read their own data
    "users": {
      "$username": {
        ".read": "$username === auth.uid",
        ".write": "$username === auth.uid || !data.exists()"
      }
    },
    
    // Chat data - users can only access their own chats
    "chats": {
      "$username": {
        ".read": "$username === auth.uid",
        ".write": "$username === auth.uid",
        "meta": {
          ".read": "$username === auth.uid",
          ".write": "$username === auth.uid"
        },
        "$sessionId": {
          ".read": "$username === auth.uid",
          ".write": "$username === auth.uid"
        }
      }
    },
    
    // Device mappings - only writable during registration
    "devices": {
      "$deviceId": {
        ".read": "auth != null",
        ".write": "!data.exists() || auth != null"
      }
    },
    
    // Recovery codes - only accessible by authenticated users
    "recovery_codes": {
      "$code": {
        ".read": "auth != null",
        ".write": "!data.exists() || auth != null"
      }
    },
    
    // Feedback - authenticated users can submit feedback
    "feedback": {
      "$feedbackId": {
        ".read": false,
        ".write": "auth != null && !data.exists()"
      }
    },
    
    // Settings (like terms) - public read, no write
    "settings": {
      ".read": true,
      ".write": false
    }
  }
}
```

## 🚀 How It Works

### Login Flow:
1. User enters username/password
2. Frontend verifies credentials in database (custom auth)
3. If valid, backend generates Firebase custom token
4. Frontend signs in to Firebase Auth with that token
5. Firebase Security Rules now recognize the user as authenticated
6. User can read/write their own data

### Security Benefits:
✅ **Username-based authentication**: Your custom auth system preserved  
✅ **Firebase-secured data**: Database protected by Firebase Security Rules  
✅ **User isolation**: Each user can only access their own data  
✅ **Master password**: Still works for admin access  
✅ **No exposed credentials**: All secrets in `.env` and service account file

## 🔍 Testing

After setup, test the security:

1. **Login** with a user account
2. Open browser console and check: `firebase.auth().currentUser`
3. Should see user object with `uid` matching username
4. Try accessing another user's data - should be denied by security rules

## 📝 Important Notes

- **Service account file**: Keep `firebase-service-account.json` secure - add to `.gitignore`
- **Security rules**: Users authenticate via custom tokens with their username as UID
- **Guest mode**: Currently won't work with strict Firebase rules - consider adding guest handling
- **Master password**: Works for login but generates same Firebase token as normal user

## 🎯 Current Status

✅ Frontend updated with Firebase Auth  
✅ Backend endpoints created  
✅ Security config moved to `.env`  
⏳ **Next**: Install Firebase Admin SDK and update token generation  
⏳ **Next**: Apply new security rules to Firebase Console

---

**Once you complete the setup steps above, your Firebase database will be fully secured! 🔐**
