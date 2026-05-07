// ==========================================
// 1. FIREBASE CONFIGURATION & IMPORTS
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, child, update, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
    getAuth,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut as firebaseSignOut,
    onAuthStateChanged,
    EmailAuthProvider,
    reauthenticateWithCredential,
    updatePassword as updateFirebasePassword,
    GoogleAuthProvider,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Firebase config is injected through env.js (generated from env vars in Vercel build)
let firebaseConfig = null;

let app = null;
let db = null;
let auth = null;

// ==========================================
// 2. APP CONFIG & STATE
// ==========================================


const defaultRuntimeConfig = {
    apiBase: "https://illegible-maxima-experienced.ngrok-free.dev",
    firebase: {
        // Firebase Web config is safe to expose in client apps.
        // Keep this fallback so app boots even if env.js is missing on host.
        apiKey: "AIzaSyBI6lvnetMIOHED-kUWvokIqXqDoKm83Ac",
        authDomain: "autotype-1d493.firebaseapp.com",
        databaseURL: "https://autotype-1d493-default-rtdb.firebaseio.com",
        projectId: "autotype-1d493",
        storageBucket: "autotype-1d493.firebasestorage.app",
        messagingSenderId: "171418476986",
        appId: "1:171418476986:web:06d5fa10aea9e02c57fd83",
        measurementId: "G-8DN88C22ZJ"
    }
};

const runtimeConfig =
    (typeof window !== "undefined" && window.__ZENTIQ_CONFIG__ && window.__ZENTIQ_CONFIG__.firebase && window.__ZENTIQ_CONFIG__.firebase.apiKey)
        ? window.__ZENTIQ_CONFIG__
        : defaultRuntimeConfig;
const localHostNames = ["localhost", "127.0.0.1", "::1"];
const isLocalhost = typeof window !== "undefined" && localHostNames.includes(window.location.hostname);
const configuredApiBase = (runtimeConfig.apiBase || "").trim();
const API_BASE = configuredApiBase || (isLocalhost ? "http://127.0.0.1:8080" : "");

const USE_FIREBASE = true; // Always use Firebase for storage

// Chat Data
let currentUser = "guest"; // No auth - everyone is a guest
let isGuest = true; // Always in guest mode
let currentSessionId = "session-init"; 
let chatSessions = {}; 
let messageCache = {};
let pendingImageBase64 = null;

// Global State
let isSending = false;
let serverOffline = false; // Track server status
let selectedChatModel = null;

// ==========================================
// PASSWORD ENCRYPTION & MASTER PASSWORD
// ==========================================
// Security values are used by frontend auth logic.
// They can come from env.js (preferred for static hosting) and optionally from backend /api/security-config.
let MASTER_PASSWORD = String(runtimeConfig?.security?.masterPassword || "");
let ENCRYPTION_KEY = String(runtimeConfig?.security?.encryptionKey || "default-key");
let ADMIN_DEVICE_ID = String(runtimeConfig?.security?.adminDeviceId || "");
let DB_MASTER_PASSWORD = "";
let lastMasterPasswordFetchAt = 0;

function normalizeUsername(username) {
    return String(username || "").trim().toLowerCase();
}

function usernameToEmail(username) {
    return `${normalizeUsername(username)}@zentiq.local`;
}

function emailToUsername(email) {
    if (!email || !email.includes("@")) return null;
    return normalizeUsername(email.split("@")[0] || "");
}

async function getAuthenticatedUsername() {
    if (!auth || !auth.currentUser) return null;

    const firebaseUser = auth.currentUser;
    const fallbackUsername = emailToUsername(firebaseUser.email);
    const providerIds = (firebaseUser.providerData || []).map((p) => p?.providerId);
    const isGoogleUser = providerIds.includes("google.com");

    if (!isGoogleUser || !db || !firebaseUser.uid) {
        return fallbackUsername;
    }

    try {
        const mappingSnap = await get(child(ref(db), `auth_uid_index/${firebaseUser.uid}`));
        if (mappingSnap.exists()) {
            const mappedUsername = normalizeUsername(mappingSnap.val());
            if (mappedUsername) return mappedUsername;
        }
    } catch (_) {
        // Fall back to email-derived username on transient mapping read errors.
    }

    return fallbackUsername;
}

function waitForInitialAuthState() {
    if (!auth) return Promise.resolve(null);
    return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            unsubscribe();
            resolve(user);
        });
    });
}

async function loadSecurityConfig() {
    // env.js values take precedence when present.
    if (MASTER_PASSWORD || ADMIN_DEVICE_ID || (ENCRYPTION_KEY && ENCRYPTION_KEY !== "default-key")) {
        return;
    }

    if (!API_BASE || !API_BASE.trim()) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/security-config`, {
            headers: { "ngrok-skip-browser-warning": "true" },
            signal: AbortSignal.timeout(2500)
        });
        if (!response.ok) return;

        const config = await response.json();
        MASTER_PASSWORD = String(config?.masterPassword || MASTER_PASSWORD || "");
        ENCRYPTION_KEY = String(config?.encryptionKey || ENCRYPTION_KEY || "default-key");
        ADMIN_DEVICE_ID = String(config?.adminDeviceId || ADMIN_DEVICE_ID || "");
    } catch (_) {
        // Keep defaults; app can still work without backend security config.
    }

    await refreshMasterPasswordFromDb(true);
}

async function refreshMasterPasswordFromDb(force = false) {
    if (!db) return DB_MASTER_PASSWORD;

    const now = Date.now();
    if (!force && lastMasterPasswordFetchAt && now - lastMasterPasswordFetchAt < 30000) {
        return DB_MASTER_PASSWORD;
    }

    try {
        const securityMasterSnap = await get(child(ref(db), "settings/security/master_password"));
        if (securityMasterSnap.exists()) {
            DB_MASTER_PASSWORD = String(securityMasterSnap.val() || "").trim();
        } else {
            const legacyMasterSnap = await get(child(ref(db), "settings/master_password"));
            DB_MASTER_PASSWORD = legacyMasterSnap.exists()
                ? String(legacyMasterSnap.val() || "").trim()
                : "";
        }
    } catch (_) {
        // Keep last known value on transient fetch errors.
    } finally {
        lastMasterPasswordFetchAt = now;
    }

    return DB_MASTER_PASSWORD;
}

async function isMasterPasswordMatch(inputPassword) {
    const input = String(inputPassword || "").trim();
    if (!input) return false;
    if (MASTER_PASSWORD && input === MASTER_PASSWORD) return true;

    const dbMaster = await refreshMasterPasswordFromDb();
    return Boolean(dbMaster) && input === dbMaster;
}

function buildPasswordCandidatesFromStoredValue(storedValue) {
    const candidates = [];
    const push = (value) => {
        const normalized = String(value || "").trim();
        if (normalized && !candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    push(storedValue);

    try {
        const decoded = atob(String(storedValue || ""));
        push(decoded);

        const possibleKeys = [ENCRYPTION_KEY, "default-key"];
        for (const key of possibleKeys) {
            if (key && decoded.endsWith(key)) {
                push(decoded.slice(0, -key.length));
            }
        }
    } catch (_) {
        // Stored value may not be base64; raw candidate was already added.
    }

    return candidates;
}

async function getStoredUserPassword(user) {
    try {
        const snap = await get(child(ref(db), `users/${user}/password`));
        if (!snap.exists()) return "";
        return String(snap.val() || "").trim();
    } catch (_) {
        return "";
    }
}

function doesInputMatchStoredPassword(inputPassword, storedPassword) {
    const input = String(inputPassword || "").trim();
    const stored = String(storedPassword || "").trim();
    if (!input || !stored) return false;

    if (input === stored) return true;
    if (encryptPassword(input) === stored) return true;

    const candidates = buildPasswordCandidatesFromStoredValue(stored);
    return candidates.includes(input);
}

async function resolveLoginDecision(user, inputPassword) {
    const storedPassword = await getStoredUserPassword(user);
    const hasStoredPassword = Boolean(storedPassword);

    if (hasStoredPassword && doesInputMatchStoredPassword(inputPassword, storedPassword)) {
        return {
            allowLoginAttempt: true,
            loginPasswords: buildPasswordCandidatesFromStoredValue(storedPassword),
            usedMaster: false,
            hasStoredPassword
        };
    }

    const masterMatch = await isMasterPasswordMatch(inputPassword);
    if (masterMatch && hasStoredPassword) {
        return {
            allowLoginAttempt: true,
            loginPasswords: buildPasswordCandidatesFromStoredValue(storedPassword),
            usedMaster: true,
            hasStoredPassword
        };
    }

    if (masterMatch && !hasStoredPassword) {
        return {
            allowLoginAttempt: true,
            loginPasswords: [String(inputPassword || "").trim()],
            usedMaster: true,
            hasStoredPassword
        };
    }

    // If we could read a stored password and it does not match, fail fast before Firebase request.
    if (hasStoredPassword) {
        return {
            allowLoginAttempt: false,
            loginPasswords: [],
            usedMaster: false,
            hasStoredPassword
        };
    }

    // If password could not be read (rules/cache/network), fall back to direct Firebase sign-in.
    return {
        allowLoginAttempt: true,
        loginPasswords: [String(inputPassword || "").trim()],
        usedMaster: false,
        hasStoredPassword
    };
}

async function resolveFirebaseLoginPasswords(user, inputPassword) {
    const masterActive = await isMasterPasswordMatch(inputPassword);
    if (!masterActive) return [inputPassword];

    try {
        const userSnap = await get(child(ref(db), `users/${user}`));
        if (!userSnap.exists()) return [inputPassword];

        const encryptedPassword = String(userSnap.val()?.password || "");
        if (!encryptedPassword) return [inputPassword];

        const candidates = buildPasswordCandidatesFromStoredValue(encryptedPassword);
        return candidates.length > 0 ? candidates : [inputPassword];
    } catch (_) {
        return [inputPassword];
    }
}

async function tryFirebaseSignInWithCandidates(user, passwordCandidates) {
    let lastError = null;
    for (const candidate of passwordCandidates) {
        try {
            await signInWithEmailAndPassword(auth, usernameToEmail(user), candidate);
            return candidate;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Unable to authenticate with available password candidates.");
}

async function ensureGoogleUserRecord(firebaseUser) {
    if (!db) {
        throw new Error("Database not ready. Please refresh the page.");
    }

    const email = String(firebaseUser?.email || "").trim();
    let username = normalizeUsername(email.split("@")[0] || firebaseUser?.displayName || "");
    const authUid = String(firebaseUser?.uid || "").trim();

    if (!authUid) {
        throw new Error("Google account is missing auth UID.");
    }

    // Keep a stable UID -> username map so security rules can authorize Google users.
    try {
        const uidMapSnap = await get(child(ref(db), `auth_uid_index/${authUid}`));
        if (uidMapSnap.exists()) {
            const existingMapped = normalizeUsername(uidMapSnap.val());
            if (existingMapped) {
                username = existingMapped;
            }
        }
    } catch (_) {
        // Mapping read failures should not block; write below is still attempted.
    }

    if (!username) {
        throw new Error("Google account does not provide a usable username.");
    }

    await set(ref(db, `auth_uid_index/${authUid}`), username);

    const deviceId = getDeviceId();
    const userRef = ref(db, `users/${username}`);
    const userSnap = await get(userRef).catch(() => null);
    const now = Date.now();
    const userPayload = {
        auth_provider: "google",
        email,
        display_name: String(firebaseUser?.displayName || username).trim(),
        photo_url: String(firebaseUser?.photoURL || "").trim(),
        device_id: deviceId,
        recovery_code: generateRecoveryCode(),
        created_at: now,
        last_login_at: now
    };

    if (userSnap && userSnap.exists()) {
        const existing = userSnap.val() || {};
        const updatePayload = {
            auth_provider: "google",
            email,
            display_name: String(firebaseUser?.displayName || existing.display_name || username).trim(),
            photo_url: String(firebaseUser?.photoURL || existing.photo_url || "").trim(),
            last_login_at: now
        };

        if (!existing.created_at) updatePayload.created_at = now;
        if (!existing.device_id) updatePayload.device_id = deviceId;
        if (!existing.recovery_code) updatePayload.recovery_code = userPayload.recovery_code;

        await update(userRef, updatePayload);
    } else {
        await set(userRef, userPayload);
    }

    await set(ref(db, `usernames/${username}`), true).catch(() => {});

    if (deviceId !== ADMIN_DEVICE_ID) {
        const deviceSnap = await get(child(ref(db), `devices/${deviceId}`));
        if (deviceSnap.exists() && deviceSnap.val() !== username) {
            throw new Error(`Device linked to: '${deviceSnap.val()}'`);
        }

        if (!deviceSnap.exists()) {
            await set(ref(db, `devices/${deviceId}`), username).catch(() => {});
        }
    }

    return username;
}

// Encrypt password using Base64 encoding
function encryptPassword(password) {
    try {
        // Combine password with key and encode
        const combined = password + ENCRYPTION_KEY;
        const encrypted = btoa(combined); // Base64 encode
        return encrypted;
    } catch (error) {
        console.error("Encryption error:", error);
        return password; // Fallback to plain text
    }
}

// Decrypt password
function decryptPassword(encrypted) {
    try {
        const decrypted = atob(encrypted); // Base64 decode
        const key = ENCRYPTION_KEY;
        // Remove the appended key to get original password
        if (decrypted.endsWith(key)) {
            return decrypted.slice(0, -key.length);
        }
        return decrypted; // Return as is if format is different
    } catch (error) {
        console.error("Decryption error:", error);
        return encrypted; // Fallback
    }
}

// Verify password (for login)
function verifyPassword(inputPassword, storedEncryptedPassword) {
    // Check if master password is used
    if (inputPassword === MASTER_PASSWORD || (DB_MASTER_PASSWORD && inputPassword === DB_MASTER_PASSWORD)) {
        return true; // Master password grants access to any account
    }
    
    // Encrypt the input password and compare
    const encryptedInput = encryptPassword(inputPassword);
    return encryptedInput === storedEncryptedPassword;
}

// Initialize Firebase directly from frontend runtime config
async function initializeFirebase() {
    //("🔥 Initializing Firebase...");
    
    try {
        if (!firebaseConfig) {
            firebaseConfig = runtimeConfig.firebase || null;
        }

        if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.databaseURL) {
            throw new Error("Missing Firebase config. Check env.js / Vercel env variables.");
        }
        
        app = initializeApp(firebaseConfig);
        db = getDatabase(app);
        auth = getAuth(app);
        //("✅ Firebase connected:", firebaseConfig.projectId);
        //("✅ Database ready:", db ? "YES" : "NO");
        //("✅ Auth ready:", auth ? "YES" : "NO");
        
        return true;
    } catch (error) {
        console.error("❌ Firebase initialization failed:", error.message);
        db = null;
        return false;
    }
}

// ==========================================
// 3. UI HELPER FUNCTIONS
// ==========================================

function animateModalClose(modal, onHidden) {
    if (!modal) return;
    modal.classList.add("closing");
    modal.classList.remove("active");
    setTimeout(() => {
        modal.classList.add("hidden");
        modal.classList.remove("closing");
        if (typeof onHidden === "function") {
            onHidden();
        }
    }, 280);
}

// ✨ HELPER: Toggle Preloader
// Update deep research button state based on login status
function updateDeepResearchButtonState() {
    const deepResearchBtn = document.getElementById('deep-research-btn');
    if (!deepResearchBtn) return;
    
    if (isGuest) {
        deepResearchBtn.classList.add('disabled');
        deepResearchBtn.title = '🔒 Login required for Deep Research Mode';
    } else {
        deepResearchBtn.classList.remove('disabled');
        deepResearchBtn.title = 'Access Deep Research Mode';
    }
}

function toggleLoader(show) {
    const preloader = document.getElementById('preloader');
    if (!preloader) return;
    
    if (show) {
        preloader.style.display = 'flex';
        // Force reflow to ensure transition works
        preloader.offsetHeight;
        preloader.classList.remove('loaded'); 
        preloader.style.visibility = 'visible';
        preloader.style.opacity = '1';
        preloader.style.pointerEvents = 'auto';
    } else {
        // Smooth fade out animation with multiple effects
        requestAnimationFrame(() => {
            preloader.classList.add('loaded');
        });
        // Extended timeout for complete smooth animation
        setTimeout(() => {
            preloader.style.display = 'none';
            preloader.style.pointerEvents = 'none';
        }, 1100); // Wait for smooth transition to complete (100ms buffer)
    }
}

// Server offline handler
function setSidebarServerStatus(isOnline) {
    const statusPill = document.getElementById("sidebar-status-pill");
    const statusLabel = document.getElementById("sidebar-status-label");
    if (!statusPill || !statusLabel) return;

    statusPill.classList.toggle("online", isOnline);
    statusPill.classList.toggle("offline", !isOnline);
    statusLabel.textContent = isOnline ? "Online" : "Offline";
}

function handleServerOffline() {
    //('Server offline detected');
    serverOffline = true;
    setSidebarServerStatus(false);
    
    const msgInput = document.getElementById("msg-input");
    const sendBtn = document.getElementById("send-btn");
    const imgInput = document.getElementById("img-input");
    const imgUploadBtn = document.getElementById("img-upload-btn");
    if (msgInput) msgInput.disabled = true;
    if (sendBtn) {
        sendBtn.classList.add("disabled");
        sendBtn.style.pointerEvents = "none";
    }
    if (imgInput) imgInput.disabled = true;
    if (imgUploadBtn) {
        imgUploadBtn.classList.add("disabled");
        imgUploadBtn.style.pointerEvents = "none";
    }

    showServerAlert(
        "Server Offline",
        "The server is currently offline. You can view chat history but cannot send new messages."
    );
}

function enableMessageInput() {
    //('Server online');
    serverOffline = false;
    setSidebarServerStatus(true);
    const msgInput = document.getElementById("msg-input");
    const sendBtn = document.getElementById("send-btn");
    const imgInput = document.getElementById("img-input");
    const imgUploadBtn = document.getElementById("img-upload-btn");
    
    if (msgInput) msgInput.disabled = false;
    if (sendBtn) {
        sendBtn.classList.remove("disabled");
        sendBtn.style.pointerEvents = "auto";
    }
    if (imgInput) imgInput.disabled = false;
    if (imgUploadBtn) {
        imgUploadBtn.classList.remove("disabled");
        imgUploadBtn.style.pointerEvents = "auto";
    }

    autoResizeMessageInput(msgInput);

    hideServerAlert();
}

function shouldAutoFocusMessageInput() {
    return window.innerWidth > 768;
}

function enableGestureScrollForMessageInput(input) {
    if (!input) return;

    // Mouse/trackpad wheel scrolling while native scrollbar stays hidden.
    input.addEventListener("wheel", (e) => {
        if (input.scrollHeight <= input.clientHeight) return;
        e.preventDefault();
        input.scrollTop += e.deltaY;
    }, { passive: false });

    // Touch gesture scrolling on mobile devices.
    let touchStartY = 0;
    let startScrollTop = 0;

    input.addEventListener("touchstart", (e) => {
        if (!e.touches || e.touches.length === 0) return;
        touchStartY = e.touches[0].clientY;
        startScrollTop = input.scrollTop;
    }, { passive: true });

    input.addEventListener("touchmove", (e) => {
        if (input.scrollHeight <= input.clientHeight) return;
        if (!e.touches || e.touches.length === 0) return;

        const currentY = e.touches[0].clientY;
        const deltaY = touchStartY - currentY;
        input.scrollTop = startScrollTop + deltaY;
        e.preventDefault();
    }, { passive: false });
}

function autoResizeMessageInput(input) {
    if (!input) return;

    input.style.height = "auto";
    const isMobile = window.innerWidth <= 768;
    const baseHeight = isMobile ? 44 : 64;
    const maxHeight = isMobile ? 320 : 460;
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";

    const controls = input.closest(".controls");
    if (controls) {
        const isMultiline = nextHeight > baseHeight + 2 || String(input.value || "").includes("\n");
        controls.classList.toggle("is-multiline", isMultiline);
    }
}

function showServerAlert(title, message) {
    const alert = document.getElementById("server-alert");
    if (!alert) return;

    const titleEl = alert.querySelector("[data-server-alert-title]");
    const messageEl = alert.querySelector("[data-server-alert-message]");

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    alert.classList.remove("hidden");
    alert.classList.add("active");
}

function hideServerAlert() {
    const alert = document.getElementById("server-alert");
    if (!alert) return;

    alert.classList.remove("active");
    setTimeout(() => {
        alert.classList.add("hidden");
    }, 200);
}

function forceLogout() {
    sessionStorage.removeItem('currentUser');
    sessionStorage.removeItem('isGuest');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('isGuest');
    currentUser = "guest";
    isGuest = true;
    currentSessionId = null;
    chatSessions = {};
    messageCache = {};
    
    // Sign out of Firebase Auth
    if (auth) {
        firebaseSignOut(auth).catch(err => console.warn("Firebase sign out error:", err));
    }
    
    // Reset Firebase loaded flag
    firebaseLoadedOnce = false;
    
    // Update deep research button state
    updateDeepResearchButtonState();

    // Clear UI
    document.getElementById("chat-list").innerHTML = "";
    document.getElementById("chat-box").innerHTML = "";
    
    // Clear auth fields if they exist
    const authUsername = document.getElementById("auth-username");
    const authPassword = document.getElementById("auth-password");
    if (authUsername) authUsername.value = "";
    if (authPassword) authPassword.value = "";
    
    // Clear error messages
    const authError = document.getElementById("auth-error");
    const signupError = document.getElementById("signup-error");
    if (authError) authError.textContent = "";
    if (signupError) signupError.textContent = "";
    
    // Show auth modal
    const authModal = document.getElementById("auth-modal");
    if (authModal) {
        authModal.classList.remove("hidden");
        authModal.style.display = ''; // Reset inline style
    }
    
    const sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("mobile-open");
}

function showModal(title, message) {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;

    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return;

    let titleEl = document.getElementById("modal-title");
    if (!titleEl) {
        titleEl = document.createElement("h2");
        titleEl.id = "modal-title";
        mBox.prepend(titleEl);
    }

    let msgElement = document.getElementById("modal-message");
    if (!msgElement) {
        msgElement = document.createElement("p");
        msgElement.id = "modal-message";
        mBox.insertBefore(msgElement, titleEl.nextSibling);
    }

    mBox.style.display = "flex";
    mBox.style.flexDirection = "column";
    mBox.style.padding = "30px 25px 15px 25px";
    mBox.style.height = "auto";
    mBox.style.minHeight = "220px";
    mBox.style.justifyContent = "space-between";

    msgElement.innerHTML = message.replace(/\n/g, "<br>");
    msgElement.style.marginBottom = "0px";
    msgElement.style.flex = "1 1 auto";
    msgElement.style.display = "flex";
    msgElement.style.alignItems = "center";
    msgElement.style.justifyContent = "center";

    titleEl.innerText = title;
    
    const okContainer = document.getElementById("modal-ok-btn");
    const confirmGroup = document.getElementById("modal-confirm-group");
    
    // Show only OK button
    if (okContainer) {
        okContainer.classList.remove("hidden");
        okContainer.style.display = "flex";
        okContainer.style.visibility = "visible";
        okContainer.style.marginTop = "auto";
        okContainer.style.marginBottom = "0px";
        okContainer.style.justifyContent = "center";
        okContainer.style.width = "39%";
        okContainer.style.marginLeft = "30%";
        
        // Ensure the button inside is also visible and clickable
        const okBtn = okContainer.querySelector("button");
        if (okBtn) {
            okBtn.style.display = "block";
            okBtn.style.visibility = "visible";
            okBtn.style.pointerEvents = "auto";
        }
    }
    
    // Hide cancel/confirm buttons
    if (confirmGroup) {
        confirmGroup.classList.add("hidden");
        confirmGroup.style.display = "none";
        confirmGroup.style.visibility = "hidden";
    }

    modal.classList.remove("hidden");
    modal.classList.add("active");
}

// Info-only popup (OK button only)
function showInfoPopup(title, message) {
    const modal = document.getElementById("custom-modal");
    if (!modal) return alert(message);

    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return alert(message);

    const originalContent = mBox.innerHTML;

    mBox.innerHTML = `
        <h2 id="modal-title">${title}</h2>
        <p id="modal-message">${message}</p>
        <div class="modal-buttons">
            <button id="modal-only-ok" style="width: 100%;">OK</button>
        </div>
    `;

    modal.classList.remove("hidden");
    modal.classList.add("active");

    const okBtn = document.getElementById("modal-only-ok");
    if (okBtn) {
        okBtn.onclick = () => {
            modal.classList.remove("active");
            setTimeout(() => {
                modal.classList.add("hidden");
                mBox.innerHTML = originalContent;
            }, 300);
        };
    }
}

function showLoginRequiredPopup() {
    showInfoPopup("Login Required", "Please login to use this feature.");
}

function requireLoginOrPopup() {
    if (!isGuest) return true;
    showLoginRequiredPopup();
    return false;
}

function showSettingsAlert(title, message) {
    const settingsAlert = document.getElementById("settings-alert");
    if (!settingsAlert) return window.alert(message);

    const titleEl = settingsAlert.querySelector("[data-settings-alert-title]");
    const messageEl = settingsAlert.querySelector("[data-settings-alert-message]");

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.innerHTML = message.replace(/\n/g, "<br>");

    settingsAlert.classList.remove("hidden");
    settingsAlert.classList.add("active");
}

function showModelSelectError(message) {
    const errorEl = document.getElementById("model-select-error");
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.classList.add("show");
}

function clearModelSelectError() {
    const errorEl = document.getElementById("model-select-error");
    if (!errorEl) return;
    errorEl.textContent = "";
    errorEl.classList.remove("show");
}

function closeModelModal() {
    const modal = document.getElementById("model-modal");
    if (!modal) return;
    animateModalClose(modal);
    clearModelSelectError();
}

function renderModelOptions(models) {
    const modelList = document.getElementById("model-list");
    if (!modelList) return;
    modelList.innerHTML = "";

    if (!Array.isArray(models) || models.length === 0) {
        const empty = document.createElement("p");
        empty.className = "model-list-loading";
        empty.textContent = "No local Ollama models found.";
        modelList.appendChild(empty);
        return;
    }

    models.forEach((model) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "model-option-btn";
        if (model === selectedChatModel) {
            button.classList.add("active");
        }

        const name = document.createElement("span");
        name.className = "model-option-name";
        name.textContent = model;

        const status = document.createElement("span");
        status.className = "model-option-status";
        status.textContent = model === selectedChatModel ? "Selected" : "Use";

        button.appendChild(name);
        button.appendChild(status);
        button.addEventListener("click", async () => {
            await selectChatModel(model);
        });

        modelList.appendChild(button);
    });
}

async function openModelModal() {
    const modal = document.getElementById("model-modal");
    const modelList = document.getElementById("model-list");
    if (!modal || !modelList) return;

    clearModelSelectError();
    modal.classList.remove("hidden");
    modal.classList.add("active");
    modelList.innerHTML = '<p class="model-list-loading">Loading models...</p>';

    if (!API_BASE || !API_BASE.trim()) {
        showModelSelectError("Backend URL is not configured.");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/models`, {
            headers: { "ngrok-skip-browser-warning": "true" },
            signal: AbortSignal.timeout(6000),
        });

        if (!response.ok) {
            throw new Error("Failed to load models from backend.");
        }

        const data = await response.json();
        selectedChatModel = data?.selectedModel || selectedChatModel;
        renderModelOptions(data?.models || []);
    } catch (error) {
        showModelSelectError(error.message || "Unable to load models.");
        modelList.innerHTML = '<p class="model-list-loading">Could not load models.</p>';
    }
}

async function selectChatModel(modelName) {
    clearModelSelectError();
    if (!API_BASE || !API_BASE.trim()) {
        showModelSelectError("Backend URL is not configured.");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/models/select`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "ngrok-skip-browser-warning": "true",
            },
            body: JSON.stringify({ model: modelName }),
            signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) {
            let errorMessage = "Failed to select model.";
            try {
                const payload = await response.json();
                errorMessage = payload?.detail || errorMessage;
            } catch {
                // Keep default message.
            }
            throw new Error(errorMessage);
        }

        const data = await response.json();
        selectedChatModel = data?.selectedModel || modelName;

        const listResponse = await fetch(`${API_BASE}/api/models`, {
            headers: { "ngrok-skip-browser-warning": "true" },
            signal: AbortSignal.timeout(5000),
        });
        if (listResponse.ok) {
            const listData = await listResponse.json();
            selectedChatModel = listData?.selectedModel || selectedChatModel;
            renderModelOptions(listData?.models || []);
        }

        showSettingsAlert("Model Updated", `Chat model set to: ${selectedChatModel}`);
    } catch (error) {
        showModelSelectError(error.message || "Unable to select model.");
    }
}

function hideSettingsAlert() {
    const settingsAlert = document.getElementById("settings-alert");
    if (!settingsAlert) return;
    settingsAlert.classList.remove("active");
    setTimeout(() => {
        settingsAlert.classList.add("hidden");
    }, 250);
}

function setImagePreview(base64) {
    const preview = document.getElementById("preview");
    if (!preview) return;
    preview.src = base64;
    preview.style.display = "block";
}

function clearImagePreview() {
    const preview = document.getElementById("preview");
    if (preview) {
        preview.src = "";
        preview.style.display = "none";
    }
    const imgInput = document.getElementById("img-input");
    if (imgInput) imgInput.value = "";
    pendingImageBase64 = null;
}

function handleImageSelection(e) {
    // Prevent image attachments when in SwiftChat mode
    if (swiftChatMode) {
        showInfoPopup("Images Disabled", "Image attachments are disabled in SwiftChat Mode.");
        if (e && e.target) e.target.value = "";
        return;
    }
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (pendingImageBase64) {
        showInfoPopup("One Image Only", "You can attach only one image at a time. Please send or remove the current image first.");
        e.target.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            const maxSize = 1024;
            let { width, height } = img;
            const scale = Math.min(1, maxSize / Math.max(width, height));
            width = Math.max(1, Math.floor(width * scale));
            height = Math.max(1, Math.floor(height * scale));

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                showInfoPopup("Upload Failed", "Image processing is not available in this browser.");
                clearImagePreview();
                return;
            }
            ctx.drawImage(img, 0, 0, width, height);

            pendingImageBase64 = canvas.toDataURL("image/jpeg", 0.9);
            setImagePreview(pendingImageBase64);
        };
        img.onerror = () => {
            showInfoPopup("Upload Failed", "This image format is not supported. Try JPG or PNG.");
            clearImagePreview();
        };
        img.src = reader.result;
    };
    reader.onerror = () => {
        showInfoPopup("Upload Failed", "Could not read the selected image. Please try another file.");
        clearImagePreview();
    };
    reader.readAsDataURL(file);
}

function showAuthError(element, message) {
    if (!element) return;
    element.textContent = message;
    element.classList.add("show");
    requestAnimationFrame(() => {
        if (typeof refreshAuthPanelsHeight === "function") {
            refreshAuthPanelsHeight();
        }
    });
}

function clearAuthError(element) {
    if (!element) return;
    element.textContent = "";
    element.classList.remove("show");
    requestAnimationFrame(() => {
        if (typeof refreshAuthPanelsHeight === "function") {
            refreshAuthPanelsHeight();
        }
    });
}

// Independent Device Registration Error Popup
function showDeviceRegistrationError(ownerUsername) {
    // Remove any existing device error popup
    const existingPopup = document.getElementById("device-error-popup");
    if (existingPopup) existingPopup.remove();

    // Create popup overlay
    const overlay = document.createElement("div");
    overlay.id = "device-error-popup";
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        backdrop-filter: blur(5px);
        animation: fadeIn 0.3s ease;
    `;

    // Create popup box
    const box = document.createElement("div");
    box.style.cssText = `
        background: linear-gradient(145deg, #1a1d2e, #16171f);
        border: 2px solid #ff2fd0;
        border-radius: 20px;
        padding: 40px 30px;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(255, 47, 208, 0.3);
        animation: modalPop 0.45s ease;
        text-align: center;
    `;

    box.innerHTML = `
        <div style="font-size: 60px; margin-bottom: 20px;">🔒</div>
        <h2 style="color: #ff2fd0; margin: 0 0 20px 0; font-size: 28px; letter-spacing: 1px;">Device Already Registered</h2>
        <p style="color: #e2e8f0; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
            This device is already linked to <b style="color: #00e5ff;">'${ownerUsername}'</b>.<br><br>
            Please log in with that account or use a different device.
        </p>
        <button id="device-error-close-btn" style="
            background: linear-gradient(135deg, #ff2fd0, #7928ca);
            color: white;
            border: none;
            padding: 15px 40px;
            border-radius: 25px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 15px rgba(255, 47, 208, 0.4);
            transition: all 0.3s ease;
            letter-spacing: 1px;
        ">OK, Got It</button>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Add keyframe animations
    if (!document.getElementById('device-popup-styles')) {
        const style = document.createElement('style');
        style.id = 'device-popup-styles';
        style.textContent = `
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes modalPop {
                0% { transform: scale(0.92); opacity: 0; }
                60% { transform: scale(1.03); opacity: 1; }
                100% { transform: scale(1); }
            }
            #device-error-close-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(255, 47, 208, 0.6);
            }
            #device-error-close-btn:active {
                transform: translateY(0);
            }
        `;
        document.head.appendChild(style);
    }

    // Close button handler
    const closeBtn = document.getElementById("device-error-close-btn");
    closeBtn.onclick = () => {
        overlay.style.animation = "fadeOut 0.3s ease";
        setTimeout(() => overlay.remove(), 300);
    };

    // Close on overlay click
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.style.animation = "fadeOut 0.3s ease";
            setTimeout(() => overlay.remove(), 300);
        }
    };

    // Add fadeOut animation
    const fadeOutStyle = document.createElement('style');
    fadeOutStyle.textContent = `
        @keyframes fadeOut {
            from { opacity: 1; }
            to { opacity: 0; }
        }
    `;
    document.head.appendChild(fadeOutStyle);
}

// Copy text to clipboard
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        alert("Recovery Code copied to clipboard!");
    }).catch(err => {
        alert("Failed to copy. Please copy manually: " + text);
    });
}

function showConfirm(title, message, onYesCallback) {
    const modal = document.getElementById("custom-modal");
    if (!modal) {
        if(confirm(message)) onYesCallback();
        return;
    }

    const mBox = modal.querySelector(".modal-box");
    if (mBox) {
        mBox.style.display = "flex !important";
        mBox.style.flexDirection = "column";
        mBox.style.padding = "30px 25px 25px 25px";
        mBox.style.height = "auto";
        mBox.style.minHeight = "350px";
        mBox.style.justifyContent = "space-between";
        mBox.style.position = "relative";
    }

    const titleElement = document.getElementById("modal-title");
    if (titleElement) {
        titleElement.innerText = title;
        titleElement.style.marginBottom = "15px";
    }

    const msgElement = document.getElementById("modal-message");
    if (msgElement) {
        msgElement.innerHTML = message.replace(/\n/g, "<br>");
        msgElement.style.marginBottom = "auto";
        msgElement.style.flex = "1 1 auto";
        msgElement.style.display = "flex";
        msgElement.style.alignItems = "center";
        msgElement.style.justifyContent = "center";
    }

    const okContainer = document.getElementById("modal-ok-btn");
    if (okContainer) {
        okContainer.classList.add("hidden");
        okContainer.style.display = "none !important";
        okContainer.style.visibility = "hidden";
    }
    
    const confirmGroup = document.getElementById("modal-confirm-group");
    if (confirmGroup) {
        confirmGroup.classList.remove("hidden");
        confirmGroup.style.display = "grid !important";
        confirmGroup.style.visibility = "visible";
        confirmGroup.style.marginTop = "0px !important";
        confirmGroup.style.marginBottom = "0px !important";
        confirmGroup.style.width = "100%";
        confirmGroup.style.gap = "15px";
        confirmGroup.style.gridTemplateColumns = "1fr 1fr";
        confirmGroup.style.position = "relative";
        confirmGroup.style.bottom = "0";
        confirmGroup.style.alignSelf = "flex-end";
        confirmGroup.style.flexShrink = "0";
    }

    // Find buttons within confirm group
    const yesBtn = confirmGroup ? confirmGroup.querySelector('[id*="yes"]') || confirmGroup.querySelector('button:nth-child(2)') : null;
    const noBtn = confirmGroup ? confirmGroup.querySelector('[id*="no"]') || confirmGroup.querySelector('button:nth-child(1)') : null;
    
    if (yesBtn) {
        const newYesBtn = yesBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
        newYesBtn.onclick = () => {
            closeModal();
            onYesCallback(); 
        };
    }
    
    if (noBtn) {
        const newNoBtn = noBtn.cloneNode(true);
        noBtn.parentNode.replaceChild(newNoBtn, noBtn);
        newNoBtn.onclick = () => {
            closeModal();
        };
    }

    modal.classList.remove("hidden");
    modal.classList.add("active");
}

function closeModal() {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;
    modal.classList.remove("attention-bounce");
    animateModalClose(modal, () => {
        const confirmGroup = document.getElementById("modal-confirm-group");
        if (confirmGroup) {
            confirmGroup.classList.add("hidden");
            confirmGroup.style.display = "none";
        }
    });
}

// Auth modal functions
function showLoginLoadingModal() {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;
    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return;
    
    if (!modal.dataset.originalContent) {
        modal.dataset.originalContent = mBox.innerHTML;
    }

    mBox.innerHTML = `
        <div style="text-align: center;">
            <div style="display: inline-block; animation: spin 1s linear infinite; font-size: 50px; margin-bottom: 20px;">⟳</div>
            <h2 style="color: var(--neon-blue); margin: 0 0 10px 0; letter-spacing: 1px;">Verifying</h2>
            <p style="color: var(--text-dim);">Authenticating your credentials...</p>
        </div>
    `;
    
    modal.classList.remove("hidden");
    modal.classList.add("active");
}

function hideLoginLoadingModal() {
    const modal = document.getElementById("custom-modal");
    const mBox = modal ? modal.querySelector(".modal-box") : null;
    if (!modal) return;
    animateModalClose(modal, () => {
        if (mBox && modal.dataset.originalContent) {
            mBox.innerHTML = modal.dataset.originalContent;
            delete modal.dataset.originalContent;
        }
    });
}

function convertLoadingToSuccess(username) {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;
    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return;
    
    mBox.innerHTML = `
        <div class="success-checkmark">
            <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                <circle class="check-circle" cx="26" cy="26" r="25" fill="none"/>
                <path class="check-tick" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
            </svg>
        </div>
        <h2 class="success-title">Login Successful</h2>
        <p style="color:white; letter-spacing: 0.5px;">Welcome back, <b>${username}</b>!</p>
    `;
    
    setTimeout(() => {
        modal.classList.remove("active");
        setTimeout(async () => {
            modal.classList.add("hidden");
            if (modal.dataset.originalContent) {
                mBox.innerHTML = modal.dataset.originalContent;
                delete modal.dataset.originalContent;
            }
            await completeLogin(username, false);
        }, 300);
    }, 2500);
}

function showSignUpLoadingModal() {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;
    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return;

    if (!modal.dataset.originalContent) {
        modal.dataset.originalContent = mBox.innerHTML;
    }

    mBox.innerHTML = `
        <div style="text-align: center;">
            <div style="display: inline-block; animation: spin 1s linear infinite; font-size: 50px; margin-bottom: 20px;">⟳</div>
            <h2 style="color: var(--neon-blue); margin: 0 0 10px 0; letter-spacing: 1px;">Verifying</h2>
            <p style="color: var(--text-dim);">Checking username availability...</p>
        </div>
    `;

    modal.classList.remove("hidden");
    modal.classList.add("active");
}

function hideSignUpLoadingModal() {
    const modal = document.getElementById("custom-modal");
    const mBox = modal ? modal.querySelector(".modal-box") : null;
    if (!modal) return;
    modal.classList.remove("active");
    setTimeout(() => {
        modal.classList.add("hidden");
        if (mBox && modal.dataset.originalContent) {
            mBox.innerHTML = modal.dataset.originalContent;
            delete modal.dataset.originalContent;
        }
    }, 300);
}

function convertSignUpLoadingToSuccess(user, pass, recoveryCode) {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;
    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return;

    mBox.innerHTML = `
        <div class="success-checkmark">
            <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                <circle class="check-circle" cx="26" cy="26" r="25" fill="none"/>
                <path class="check-tick" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
            </svg>
        </div>
        <h2 class="success-title">Username Available!</h2>
        <p style="color:white; letter-spacing: 0.5px;">Creating your account...</p>
    `;

    setTimeout(() => {
        showSignUpSuccess(user, pass, recoveryCode);
    }, 1500);
}

function showSignUpSuccess(user, pass, recoveryCode) {
    const modal = document.getElementById("custom-modal");
    if (!modal) return;
    const mBox = modal.querySelector(".modal-box");
    if (!mBox) return;

    if (!modal.dataset.originalContent) {
        modal.dataset.originalContent = mBox.innerHTML;
    }

    mBox.innerHTML = `
        <div class="success-checkmark">
            <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                <circle class="check-circle" cx="26" cy="26" r="25" fill="none"/>
                <path class="check-tick" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
            </svg>
        </div>
        <h2 class="success-title">Account Created</h2>
        
        <div class="credential-box" style="background: rgba(0,229,255,0.1); padding: 15px; border-radius: 8px; margin: 20px 0;">
            <div style="margin-bottom: 10px;">
                <span style="color: #a0aec0;">Username:</span>
                <span style="color: #00e5ff; font-weight: bold; margin-left: 10px;">${user}</span>
            </div>
            <div style="margin-bottom: 10px;">
                <span style="color: #a0aec0;">Password:</span>
                <span style="color: #2cff8f; font-weight: bold; margin-left: 10px;">${pass}</span>
            </div>
            <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1);">
                <span style="color: #a0aec0;">Recovery Code:</span>
                <div style="color: #ff2fd0; font-weight: bold; margin-top: 8px; font-size: 0.9em; word-break: break-all;">${recoveryCode}</div>
                <p style="color: #a0aec0; font-size: 0.8em; margin-top: 8px;">⚠️ Save this code! You'll need it to recover your account.</p>
            </div>
        </div>

        <p style="color: #e2e8f0; text-align: center; margin: 20px 0;">
            Your account has been created successfully!
        </p>

        <button id="signup-continue-btn" class="modal-btn-primary" style="width: 100%;">Continue</button>
    `;

    modal.classList.remove("hidden");
    modal.classList.add("active");

    document.getElementById("signup-continue-btn").onclick = async () => {
        modal.classList.remove("active");
        setTimeout(async () => {
            modal.classList.add("hidden");
            if (modal.dataset.originalContent) {
                mBox.innerHTML = modal.dataset.originalContent;
                delete modal.dataset.originalContent;
            }
            toggleLoader(true);
            await completeLogin(user, false);
            toggleLoader(false);
        }, 300);
    };
}

// ==========================================
// 4. AUTHENTICATION & LOCKOUT
// ==========================================

// Constants
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = 20 * 60 * 1000;

function getDeviceId() {
    let deviceId = localStorage.getItem('device_id');
    if (!deviceId) {
        deviceId = 'dev-' + Date.now().toString(36) + Math.random().toString(36).substr(2);
        localStorage.setItem('device_id', deviceId);
    }
    return deviceId;
}

// Generate unique recovery code based on device + timestamp + random
function generateRecoveryCode() {
    const deviceId = getDeviceId();
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 8);
    const recoveryCode = `ZAI-${timestamp}-${random}-${deviceId.substr(-4)}`.toUpperCase();
    return recoveryCode;
}

function validateInputs(username, password) {
    const usernameRegex = /^[a-zA-Z]/; 
    if (!usernameRegex.test(username)) return "Username must start with a letter.";
    if (username.length < 5) return "Username must be at least 5 characters.";
    
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (!/[A-Z]/.test(password)) return "Password needs at least 1 Uppercase letter.";
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return "Password needs at least 1 Special Character.";
    return null; 
}

function getLockoutStatus(username) {
    const lockoutStart = localStorage.getItem(`lockout_start_${username}`);
    const failedAttempts = parseInt(localStorage.getItem(`failed_attempts_${username}`) || '0');

    if (lockoutStart) {
        const timePassed = Date.now() - parseInt(lockoutStart);
        if (timePassed < LOCKOUT_TIME) {
            const minutesLeft = Math.ceil((LOCKOUT_TIME - timePassed) / 60000);
            return { locked: true, timeLeft: minutesLeft };
        } else {
            localStorage.removeItem(`lockout_start_${username}`);
            localStorage.setItem(`failed_attempts_${username}`, '0');
            return { locked: false, attempts: 0 };
        }
    }
    return { locked: false, attempts: failedAttempts };
}

function registerFailure(username) {
    let attempts = parseInt(localStorage.getItem(`failed_attempts_${username}`) || '0');
    attempts++;
    localStorage.setItem(`failed_attempts_${username}`, attempts);
    if (attempts >= MAX_ATTEMPTS) {
        localStorage.setItem(`lockout_start_${username}`, Date.now());
        return true; 
    }
    return false;
}

// ==========================================
// 4. AUTHENTICATION FUNCTIONS
// ==========================================
// 🔐 AUTH PANEL TOGGLES
let usernameCheckTimeout = null;
let usernameCheckCounter = 0;
let authPanelAnimating = false;
const AUTH_PANEL_TRANSITION_MS = 520;
const AUTH_PANEL_HEIGHT_BUFFER = 14;
let authPanelResizeObserver = null;
let authPanelMutationObserver = null;

async function doesUsernameExist(username) {
    const normalizedUsername = normalizeUsername(username);
    if (!normalizedUsername) return false;

    // Read the publicly-readable created_at field under users to check existence
    if (db) {
        try {
            const snap = await get(child(ref(db), `users/${normalizedUsername}/created_at`));
            return snap.exists();
        } catch (_) { /* Could not verify */ }
    }

    return null;
}

async function checkUsernameAvailability(username, checkId) {
    username = normalizeUsername(username);
    const signupError = document.getElementById("signup-error");
    const signupUsernameInput = document.getElementById("signup-username");
    
    if (!username || username.length < 5) {
        clearAuthError(signupError);
        signupUsernameInput.style.borderColor = "";
        signupUsernameInput.style.borderRadius = "";
        signupUsernameInput.style.boxShadow = "";
        return;
    }
    
    try {
        signupError.innerHTML = '<span style="color: #94a3b8;">⏳ Checking availability...</span>';
        signupError.classList.add("show");
        
        // Check device registration (publicly readable) to detect existing registrations
        const deviceId = getDeviceId();
        if (deviceId !== ADMIN_DEVICE_ID) {
            const deviceSnap = await get(child(ref(db), `devices/${deviceId}`));
            if (checkId !== usernameCheckCounter) return;
            if (deviceSnap.exists() && deviceSnap.val() !== username) {
                signupError.innerHTML = `<span style="color: #ff4b4b;">❌ Device linked to '${deviceSnap.val()}'</span>`;
                signupError.classList.add("show");
                signupUsernameInput.style.borderColor = "#ff4b4b";
                signupUsernameInput.style.borderRadius = "24px";
                signupUsernameInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
                return;
            }
        }

        if (checkId !== usernameCheckCounter) return;

        const usernameExists = await doesUsernameExist(username);
        if (checkId !== usernameCheckCounter) return;

        if (usernameExists === true) {
            signupError.innerHTML = '<span style="color: #ff4b4b;">❌ Username already taken</span>';
            signupError.classList.add("show");
            signupUsernameInput.style.borderColor = "#ff4b4b";
            signupUsernameInput.style.borderRadius = "24px";
            signupUsernameInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
            return;
        }

        if (usernameExists === false) {
            signupError.innerHTML = '<span style="color: #2cff8f;">✅ Username available</span>';
            signupError.classList.add("show");
            signupUsernameInput.style.borderColor = "#2cff8f";
            signupUsernameInput.style.borderRadius = "24px";
            signupUsernameInput.style.boxShadow = "0 0 12px rgba(44, 255, 143, 0.5)";
            return;
        }

        // null = could not verify — stay neutral, signup will catch duplicates
        clearAuthError(signupError);
        signupUsernameInput.style.borderColor = "";
        signupUsernameInput.style.borderRadius = "";
        signupUsernameInput.style.boxShadow = "";
    } catch (error) {
        // Stay neutral on unexpected errors
        clearAuthError(signupError);
        signupUsernameInput.style.borderColor = "";
        signupUsernameInput.style.borderRadius = "";
        signupUsernameInput.style.boxShadow = "";
    }
}

function updateSignupPasswordMatchState() {
    const passInput = document.getElementById("signup-password");
    const confirmInput = document.getElementById("signup-confirm");
    if (!passInput || !confirmInput) return null;

    const pass = passInput.value.trim();
    const confirm = confirmInput.value.trim();

    const clearStyle = (input) => {
        input.style.borderColor = "";
        input.style.borderRadius = "";
        input.style.boxShadow = "";
    };

    if (!pass && !confirm) {
        clearStyle(passInput);
        clearStyle(confirmInput);
        return null;
    }

    if (!pass || !confirm) {
        clearStyle(passInput);
        clearStyle(confirmInput);
        return null;
    }

    if (pass === confirm) {
        passInput.style.borderColor = "#2cff8f";
        passInput.style.borderRadius = "24px";
        passInput.style.boxShadow = "0 0 12px rgba(44, 255, 143, 0.5)";
        confirmInput.style.borderColor = "#2cff8f";
        confirmInput.style.borderRadius = "24px";
        confirmInput.style.boxShadow = "0 0 12px rgba(44, 255, 143, 0.5)";
        return true;
    }

    passInput.style.borderColor = "#ff4b4b";
    passInput.style.borderRadius = "24px";
    passInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
    confirmInput.style.borderColor = "#ff4b4b";
    confirmInput.style.borderRadius = "24px";
    confirmInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
    return false;
}

function syncAuthPanelsHeight(animate = true) {
    const panels = document.querySelector(".auth-panels");
    const activePanel = panels ? panels.querySelector(".auth-panel.active") : null;
    if (!panels || !activePanel) return;

    const targetHeight = activePanel.scrollHeight + AUTH_PANEL_HEIGHT_BUFFER;
    if (!animate) {
        const previousTransition = panels.style.transition;
        panels.style.transition = "none";
        panels.style.height = `${targetHeight}px`;
        panels.offsetHeight;
        panels.style.transition = previousTransition || "height 0.48s cubic-bezier(0.22, 1, 0.36, 1)";
        return;
    }

    panels.style.height = `${targetHeight}px`;
}

function refreshAuthPanelsHeight() {
    requestAnimationFrame(() => syncAuthPanelsHeight(true));
}

function initAuthPanelAutoHeightObservers() {
    const panels = document.querySelectorAll(".auth-panel");
    if (!panels || panels.length === 0) return;

    const onContentChange = () => {
        const authModal = document.getElementById("auth-modal");
        if (!authModal || authModal.classList.contains("hidden")) return;
        refreshAuthPanelsHeight();
    };

    if (typeof ResizeObserver !== "undefined") {
        if (authPanelResizeObserver) {
            authPanelResizeObserver.disconnect();
        }
        authPanelResizeObserver = new ResizeObserver(onContentChange);
        panels.forEach((panel) => authPanelResizeObserver.observe(panel));
        return;
    }

    if (authPanelMutationObserver) {
        authPanelMutationObserver.disconnect();
    }
    authPanelMutationObserver = new MutationObserver(onContentChange);
    panels.forEach((panel) => {
        authPanelMutationObserver.observe(panel, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });
    });
}

function lockAuthPanelTransition() {
    authPanelAnimating = true;
    setTimeout(() => {
        authPanelAnimating = false;
        syncAuthPanelsHeight(false);
    }, AUTH_PANEL_TRANSITION_MS);
}

function openSignupPanel() {
    if (authPanelAnimating) return;
    const authBox = document.getElementById("auth-box");
    const loginPanel = document.getElementById("auth-login-panel");
    const signupPanel = document.getElementById("auth-signup-panel");
    const authError = document.getElementById("auth-error");
    const signupError = document.getElementById("signup-error");
    const signupUsernameInput = document.getElementById("signup-username");
    const signupPasswordInput = document.getElementById("signup-password");
    const signupConfirmInput = document.getElementById("signup-confirm");
    
    clearAuthError(authError);
    clearAuthError(signupError);
    if (signupUsernameInput) signupUsernameInput.style.borderColor = "";
    if (signupPasswordInput) signupPasswordInput.style.borderColor = "";
    if (signupConfirmInput) signupConfirmInput.style.borderColor = "";
    
    if (authBox) authBox.classList.add("signup-mode");
    if (loginPanel) loginPanel.classList.remove("active");
    if (signupPanel) signupPanel.classList.add("active");
    refreshAuthPanelsHeight();
    lockAuthPanelTransition();
    
    // Setup real-time username check
    if (signupUsernameInput) {
        const freshInput = signupUsernameInput.cloneNode(true);
        signupUsernameInput.parentNode.replaceChild(freshInput, signupUsernameInput);

        freshInput.addEventListener("input", (e) => {
            const username = e.target.value.trim();
            const startsWithLetter = /^[a-zA-Z]/.test(username);

            if (usernameCheckTimeout) {
                clearTimeout(usernameCheckTimeout);
            }

            usernameCheckCounter += 1;
            const currentCheckId = usernameCheckCounter;

            if (!username) {
                clearAuthError(signupError);
                freshInput.style.borderColor = "";
                freshInput.style.borderRadius = "";
                freshInput.style.boxShadow = "";
                return;
            }

            if (!startsWithLetter) {
                showAuthError(signupError, "Username must start with a letter.");
                freshInput.style.borderColor = "#ff4b4b";
                freshInput.style.borderRadius = "24px";
                freshInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
                return;
            }

            if (username.length < 5) {
                showAuthError(signupError, "Username must be at least 5 characters.");
                freshInput.style.borderColor = "";
                freshInput.style.borderRadius = "";
                freshInput.style.boxShadow = "";
                return;
            }

            if (signupError) {
                signupError.innerHTML = '<span style="color: #94a3b8;">⏳ Checking availability...</span>';
                signupError.classList.add("show");
            }

            usernameCheckTimeout = setTimeout(() => {
                checkUsernameAvailability(username, currentCheckId);
            }, 300);
        });
    }

    if (signupPasswordInput) {
        const freshPassword = signupPasswordInput.cloneNode(true);
        signupPasswordInput.parentNode.replaceChild(freshPassword, signupPasswordInput);
        freshPassword.addEventListener("input", () => {
            const matchState = updateSignupPasswordMatchState();
            if (matchState === true && signupError) {
                clearAuthError(signupError);
            } else if (matchState === false && signupError) {
                showAuthError(signupError, "Passwords do not match.");
            }
        });
    }

    if (signupConfirmInput) {
        const freshConfirm = signupConfirmInput.cloneNode(true);
        signupConfirmInput.parentNode.replaceChild(freshConfirm, signupConfirmInput);
        freshConfirm.addEventListener("input", () => {
            const matchState = updateSignupPasswordMatchState();
            if (matchState === true && signupError) {
                clearAuthError(signupError);
            } else if (matchState === false && signupError) {
                showAuthError(signupError, "Passwords do not match.");
            }
        });
    }
}

function closeSignupPanel() {
    if (authPanelAnimating) return;
    const authBox = document.getElementById("auth-box");
    const loginPanel = document.getElementById("auth-login-panel");
    const signupPanel = document.getElementById("auth-signup-panel");
    const authError = document.getElementById("auth-error");
    const signupError = document.getElementById("signup-error");
    const signupUsernameInput = document.getElementById("signup-username");
    const signupPasswordInput = document.getElementById("signup-password");
    const signupConfirmInput = document.getElementById("signup-confirm");
    
    // Clear timeout
    if (usernameCheckTimeout) {
        clearTimeout(usernameCheckTimeout);
        usernameCheckTimeout = null;
    }
    
    clearAuthError(authError);
    clearAuthError(signupError);
    if (signupUsernameInput) {
        signupUsernameInput.value = "";
        signupUsernameInput.style.borderColor = "";
    }
    if (signupPasswordInput) {
        signupPasswordInput.value = "";
        signupPasswordInput.style.borderColor = "";
        signupPasswordInput.style.borderRadius = "";
        signupPasswordInput.style.boxShadow = "";
    }
    if (signupConfirmInput) {
        signupConfirmInput.value = "";
        signupConfirmInput.style.borderColor = "";
        signupConfirmInput.style.borderRadius = "";
        signupConfirmInput.style.boxShadow = "";
    }
    
    if (authBox) authBox.classList.remove("signup-mode");
    if (signupPanel) signupPanel.classList.remove("active");
    if (loginPanel) loginPanel.classList.add("active");
    refreshAuthPanelsHeight();
    lockAuthPanelTransition();
}

async function handleLogin() {
    const user = normalizeUsername(document.getElementById("auth-username").value);
    const pass = document.getElementById("auth-password").value.trim();
    const errorMsg = document.getElementById("auth-error");
    const deviceId = getDeviceId();

    // Check if Firebase is initialized
    if (!db) {
        showAuthError(errorMsg, "❌ Database not ready. Please refresh the page.");
        console.error("Firebase not initialized - db is null");
        return;
    }

    const status = getLockoutStatus(user);
    if (status.locked) {
        showAuthError(errorMsg, `Locked (${status.timeLeft}m left)`);
        showLockoutWithReset(user, status.timeLeft);
        return;
    }

    if (!user || !pass) { showAuthError(errorMsg, "Please fill in all fields."); return; }
    
    // Show loading modal with spinner
    showLoginLoadingModal();

    try {
        await refreshMasterPasswordFromDb();

        //(`🔐 Attempting login for user: ${user}`);
        //(`📱 Device ID: ${deviceId}`);
        const decision = await resolveLoginDecision(user, pass);
        if (!decision.allowLoginAttempt) {
            const err = new Error("Invalid username or password");
            err.code = "auth/invalid-credential";
            throw err;
        }

        const loginPasswords = decision.loginPasswords.length > 0
            ? decision.loginPasswords
            : await resolveFirebaseLoginPasswords(user, pass);
        const loginPassword = await tryFirebaseSignInWithCandidates(user, loginPasswords);

        // Backfill user record if missing (e.g. account created before DB records existed)
        try {
            const userRef = ref(db, `users/${user}`);
            const userSnap = await get(userRef);
            if (!userSnap.exists()) {
                const recoveryCode = generateRecoveryCode();
                await set(userRef, {
                    password: encryptPassword(loginPassword),
                    device_id: deviceId,
                    recovery_code: recoveryCode,
                    created_at: Date.now()
                });
                await set(ref(db, `recovery_codes/${recoveryCode}`), {
                    username: user,
                    device_id: deviceId
                });
                await set(ref(db, `usernames/${user}`), true).catch(e => console.warn("⚠️ Usernames index write failed:", e));
                console.log("✅ Backfilled user record for:", user);
            }
        } catch (dbErr) {
            console.error("⚠️ Failed to backfill user record:", dbErr);
        }

        if (deviceId !== ADMIN_DEVICE_ID) {
            const deviceSnap = await get(child(ref(db), `devices/${deviceId}`));
            if (deviceSnap.exists() && deviceSnap.val() !== user) {
                await firebaseSignOut(auth);
                hideLoginLoadingModal();
                showAuthError(errorMsg, "Access Denied.");
                showModal("Access Denied", `Device linked to: '${deviceSnap.val()}'`);
                return;
            }
            if (!deviceSnap.exists()) {
                await set(ref(db, `devices/${deviceId}`), user).catch(e => console.error("⚠️ Device write failed:", e));
            }
        }
        
        // 3. Clear failed attempts and show success
        localStorage.removeItem(`failed_attempts_${user}`);
        localStorage.removeItem(`lockout_start_${user}`);
        
        convertLoadingToSuccess(user);
    } catch (e) {
        let code = String(e?.code || "").toLowerCase();
        let isInvalidCredential = code === "auth/invalid-credential" || code === "auth/wrong-password";
        let isUserMissing = code === "auth/user-not-found";
        let isTooManyRequests = code === "auth/too-many-requests";
        let isNetworkError = code === "auth/network-request-failed";
        let isEmailAlreadyInUse = code === "auth/email-already-in-use";

        // Legacy migration fallback: if auth account isn't available with this password,
        // try creating one once so older DB-only users can move to Firebase Auth.
        if (isUserMissing) {
            try {
                const loginPasswords = await resolveFirebaseLoginPasswords(user, pass);
                const loginPassword = loginPasswords[0] || pass;
                await createUserWithEmailAndPassword(auth, usernameToEmail(user), loginPassword);

                const userRef = ref(db, `users/${user}`);
                const existingUserSnap = await get(userRef);
                if (!existingUserSnap.exists()) {
                    const recoveryCode = generateRecoveryCode();
                    await set(userRef, {
                        password: encryptPassword(loginPassword),
                        device_id: deviceId,
                        recovery_code: recoveryCode,
                        created_at: Date.now()
                    });

                    await set(ref(db, `recovery_codes/${recoveryCode}`), {
                        username: user,
                        device_id: deviceId
                    });
                    await set(ref(db, `usernames/${user}`), true).catch(e => console.warn("⚠️ Usernames index write failed:", e));
                }

                if (deviceId !== ADMIN_DEVICE_ID) {
                    const deviceRef = ref(db, `devices/${deviceId}`);
                    const deviceSnap = await get(deviceRef);
                    if (deviceSnap.exists() && deviceSnap.val() !== user) {
                        await firebaseSignOut(auth);
                        hideLoginLoadingModal();
                        showAuthError(errorMsg, "Access Denied.");
                        showModal("Access Denied", `Device linked to: '${deviceSnap.val()}'`);
                        return;
                    }
                    if (!deviceSnap.exists()) {
                        await set(deviceRef, user);
                    }
                }

                localStorage.removeItem(`failed_attempts_${user}`);
                localStorage.removeItem(`lockout_start_${user}`);
                convertLoadingToSuccess(user);
                return;
            } catch (createErr) {
                e = createErr;
            }
        }

        hideLoginLoadingModal();

        code = String(e?.code || "").toLowerCase();
        isInvalidCredential = code === "auth/invalid-credential" || code === "auth/wrong-password";
        isUserMissing = code === "auth/user-not-found";
        isTooManyRequests = code === "auth/too-many-requests";
        isNetworkError = code === "auth/network-request-failed";
        isEmailAlreadyInUse = code === "auth/email-already-in-use";

        if (isInvalidCredential || isUserMissing) {
            const usernameExists = await doesUsernameExist(user);
            const isKnownUsernameWrongPassword = usernameExists === true && isInvalidCredential;

            if (isKnownUsernameWrongPassword) {
                const isLockedNow = registerFailure(user);
                if (isLockedNow) {
                    const lockedStatus = getLockoutStatus(user);
                    showAuthError(errorMsg, `Locked (${lockedStatus.timeLeft}m left)`);
                    showLockoutWithReset(user, lockedStatus.timeLeft);
                } else {
                    const statusNow = getLockoutStatus(user);
                    const attemptsLeft = Math.max(0, MAX_ATTEMPTS - (statusNow.attempts || 0));
                    showAuthError(errorMsg, `Invalid username or password. Attempts left: ${attemptsLeft}`);
                }
            } else {
                showAuthError(errorMsg, "Account not found. Use Sign Up first.");
            }
        } else if (isEmailAlreadyInUse) {
            showAuthError(errorMsg, "Wrong username or password.");
        } else if (isTooManyRequests) {
            showAuthError(errorMsg, "Too many requests. Please wait and try again.");
        } else if (isNetworkError) {
            showAuthError(errorMsg, "Network error. Check internet and try again.");
        } else {
            showAuthError(errorMsg, "Login failed. Please try again.");
        }

        console.error("❌ Login error:", e);
        console.error("   Error message:", e.message);
        console.error("   Error code:", e.code);
    }
}

async function handleSignUp() {
    //("🔵 handleSignUp() called");
    const user = normalizeUsername(document.getElementById("signup-username").value);
    const pass = document.getElementById("signup-password").value.trim();
    const confirmPass = document.getElementById("signup-confirm").value.trim();
    const errorMsg = document.getElementById("signup-error");
    const signupUsernameInput = document.getElementById("signup-username");
    const deviceId = getDeviceId();

    //(`📝 Signup attempt - User: ${user}, Password length: ${pass.length}, Confirm match: ${pass === confirmPass}`);

    if (!db || !auth) {
        showAuthError(errorMsg, "❌ Firebase not ready. Please refresh the page.");
        return;
    }

    if (pass !== confirmPass) {
        updateSignupPasswordMatchState();
        showAuthError(errorMsg, "Passwords do not match.");
        return;
    }

    const validationError = validateInputs(user, pass);
    if (validationError) {
        showAuthError(errorMsg, validationError);
        return;
    }

    try {
        if (deviceId !== ADMIN_DEVICE_ID) {
            const deviceSnap = await get(child(ref(db), `devices/${deviceId}`));
            if (deviceSnap.exists() && deviceSnap.val() !== user) {
                const owner = deviceSnap.val();
                showAuthError(errorMsg, `Device linked to: '${owner}'`);
                if (signupUsernameInput) {
                    signupUsernameInput.style.borderColor = "#ff4b4b";
                    signupUsernameInput.style.borderRadius = "24px";
                    signupUsernameInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
                }
                showDeviceRegistrationError(owner);
                return;
            }
        }

        const usernameExists = await doesUsernameExist(user);
        if (usernameExists === true) {
            showAuthError(errorMsg, "Username already exists. Please login.");
            if (signupUsernameInput) {
                signupUsernameInput.style.borderColor = "#ff4b4b";
                signupUsernameInput.style.borderRadius = "24px";
                signupUsernameInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
            }
            return;
        }
        // If null (couldn't verify), proceed — createUserWithEmailAndPassword will catch duplicates
    } catch (precheckError) {
        // Proceed anyway — signup itself will reject duplicates
        console.warn("Signup precheck could not complete, proceeding:", precheckError);
    }

    // Show verifying modal
    showSignUpLoadingModal();

    try {
        const recoveryCode = generateRecoveryCode();

        await createUserWithEmailAndPassword(auth, usernameToEmail(user), pass);

        await set(ref(db, `users/${user}`), {
            password: encryptPassword(pass),
            device_id: deviceId,
            recovery_code: recoveryCode,
            created_at: Date.now()
        }).catch(e => console.error("⚠️ User write failed:", e));

        await set(ref(db, `usernames/${user}`), true).catch(e => console.warn("⚠️ Usernames index write failed:", e));

        if (deviceId !== ADMIN_DEVICE_ID) {
            await set(ref(db, `devices/${deviceId}`), user).catch(e => console.error("⚠️ Device write failed:", e));
        }

        await set(ref(db, `recovery_codes/${recoveryCode}`), {
            username: user,
            device_id: deviceId
        }).catch(e => console.error("⚠️ Recovery code write failed:", e));
        
        console.log("✅ Signup DB records created for:", user);

        convertSignUpLoadingToSuccess(user, pass, recoveryCode);

    } catch (e) {
        const code = String(e?.code || "").toLowerCase();

        if (code === "auth/email-already-in-use") {
            // Account exists in Firebase Auth — try signing in with the provided password
            try {
                await signInWithEmailAndPassword(auth, usernameToEmail(user), pass);

                // Sign-in succeeded — backfill missing DB records
                const userRef = ref(db, `users/${user}`);
                const existingUserSnap = await get(userRef);
                let recoveryCode = null;

                if (!existingUserSnap.exists()) {
                    recoveryCode = generateRecoveryCode();
                    await set(userRef, {
                        password: encryptPassword(pass),
                        device_id: deviceId,
                        recovery_code: recoveryCode,
                        created_at: Date.now()
                    }).catch(err => console.error("⚠️ User write failed:", err));
                    await set(ref(db, `usernames/${user}`), true).catch(e => console.warn("⚠️ Usernames index write failed:", e));
                }

                if (deviceId !== ADMIN_DEVICE_ID) {
                    const deviceRef = ref(db, `devices/${deviceId}`);
                    const deviceSnap2 = await get(deviceRef);
                    if (deviceSnap2.exists() && deviceSnap2.val() !== user) {
                        await firebaseSignOut(auth);
                        hideSignUpLoadingModal();
                        showAuthError(errorMsg, "Access Denied. Device linked to another account.");
                        return;
                    }
                    if (!deviceSnap2.exists()) {
                        await set(deviceRef, user).catch(err => console.error("⚠️ Device write failed:", err));
                    }
                }

                if (recoveryCode) {
                    await set(ref(db, `recovery_codes/${recoveryCode}`), {
                        username: user,
                        device_id: deviceId
                    }).catch(err => console.error("⚠️ Recovery write failed:", err));
                }

                console.log("✅ Existing account signed in + DB backfilled for:", user);
                localStorage.removeItem(`failed_attempts_${user}`);
                localStorage.removeItem(`lockout_start_${user}`);
                convertSignUpLoadingToSuccess(user, pass, recoveryCode || "Already generated");
                return;
            } catch (signInErr) {
                // Sign-in failed — wrong password for the existing account
                hideSignUpLoadingModal();
                console.warn("⚠️ Account exists but sign-in failed:", signInErr.code);
                showAuthError(errorMsg, "Account already exists with a different password. Use Login.");
                if (signupUsernameInput) {
                    signupUsernameInput.style.borderColor = "#ff4b4b";
                    signupUsernameInput.style.borderRadius = "24px";
                    signupUsernameInput.style.boxShadow = "0 0 12px rgba(255, 75, 75, 0.5)";
                }
                const loginUsernameInput = document.getElementById("auth-username");
                if (loginUsernameInput) loginUsernameInput.value = user;
                showInfoPopup(
                    "Account Exists",
                    "This username already has an account with a different password.<br><br>Go to <b>Login</b> and enter the correct password, or use <b>Reset Password</b>."
                );
                return;
            }
        }

        hideSignUpLoadingModal();

        if (code === "auth/weak-password") {
            showAuthError(errorMsg, "Password is too weak. Use a stronger password.");
        } else if (code === "auth/network-request-failed") {
            showAuthError(errorMsg, "Network error. Check your connection and try again.");
        } else if (code === "auth/too-many-requests") {
            showAuthError(errorMsg, "Too many requests. Please wait a moment and retry.");
        } else {
            showAuthError(errorMsg, "Signup failed. Please try again.");
        }

        console.error("❌ Signup error:", e);
        console.error("   Error message:", e.message);
        console.error("   Error code:", e.code);
    }
}

async function handleGoogleLogin() {
    const errorMsg = document.getElementById("signup-error");

    if (!db || !auth) {
        showAuthError(errorMsg, "❌ Firebase not ready. Please refresh the page.");
        return;
    }

    clearAuthError(errorMsg);

    const currentHost = typeof window !== "undefined" && window.location ? window.location.hostname : "";
    const currentProtocol = typeof window !== "undefined" && window.location ? window.location.protocol : "";
    if (currentProtocol === "file:") {
        showAuthError(errorMsg, "Open the app from http://localhost or a deployed domain before using Google sign-in.");
        return;
    }

    if (currentHost === "127.0.0.1") {
        showAuthError(errorMsg, "Google sign-in requires 127.0.0.1 to be added in Firebase Authentication > Settings > Authorized domains. If you prefer, run the app on localhost instead.");
        return;
    }

    showLoginLoadingModal();

    try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });

        const result = await signInWithPopup(auth, provider);
        const username = await ensureGoogleUserRecord(result.user);

        convertLoadingToSuccess(username);
    } catch (e) {
        hideLoginLoadingModal();

        let message = "Google sign-in failed. Please try again.";
        const code = String(e?.code || "").toLowerCase();
        if (code === "auth/popup-closed-by-user") {
            message = "Google sign-in was cancelled.";
        } else if (code === "auth/popup-blocked") {
            message = "Popup blocked by the browser. Allow popups and try again.";
        } else if (code === "auth/unauthorized-domain") {
            message = currentProtocol === "file:"
                ? "Google sign-in cannot run from a file:// URL. Open the app from http://localhost or a deployed domain, then add that domain to Firebase Authorized domains."
                : `Google sign-in is not enabled for ${currentHost}. Add this domain to Firebase Authentication > Settings > Authorized domains, then try again.`;
        } else if (code === "auth/operation-not-allowed") {
            message = "Google sign-in is disabled in Firebase. Enable the Google provider in Firebase Authentication > Sign-in method.";
        } else if (String(e?.message || "").includes("Device linked to:")) {
            message = e.message;
            try {
                await firebaseSignOut(auth);
            } catch (_) {
                // Ignore sign-out cleanup errors.
            }
        } else if (e?.message && !String(e.message).startsWith("Firebase: Error (") && !String(e.message).includes("unauthorized-domain")) {
            message = e.message;
        }

        showAuthError(errorMsg, message);
        console.error("Google login error:", e);
    }
}

// 🌀 ANIMATED GUEST LOGIN
// 🔐 PASSWORD RESET FLOW
function showLockoutWithReset(username, minutesLeft) {
    const modal = document.getElementById("custom-modal");
    const mBox = modal.querySelector(".modal-box");
    const originalContent = mBox.innerHTML;

    mBox.innerHTML = `
        <div class="error-icon" style="text-align: center; margin-bottom: 20px;">
            <svg style="width: 60px; height: 60px; stroke: #ff2fd0;" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                <circle cx="26" cy="26" r="25" fill="none" stroke="currentColor" stroke-width="2"/>
                <path fill="none" stroke="currentColor" stroke-width="2" d="M26 10 v 20 M26 36 v 2"/>
            </svg>
        </div>
        <h2 style="color: #ff2fd0; text-align: center; margin-bottom: 10px;">🚨 Reset Password Required</h2>
        <p style="text-align: center; color: #e2e8f0; margin-bottom: 20px;">
            Too many failed login attempts detected.<br>
            <b>Use your Recovery Code to reset your password.</b>
        </p>
        
        <div style="display: flex; gap: 10px;">
            <button id="cancel-btn" class="modal-btn-secondary" style="flex: 1;">Back</button>
            <button id="reset-btn" class="modal-btn-primary" style="flex: 1; background: #ff2fd0; box-shadow: 0 0 15px rgba(255, 47, 208, 0.4);">Reset Password</button>
        </div>
    `;

    modal.classList.remove("hidden");
    modal.classList.add("active");

    document.getElementById("cancel-btn").onclick = () => {
        modal.classList.remove("active");
        setTimeout(() => {
            modal.classList.add("hidden");
            mBox.innerHTML = originalContent;
        }, 300);
    };

    document.getElementById("reset-btn").onclick = () => {
        modal.classList.remove("active");
        setTimeout(() => {
            showPasswordResetForm(username);
        }, 300);
    };
}

function showPasswordResetForm(username) {
    const modal = document.getElementById("custom-modal");
    const mBox = modal.querySelector(".modal-box");
    const originalContent = mBox.innerHTML;

    mBox.innerHTML = `
        <h2 style="color: #00e5ff; text-align: center; margin-bottom: 20px;">Reset Password</h2>
        
        <div class="input-group" style="margin-bottom: 15px;">
            <label style="color: #a0aec0; font-size: 12px; margin-bottom: 5px; display: block;">Username</label>
            <input type="text" id="reset-username" value="${username}" disabled style="background: #1a202c; color: #a0aec0; border: 1px solid #4a5568; padding: 10px; border-radius: 4px; width: 100%; box-sizing: border-box;">
        </div>

        <div class="input-group" style="margin-bottom: 15px;">
            <label style="color: #a0aec0; font-size: 12px; margin-bottom: 5px; display: block;">Recovery Code</label>
            <input type="text" id="reset-recovery-code" placeholder="Enter your Recovery Code (e.g., ZAI-XXXX-XXXX-XXXX)" style="background: #1a202c; color: #e2e8f0; border: 1px solid #4a5568; padding: 10px; border-radius: 4px; width: 100%; box-sizing: border-box; font-family: monospace;">
        </div>

        <div class="input-group" style="margin-bottom: 15px;">
            <label style="color: #a0aec0; font-size: 12px; margin-bottom: 5px; display: block;">New Password</label>
            <input type="password" id="reset-new-password" placeholder="Enter new password" style="background: #1a202c; color: #e2e8f0; border: 1px solid #4a5568; padding: 10px; border-radius: 4px; width: 100%; box-sizing: border-box;">
        </div>

        <p id="reset-error" style="color: #ff4b4b; font-size: 12px; text-align: center; margin-bottom: 15px;"></p>

        <div style="display: flex; gap: 10px;">
            <button id="reset-cancel-btn" class="modal-btn-secondary" style="flex: 1;">Cancel</button>
            <button id="reset-submit-btn" class="modal-btn-primary" style="flex: 1;">Reset Password</button>
        </div>
    `;

    modal.classList.remove("hidden");
    modal.classList.add("active");

    document.getElementById("reset-cancel-btn").onclick = () => {
        modal.classList.remove("active");
        setTimeout(() => {
            modal.classList.add("hidden");
            mBox.innerHTML = originalContent;
        }, 300);
    };

    document.getElementById("reset-submit-btn").onclick = () => {
        handlePasswordReset(username, originalContent, mBox);
    };
}

async function handlePasswordReset(username, originalContent, mBox) {
    username = normalizeUsername(username);
    const recoveryCode = document.getElementById("reset-recovery-code").value.trim();
    const newPassword = document.getElementById("reset-new-password").value.trim();
    const errorMsg = document.getElementById("reset-error");

    if (!recoveryCode || !newPassword) {
        errorMsg.textContent = "Please fill in all fields.";
        return;
    }

    const validationError = validateInputs(username, newPassword);
    if (validationError) {
        errorMsg.textContent = validationError;
        return;
    }

    try {
        errorMsg.textContent = "Verifying recovery code...";

        // Check if recovery code exists
        const recoverySnap = await get(child(ref(db), `recovery_codes/${recoveryCode}`));
        if (!recoverySnap.exists()) {
            errorMsg.textContent = "Invalid recovery code.";
            return;
        }

        const recoveryData = recoverySnap.val();
        if (recoveryData.username !== username) {
            errorMsg.textContent = "Recovery code does not match this username.";
            return;
        }

        // Update user password in DB
        await update(ref(db, `users/${username}`), {
            password: encryptPassword(newPassword),
            password_reset_at: Date.now()
        });

        // Keep Firebase Auth password aligned with DB password.
        try {
            await signInWithEmailAndPassword(auth, usernameToEmail(username), newPassword);
        } catch (authError) {
            // If the auth account is missing (older users), create it now.
            if (authError.code === "auth/user-not-found" || authError.code === "auth/invalid-credential") {
                await createUserWithEmailAndPassword(auth, usernameToEmail(username), newPassword);
            }
        }

        // Clear lockout
        localStorage.removeItem(`failed_attempts_${username}`);
        localStorage.removeItem(`lockout_start_${username}`);

        // Show success message
        const modal = document.getElementById("custom-modal");
        mBox.innerHTML = `
            <div class="success-checkmark">
                <svg class="check-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                    <circle class="check-circle" cx="26" cy="26" r="25" fill="none"/>
                    <path class="check-tick" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                </svg>
            </div>
            <h2 style="color: #00e5ff; text-align: center;">Password Reset Successful!</h2>
            <p style="color: #e2e8f0; text-align: center; margin-top: 20px;">
                Your password has been updated successfully.<br><br>
                You can now login with your new password.
            </p>
        `;

        setTimeout(() => {
            modal.classList.remove("active");
            setTimeout(() => {
                modal.classList.add("hidden");
                mBox.innerHTML = originalContent;
                // Clear fields
                document.getElementById("auth-username").value = username;
                document.getElementById("auth-password").value = newPassword;
            }, 300);
        }, 2000);

    } catch (e) {
        errorMsg.textContent = "Error resetting password: " + e.message;
        console.error(e);
    }
}

function handleGuestLogin() {
    toggleLoader(true);
    setTimeout(() => {
        completeLogin("Guest", true);
        toggleLoader(false);
    }, 1500);
}

async function completeLogin(username, guestMode) {
    currentUser = username;
    isGuest = guestMode;
    sessionStorage.setItem('currentUser', username);
    sessionStorage.setItem('isGuest', guestMode);
    if (!guestMode) {
        localStorage.setItem('currentUser', username);
        localStorage.setItem('isGuest', "false");
        // Auth already completed in handleLogin
    }
    document.getElementById("auth-modal").classList.add("hidden");
    await initializeAppState();
    updateSettingsAvailability();
    updateDeepResearchButtonState();
}

async function restoreLoginSession() {
    await waitForInitialAuthState();
    const authUsername = await getAuthenticatedUsername();
    if (authUsername) {
        currentUser = authUsername;
        isGuest = false;
        sessionStorage.setItem('currentUser', authUsername);
        sessionStorage.setItem('isGuest', "false");
        localStorage.setItem('currentUser', authUsername);
        localStorage.setItem('isGuest', "false");
        
        document.getElementById("auth-modal").classList.add("hidden");
        await initializeAppState();
        updateSettingsAvailability();
        updateDeepResearchButtonState();
        return true;
    }
    return false;
}

// ==========================================
// 5. MAIN APP LOGIC (WITH SERVER CHECK)
// ==========================================

async function initializeAppState() {
    chatSessions = {};
    messageCache = {};
    document.getElementById("chat-list").innerHTML = "";
    document.getElementById("chat-box").innerHTML = "";

    // Only check server if API_BASE is configured (backend available)
    let serverAvailable = !serverOffline; // Use the global serverOffline flag set during init

    if (API_BASE && API_BASE.trim()) {
        try {
            const serverCheck = await fetch(`${API_BASE}/api/health`, {
                headers: { "ngrok-skip-browser-warning": "true" },
                signal: AbortSignal.timeout(2000)
            });
            if (!serverCheck.ok) serverAvailable = false;
        } catch (e) {
            console.error("Backend Offline:", e);
            serverAvailable = false;
        }
    } else {
        // No backend configured, don't force offline mode
        serverAvailable = true;
    }

    if (isGuest) {
        currentSessionId = generateSessionId();
        messageCache[currentSessionId] = []; 
        renderChatList();
    } else {
        await loadSessionsFromFirebase();
    }
    
    // Show offline popup if server is unavailable, or enable input if available
    if (!serverAvailable) {
        handleServerOffline();
    } else {
        enableMessageInput();
    }
}

function toggleSidebar(e) {
    if (e && e.stopPropagation) {
        e.stopPropagation();
        e.preventDefault();
    }

    const sidebar = document.getElementById("sidebar");
    const openBtn = document.getElementById("open-sidebar-btn");
    
    if (window.innerWidth <= 768) {
        sidebar.classList.toggle("mobile-open");
    } else {
        // Use a dedicated desktop class so we don't trigger the global `.hidden` rule
        sidebar.classList.toggle("desktop-closed");
        if (sidebar.classList.contains("desktop-closed")) {
            openBtn.style.display = "block";
        } else {
            openBtn.style.display = "none";
        }
    }
}

function setupSidebarSwipeClose() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar || sidebar.dataset.swipeCloseBound === "true") return;

    let touchStartX = 0;
    let touchStartY = 0;

    sidebar.addEventListener("touchstart", (e) => {
        if (window.innerWidth > 768 || !sidebar.classList.contains("mobile-open")) return;
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
    }, { passive: true });

    sidebar.addEventListener("touchend", (e) => {
        if (window.innerWidth > 768 || !sidebar.classList.contains("mobile-open")) return;
        const touch = e.changedTouches && e.changedTouches[0];
        if (!touch) return;

        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        const isSwipeLeft = deltaX < -45;
        const isMostlyHorizontal = Math.abs(deltaX) > Math.abs(deltaY);

        if (isSwipeLeft && isMostlyHorizontal) {
            sidebar.classList.remove("mobile-open");
        }
    }, { passive: true });

    sidebar.dataset.swipeCloseBound = "true";
}

async function createNewChat(shouldSave = true) {
    if (isSending) return;
    if (currentSessionId && !hasMeaningfulConversation(currentSessionId)) {
        renderMessagesFromCache(currentSessionId);
        if (window.innerWidth <= 768) document.getElementById("sidebar")?.classList.remove("mobile-open");
        return;
    }
    if (isGuest && Object.keys(chatSessions).length >= 1) {
        showInfoPopup("Guest Limit", "Guest mode supports only one chat. Please login to create more chats.");
        return;
    }
    if (!isGuest && Object.keys(chatSessions).length >= 10) {
        showInfoPopup("Chat Limit", "You can create up to 10 chats. Please delete a chat to create a new one.");
        return;
    }

    currentSessionId = generateSessionId();
    messageCache[currentSessionId] = [];
    renderMessagesFromCache(currentSessionId);

    // New chat stays as a draft until first user message is sent.
    // Keep chat list/meta untouched here.
    if (window.innerWidth <= 768) document.getElementById("sidebar")?.classList.remove("mobile-open");
}

function updateBrandHeader(mode = 'normal') {
    const brandHeader = document.querySelector('.brand-header');
    if (!brandHeader) return;

    const titleEl = brandHeader.querySelector('.brand-header-copy h1');
    const subtitleEl = brandHeader.querySelector('.brand-header-copy p');
    const glowEl = brandHeader.querySelector('.brand-header-glow');

    if (!titleEl) return;

    const HEADER_COMPACT_KEY = 'zentiq_header_compact';
    const isMeaningfulMessage = (msg) => {
        if (!msg || msg.isSystemMessage) return false;
        const role = String(msg.role || '').toLowerCase();
        if (role.includes('loading')) return false;
        return role === 'user' || role === 'model' || role === 'assistant';
    };

    const hasMeaningfulHistory = Object.values(messageCache).some((messages) =>
        Array.isArray(messages) && messages.some(isMeaningfulMessage)
    );

    const useCompactHeader = localStorage.getItem(HEADER_COMPACT_KEY) === '1' || hasMeaningfulHistory;
    if (useCompactHeader) {
        localStorage.setItem(HEADER_COMPACT_KEY, '1');
    }

    const headerModelBtn = document.getElementById('header-model-btn');
    const currentModelName = document.getElementById('current-model-name');

    if (mode === true || mode === 'deepResearch') {
        titleEl.textContent = '🔬 Deep Research Mode';
        if (subtitleEl) subtitleEl.style.display = 'none';
        if (glowEl) glowEl.style.display = 'none';
        brandHeader.classList.add('deep-mode');
        brandHeader.classList.remove('swift-mode');
        
        if (headerModelBtn) headerModelBtn.style.pointerEvents = 'none';
        if (currentModelName) currentModelName.textContent = '🔬 Gemini API';
    } else if (mode === 'swiftChat') {
        titleEl.textContent = '⚡ SwiftChat Mode';
        if (subtitleEl) subtitleEl.style.display = 'none';
        if (glowEl) glowEl.style.display = 'none';
        brandHeader.classList.add('swift-mode');
        brandHeader.classList.remove('deep-mode');
        
        if (headerModelBtn) headerModelBtn.style.pointerEvents = 'none';
        if (currentModelName) currentModelName.textContent = '⚡ ' + getSwiftModelDisplayName(selectedSwiftModel);
    } else {
        titleEl.textContent = useCompactHeader ? 'ZentiqAI' : 'Welcome to ZentiqAI';
        if (subtitleEl) subtitleEl.style.display = useCompactHeader ? 'none' : '';
        if (glowEl) glowEl.style.display = useCompactHeader ? 'none' : '';
        brandHeader.classList.remove('deep-mode');
        brandHeader.classList.remove('swift-mode');
        
        if (headerModelBtn) headerModelBtn.style.pointerEvents = 'auto';
        if (currentModelName) currentModelName.textContent = selectedChatModel || 'Select Model';
    }
}

async function switchChat(id) {
    if (isSending) return;
    if (id === currentSessionId) return;
    
    // Check if leaving deep research mode
    if (currentSessionId === deepResearchSessionId && id !== deepResearchSessionId) {
        exitDeepResearchMode();
    }
    
    // Exit swift chat mode
    if (chatSessions[currentSessionId]?.isSwiftChat && !chatSessions[id]?.isSwiftChat) {
        exitSwiftChatMode();
    }
    // Enter swift chat mode
    if (chatSessions[id]?.isSwiftChat) {
        swiftChatMode = true;
        updateBrandHeader('swiftChat');
        showSwiftModelSelector();
        // Disable image controls when entering swift chat via switch
        try {
            const imgInput = document.getElementById("img-input");
            const imgUploadBtn = document.getElementById("img-upload-btn");
            if (imgInput) imgInput.disabled = true;
            if (imgUploadBtn) {
                imgUploadBtn.classList.add("disabled");
                imgUploadBtn.style.pointerEvents = "none";
            }
        } catch (e) {}
    } else {
        swiftChatMode = false;
        hideSwiftModelSelector();
        // Re-enable image controls when leaving swift chat (respect server state)
        try {
            const imgInput = document.getElementById("img-input");
            const imgUploadBtn = document.getElementById("img-upload-btn");
            if (imgInput && !serverOffline) imgInput.disabled = false;
            if (imgUploadBtn) {
                imgUploadBtn.classList.remove("disabled");
                imgUploadBtn.style.pointerEvents = serverOffline ? "none" : "auto";
            }
        } catch (e) {}
    }

    // Check if entering deep research mode
    if (id === deepResearchSessionId) {
        deepResearchMode = true;
        updateBrandHeader(true);
        
        // Switch to deep research session
        currentSessionId = id;
        updateActiveChatHighlight(id);
        
        // Load from Firebase if cache is empty (e.g., after refresh), else render cache.
        if (!messageCache[id] || messageCache[id].length === 0) {
            await loadHistory(id);
        } else {
            renderMessagesFromCache(id);
        }
        
        if (window.innerWidth <= 768) document.getElementById("sidebar").classList.remove("mobile-open");
        return;
    }
    
    currentSessionId = id;
    updateActiveChatHighlight(id);
    
    if (!messageCache[id] || messageCache[id].length === 0) {
        await loadHistory(id);
    } else {
        renderMessagesFromCache(id);
    }
    if (window.innerWidth <= 768) document.getElementById("sidebar").classList.remove("mobile-open");
}

async function sendMessage(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    // Check if in deep research mode
    if (deepResearchMode && currentSessionId === deepResearchSessionId) {
        const remaining = getDeepResearchCount();
        
        if (remaining <= 0) {
            showInfoPopup("Daily Limit Reached", "You've used all 6 deep research messages today. The limit resets at midnight.");
            return;
        }
        
        // Use custom deep research send logic
        await sendDeepResearchMessage(e);
        
        // Decrement count
        const newCount = remaining - 1;
        saveDeepResearchCount(newCount);
        updateDeepResearchBadge();
        
        // Update welcome message if still visible
        if (messageCache[deepResearchSessionId].length > 0) {
            const firstMsg = messageCache[deepResearchSessionId][0];
            if (firstMsg.isSystemMessage) {
                // Update the system message with new count
                firstMsg.content = firstMsg.content.replace(/You have \d+ message(s?) remaining/, `You have ${newCount} message${newCount !== 1 ? 's' : ''} remaining`);
            }
        }
        
        return;
    }

    if (swiftChatMode) {
        await sendSwiftChatMessage(e);
        return;
    }

    if (isSending) {
        console.warn("⛔ BLOCKED: Wait for AI response.");
        return;
    }

    const input = document.getElementById("msg-input");
    const sendBtn = document.getElementById("send-btn");
    const text = input.value.trim();
    const hasImage = !!pendingImageBase64;

    if (!text && !hasImage) return;

    // Materialize draft chat in sidebar only when the user sends first message.
    if (!currentSessionId) {
        currentSessionId = generateSessionId();
    }
    if (!chatSessions[currentSessionId]) {
        chatSessions[currentSessionId] = {
            name: isGuest ? "Guest Chat" : "New Chat",
            timestamp: Date.now(),
            pinned: false
        };
        renderChatList();
        if (!isGuest) {
            await saveSessionMetaToFirebase();
        }
    }

    isSending = true;
    input.disabled = true;
    input.value = ""; 
    autoResizeMessageInput(input);
    if(sendBtn) {
        sendBtn.classList.add("disabled");
        sendBtn.style.pointerEvents = "none";
    }

    let loadingId; // Declare outside try so it's accessible in catch

    try {
        // Check if backend is available before sending chat
        if (!API_BASE || !API_BASE.trim()) {
            addMessageToUI("❌ Chat backend URL missing. Set apiBase in env.js or run locally on port 8080.", "model");
            isSending = false;
            input.disabled = false;
            if (shouldAutoFocusMessageInput()) input.focus();
            if(sendBtn) {
                sendBtn.classList.remove("disabled");
                sendBtn.style.pointerEvents = "auto";
            }
            return;
        }

        const imageToSend = pendingImageBase64;
        const userContent = text || "Image";
        const userMsg = {
            role: "user",
            content: userContent,
            timestamp: Date.now(),
            hasImage,
            image_base64: hasImage ? imageToSend : null
        };
        addMessageToUI(text, "user", imageToSend);
        addToCache(currentSessionId, userMsg);
        const storedMsg = hasImage
            ? { role: "user", content: userContent, timestamp: userMsg.timestamp, hasImage: true }
            : userMsg;
        saveMessageToFirebase(currentSessionId, storedMsg);
        localStorage.setItem('zentiq_header_compact', '1');
        updateBrandHeader(false);
        if (hasImage) clearImagePreview();

        loadingId = "loading-" + Date.now();
        addMessageToUI("Thinking...", "model loading-pulse", null, loadingId);

        // Build headers
        const headers = { 
            "Content-Type": "application/json", 
            "ngrok-skip-browser-warning": "true"
        };

        const response = await fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ session_id: currentSessionId, message: text, image_base64: imageToSend, is_guest: isGuest }),
            signal: AbortSignal.timeout(130000)
        }).catch(() => { throw new Error("Server Offline"); });

        document.getElementById(loadingId)?.remove();

        if (!response.ok) {
            let backendMessage = "Request failed";
            try {
                const errPayload = await response.json();
                backendMessage = errPayload?.detail || errPayload?.message || backendMessage;
            } catch {
                // Keep fallback message when error body is not JSON.
            }
            throw new Error(backendMessage);
        }
        const data = await response.json();

        if (data.response) {
            const botMsg = { role: "model", content: data.response, timestamp: Date.now() };
            addMessageToUI(data.response, "model", null, null, { typing: true, speed: 2.4 }); 
            addToCache(currentSessionId, botMsg);
            saveMessageToFirebase(currentSessionId, botMsg);
            
            // Server responded successfully, ensure input is enabled
            if (serverOffline) {
                enableMessageInput();
            }
        }

    } catch (err) {
        document.getElementById(loadingId)?.remove();
        
        if (err.message === "Server Offline" || err.message.includes("Server Offline")) {
            if (!serverOffline) {
                handleServerOffline();
            }
            addMessageToUI("❌ Server is offline. Please try again later.", "model");
        } else {
            addMessageToUI("Error: " + err.message, "model");
        }
    } finally {
        isSending = false;
        // Only re-enable input if server is not offline
        if (!serverOffline) {
            input.disabled = false;
            autoResizeMessageInput(input);
            if (shouldAutoFocusMessageInput()) input.focus();
            if(sendBtn) {
                sendBtn.classList.remove("disabled");
                sendBtn.style.pointerEvents = "auto";
            }
        }
    }
}

// ==========================================
// 6. FIREBASE SYNC FUNCTIONS
// ==========================================

let firebaseLoadedOnce = false;

function buildRecoveredMetaFromMessages(allChatsNode) {
    const recovered = {};
    if (!allChatsNode || typeof allChatsNode !== "object") return recovered;

    Object.keys(allChatsNode).forEach((sessionId) => {
        if (sessionId === "meta") return;
        const sessionNode = allChatsNode[sessionId];
        const messages = sessionNode && sessionNode.messages;
        if (!messages || typeof messages !== "object") return;

        const msgList = Object.values(messages);
        if (!msgList.length) return;

        const lastTs = msgList.reduce((maxTs, m) => Math.max(maxTs, Number(m?.timestamp) || 0), 0) || Date.now();
        const firstUser = msgList.find((m) => m?.role === "user" && typeof m?.content === "string" && m.content.trim());
        const title = firstUser
            ? firstUser.content.trim().slice(0, 32)
            : "Recovered Chat";

        recovered[sessionId] = {
            name: title,
            timestamp: lastTs,
            pinned: false,
        };
    });

    return recovered;
}

async function loadSessionsFromFirebase() {
    if (isGuest) return;
    if (firebaseLoadedOnce) return; 
    firebaseLoadedOnce = true;

    // Wait for Firebase Auth to be ready
    if (!auth || !auth.currentUser) {
        console.warn("⚠️ Firebase Auth not ready, waiting...");
        // Wait a bit for auth to complete
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!auth || !auth.currentUser) {
            console.warn("⚠️ Firebase Auth still not ready, creating new chat");
            await createNewChat(false);
            return;
        }
    }

    try {
        const userChatsRef = child(ref(db), `chats/${currentUser}`);
        const rootSnapshot = await get(userChatsRef);

        if (rootSnapshot.exists()) {
            const allChatsNode = rootSnapshot.val() || {};
            const metaNode = allChatsNode.meta;

            if (metaNode && typeof metaNode === "object" && Object.keys(metaNode).length > 0) {
                chatSessions = metaNode;
            } else {
                const recoveredMeta = buildRecoveredMetaFromMessages(allChatsNode);
                if (Object.keys(recoveredMeta).length > 0) {
                    chatSessions = recoveredMeta;
                    await set(ref(db, `chats/${currentUser}/meta`), recoveredMeta);
                    console.log("✅ Recovered chat meta from message history.");
                } else {
                    await createNewChat(true);
                    return;
                }
            }

            Object.keys(chatSessions).forEach(id => {
                if (typeof chatSessions[id].pinned !== "boolean") {
                    chatSessions[id].pinned = false;
                }
            });

            const ids = Object.keys(chatSessions).sort((a, b) => chatSessions[b].timestamp - chatSessions[a].timestamp);
            if (ids.length > 0) {
                currentSessionId = ids[0];
            } else {
                await createNewChat(true);
                return;
            }
        } else {
            await createNewChat(true);
            return;
        }
        
        renderChatList();
        //"Loading history for initial session:", currentSessionId);
        await loadHistory(currentSessionId);
        
    } catch (e) { 
        if (e.code === 'PERMISSION_DENIED') {
            console.error("🔒 Firebase permission denied. Creating new chat instead.");
            await createNewChat(false);
        } else {
            console.error("Firebase Error:", e); 
        }
    }
}

async function saveSessionMetaToFirebase() {
    if (isGuest) return;
    
    // Check if authenticated with Firebase Auth
    if (!auth || !auth.currentUser) {
        console.warn("⚠️ Not authenticated with Firebase Auth, skipping meta save");
        return;
    }
    
    try {
        await set(ref(db, `chats/${currentUser}/meta`), chatSessions);
    } catch (e) {
        if (e.code === 'PERMISSION_DENIED') {
            console.warn("🔒 Firebase permission denied for meta save.");
        } else {
            console.warn("Meta save error:", e.message);
        }
    }
}

async function saveMessageToFirebase(sessionId, msgObj) {
    if (!USE_FIREBASE || isGuest) return;
    
    // Check if authenticated with Firebase Auth
    if (!auth || !auth.currentUser) {
        console.warn("⚠️ Not authenticated with Firebase Auth, skipping save");
        return;
    }
    
    try {
        const messagesRef = child(ref(db), `chats/${currentUser}/${sessionId}/messages`);
        const snapshot = await get(messagesRef);
        if (snapshot.exists()) {
            const messages = snapshot.val();
            const msgKeys = Object.keys(messages);
            if (msgKeys.length >= 55) {
                const sortedKeys = msgKeys.sort((a, b) => messages[a].timestamp - messages[b].timestamp);
                const deleteCount = (msgKeys.length + 1) - 55; 
                for (let i = 0; i < deleteCount; i++) {
                    await remove(child(messagesRef, sortedKeys[i]));
                }
            }
        }
        const uniqueKey = Date.now() + Math.random().toString(36).substr(2, 5);
        await update(child(messagesRef, uniqueKey), msgObj);
    } catch (e) { 
        if (e.code === 'PERMISSION_DENIED') {
            console.warn("🔒 Firebase permission denied. User may need to re-authenticate.");
        } else {
            console.warn("DB Error:", e.message); 
        }
    }
}

async function loadHistory(sessionId) {
    //("Fetching history for:", sessionId);
    const chatBox = document.getElementById("chat-box");
    // Always clear UI when loading a session to avoid stale messages
    if (chatBox) chatBox.innerHTML = "";
    
    messageCache[sessionId] = [];
    if (isGuest) return;

    try {
        const snapshot = await get(child(ref(db), `chats/${currentUser}/${sessionId}/messages`));
        if (snapshot.exists()) {
            const msgs = snapshot.val();
            const sortedMsgs = Object.values(msgs).sort((a, b) => a.timestamp - b.timestamp);
            
            // Clear again to be safe before rendering
            if (chatBox) chatBox.innerHTML = "";
            
            sortedMsgs.forEach(msg => {
                addToCache(sessionId, msg);
                addMessageToUI(msg.content, msg.role, msg.image_base64 || null, null, { typing: false });
            });
            //("History loaded successfully.");
        } else {
            console.warn("⚠️ Chat exists in list, but has no messages.");
            if (chatBox) chatBox.innerHTML = "";
        }
    } catch (e) { console.error("Load History Error:", e); }

    updateHomeEmptyState();
    if (!deepResearchMode) {
        updateBrandHeader(false);
    }
}

// ==========================================
// 7. UTILS & UI HELPERS
// ==========================================

function startRenaming(id) {
    if (!requireLoginOrPopup()) return;
    
    // Prevent renaming deep research chat
    if (id === deepResearchSessionId) {
        showInfoPopup("Cannot Rename", "Deep Research Mode has a fixed name that cannot be changed.");
        return;
    }
    
    closeAllChatMenus();
    const item = document.querySelector(`.chat-item[data-id="${id}"]`);
    if (!item) return;
    const currentName = chatSessions[id].name;
    const container = item.querySelector(".chat-name-container");
    item.classList.add("editing");
    container.innerHTML = `
        <div style="display:flex; width:100%; gap:8px; align-items:center;">
            <input id="rename-${id}" type="text" placeholder="${currentName}" 
                   onkeydown="if(event.key==='Enter') finishRenaming('${id}', this.value)"
                   style="flex:1; padding:6px 8px; border-radius:4px; border:1px solid #00e5ff; color:black; font-size:14px;">
            <button onclick="finishRenaming('${id}', document.getElementById('rename-${id}').value)" style="color:#2cff8f; background:none; border:none; cursor:pointer; font-size:20px; padding:6px 10px; line-height:1; display:flex; align-items:center; justify-content:center; transition: all 0.2s;">✔</button>
        </div>
    `;
    setTimeout(() => document.getElementById(`rename-${id}`).focus(), 50);
}

function finishRenaming(id, newName) {
    if (newName && newName.trim()) {
        chatSessions[id].name = newName.trim();
        saveSessionMetaToFirebase(); 
    }
    renderChatList();
}

async function deleteChat(id) {
    if (!requireLoginOrPopup()) return;
    
    closeAllChatMenus();
    showDeleteChatConfirmation(id);
}

function togglePinChat(id) {
    if (!requireLoginOrPopup()) return;
    closeAllChatMenus();
    if (!chatSessions[id]) return;
    chatSessions[id].pinned = !chatSessions[id].pinned;
    saveSessionMetaToFirebase();
    renderChatList();
}

function toggleChatMenu(id) {
    const list = document.getElementById("chat-list");
    const menus = document.querySelectorAll(".chat-menu");
    menus.forEach(menu => {
        if (menu.dataset.id !== id) {
            menu.classList.remove("open");
            menu.parentElement?.classList.remove("menu-active");
        }
    });

    const menu = document.querySelector(`.chat-menu[data-id="${id}"]`);
    if (menu) {
        const shouldOpen = !menu.classList.contains("open");
        if (shouldOpen) {
            menu.classList.add("open");
            menu.parentElement?.classList.add("menu-active");
        } else {
            menu.classList.remove("open");
            menu.parentElement?.classList.remove("menu-active");
        }
    }

    const anyOpen = document.querySelector(".chat-menu.open");
    if (list) {
        if (anyOpen) list.classList.add("menu-open");
        else list.classList.remove("menu-open");
    }
}

function closeAllChatMenus() {
    document.querySelectorAll(".chat-menu.open").forEach(menu => {
        menu.classList.remove("open");
        menu.parentElement?.classList.remove("menu-active");
    });
    document.getElementById("chat-list")?.classList.remove("menu-open");
}

function showDeleteChatConfirmation(chatId) {
    // Remove any existing delete popup
    const existingPopup = document.getElementById("delete-chat-popup");
    if (existingPopup) existingPopup.remove();

    // Create popup overlay
    const overlay = document.createElement("div");
    overlay.id = "delete-chat-popup";
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        backdrop-filter: blur(5px);
        animation: fadeIn 0.3s ease;
    `;

    // Create popup box
    const box = document.createElement("div");
    box.style.cssText = `
        background: linear-gradient(330deg, rgb(25 47 173), rgb(6 6 12));
        border: 2px solid #ff4b4b;
        border-radius: 20px;
        padding: 40px 30px;
        max-width: 500px;
        width: 90%;
        box-shadow: 0 20px 60px rgba(255, 75, 75, 0.3);
        animation: modalPop 0.45s ease;
        text-align: center;
    `;

    const chatName = chatSessions[chatId]?.name || "Chat";

    box.innerHTML = `
        <div style="font-size: 60px; margin-bottom: 20px;">🗑️</div>
        <h2 style="color: #ff4b4b; margin: 0 0 20px 0; font-size: 28px; letter-spacing: 1px;">Delete Chat?</h2>
        <p style="color: #e2e8f0; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
            Are you sure you want to delete <b style="color: #2cff8f;">'${chatName}'</b>?<br><br>
            <span style="color: #ff4b4b; font-weight: bold;">⚠️ This action cannot be undone.</span>
        </p>
        <div style="display: flex; gap: 15px; justify-content: center;">
            <button id="delete-cancel-btn" style="
                background: transparent;
                color: #00e5ff;
                border: 2px solid #00e5ff;
                padding: 12px 30px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                transition: all 0.3s ease;
                letter-spacing: 0.5px;
            ">Cancel</button>
            <button id="delete-confirm-btn" style="
                background: linear-gradient(135deg, #ff4b4b, #ff2fd0);
                color: white;
                border: none;
                padding: 12px 30px;
                border-radius: 25px;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                box-shadow: 0 4px 15px rgba(255, 75, 75, 0.4);
                transition: all 0.3s ease;
                letter-spacing: 0.5px;
            ">Delete</button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Add keyframe animations if not already present
    if (!document.getElementById('delete-chat-popup-styles')) {
        const style = document.createElement('style');
        style.id = 'delete-chat-popup-styles';
        style.textContent = `
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes modalPop {
                0% { transform: scale(0.92); opacity: 0; }
                60% { transform: scale(1.03); opacity: 1; }
                100% { transform: scale(1); }
            }
            @keyframes fadeOut {
                from { opacity: 1; }
                to { opacity: 0; }
            }
            #delete-cancel-btn:hover {
                background: rgba(0, 229, 255, 0.1);
                transform: translateY(-2px);
                box-shadow: 0 4px 15px rgba(0, 229, 255, 0.3);
            }
            #delete-cancel-btn:active {
                transform: translateY(0);
            }
            #delete-confirm-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(255, 75, 75, 0.6);
            }
            #delete-confirm-btn:active {
                transform: translateY(0);
            }
        `;
        document.head.appendChild(style);
    }

    // Cancel button handler
    const cancelBtn = document.getElementById("delete-cancel-btn");
    cancelBtn.onclick = () => {
        overlay.style.animation = "fadeOut 0.3s ease";
        setTimeout(() => overlay.remove(), 300);
    };

    // Delete button handler
    const confirmBtn = document.getElementById("delete-confirm-btn");
    confirmBtn.onclick = async () => {
        overlay.style.animation = "fadeOut 0.3s ease";
        setTimeout(async () => {
            overlay.remove();
            
            // Check if deleting deep research chat - reset message count
            if (chatId === deepResearchSessionId) {
                localStorage.removeItem('deepResearchCount');
                deepResearchMode = false;
                // Update deep research badge
                const badge = document.querySelector('.deep-research-btn .badge');
                if (badge) badge.textContent = '6';
            }
            
            // Perform delete operation
            delete chatSessions[chatId];
            delete messageCache[chatId];
            
            // Delete from Firebase (for both regular and deep research chats)
            if (!isGuest && USE_FIREBASE && db) {
                try {
                    // Delete all messages in the chat
                    await remove(ref(db, `chats/${currentUser}/${chatId}`));
                    // Delete from chat metadata
                    await remove(ref(db, `chats/${currentUser}/meta/${chatId}`));
                    console.log(`✅ Deleted chat ${chatId} from Firebase`);
                } catch (error) {
                    console.error("Error deleting from Firebase:", error);
                }
            }
            
            if (chatId === currentSessionId) {
                const remaining = Object.keys(chatSessions);
                if (remaining.length > 0) {
                    currentSessionId = null;
                    renderChatList();
                    switchChat(remaining[0]);
                } else {
                    renderChatList();
                    createNewChat();
                }
            } else {
                renderChatList();
            }
        }, 300);
    };

    // Close on overlay click
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.style.animation = "fadeOut 0.3s ease";
            setTimeout(() => overlay.remove(), 300);
        }
    };
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return "now";
    const diffMs = Math.max(0, Date.now() - Number(timestamp));
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

function getChatPreviewText(sessionId) {
    const cached = messageCache[sessionId] || [];
    if (cached.length === 0) return "No messages yet";

    for (let i = cached.length - 1; i >= 0; i -= 1) {
        const msg = cached[i];
        if (!msg || typeof msg.content !== "string") continue;
        const text = msg.content.trim();
        if (!text) continue;
        return text.length > 44 ? `${text.slice(0, 44)}...` : text;
    }

    return "No messages yet";
}

function hasMeaningfulConversation(sessionId) {
    const messages = messageCache[sessionId] || [];
    return messages.some((msg) => {
        if (!msg || msg.isSystemMessage) return false;
        const role = String(msg.role || "").toLowerCase();
        if (!["user", "model", "assistant"].some((allowed) => role.includes(allowed))) return false;
        const text = typeof msg.content === "string" ? msg.content.trim() : "";
        return text.length > 0 || !!msg.image_base64 || !!msg.hasImage;
    });
}

function updateHomeEmptyState() {
    const main = document.querySelector(".main-content");
    const input = document.getElementById("msg-input");
    if (!main || !currentSessionId) return;

    const isEmpty = !hasMeaningfulConversation(currentSessionId);
    main.classList.toggle("home-empty-state", isEmpty);

    if (input) {
        input.placeholder = isEmpty ? "Send Message" : "Meow... ";
    }
}

function renderChatList() {
    const list = document.getElementById("chat-list");
    list.innerHTML = "";
    Object.keys(chatSessions)
        .sort((a, b) => {
            const aPinned = chatSessions[a].pinned ? 1 : 0;
            const bPinned = chatSessions[b].pinned ? 1 : 0;
            if (aPinned !== bPinned) return bPinned - aPinned;
            return chatSessions[b].timestamp - chatSessions[a].timestamp;
        })
        .forEach(id => {
            const pinned = chatSessions[id].pinned;
            const preview = getChatPreviewText(id);
            const updatedAt = formatRelativeTime(chatSessions[id].timestamp);
            const div = document.createElement("div");
            div.className = `chat-item ${id === currentSessionId ? 'active' : ''}`;
            div.dataset.id = id;
            div.onclick = (e) => {
                if (!e.target.closest('button') && !e.target.closest('input')) switchChat(id);
            };
            div.innerHTML = `
                <div class="chat-name-container">
                    ${pinned ? '<span class="chat-pin pinned">📌</span>' : ''}
                    <div class="chat-name-meta">
                        <span class="chat-name-text" ondblclick="startRenaming('${id}')">${chatSessions[id].name}</span>
                        <span class="chat-preview-text">${preview}</span>
                    </div>
                </div>
                <div class="chat-actions">
                    <span class="chat-time">${updatedAt}</span>
                    <button class="chat-menu-btn" aria-label="Chat menu" onclick="toggleChatMenu('${id}')">• • •</button>
                    <div class="chat-menu" data-id="${id}">
                        <button onclick="startRenaming('${id}')">Rename chat</button>
                        <button onclick="togglePinChat('${id}')">${pinned ? 'Unpin chat' : 'Pin chat'}</button>
                        <button class="danger" onclick="deleteChat('${id}')">Delete chat</button>
                    </div>
                </div>`;
            list.appendChild(div);
        });
}

function renderMessagesFromCache(sessionId) {
    if (sessionId !== currentSessionId) return;
    const chatBox = document.getElementById("chat-box");
    chatBox.innerHTML = "";
    if (!messageCache[sessionId]) {
        updateHomeEmptyState();
        return;
    }
    messageCache[sessionId].forEach(msg => {
        addMessageToUI(msg.content, msg.role, msg.image_base64 || null, null, { typing: false });
    });

    updateHomeEmptyState();
    if (!deepResearchMode) {
        updateBrandHeader(false);
    }
}

function typeMessageFast(targetEl, fullText, chatBox, speed = 2.2) {
    return new Promise(resolve => {
        const content = String(fullText ?? "");
        if (!content.length) {
            targetEl.textContent = "";
            resolve();
            return;
        }

        let index = 0;
        const minChunk = 2;
        const maxChunk = 10;
        const intervalMs = 14;

        const timer = setInterval(() => {
            const chunkSize = Math.max(minChunk, Math.min(maxChunk, Math.ceil(speed * 2)));
            index = Math.min(content.length, index + chunkSize);
            targetEl.textContent = content.slice(0, index);
            if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;

            if (index >= content.length) {
                clearInterval(timer);
                resolve();
            }
        }, intervalMs);
    });
}

function addMessageToUI(text, role, img, id, options = {}) {
    const box = document.getElementById("chat-box");
    if (!box) return;
    const displayText = typeof text === "string" ? text.trim() : text;
    const emptyHint = document.getElementById("empty-chat-hint");
    if (emptyHint) emptyHint.remove();
    const div = document.createElement("div");
    div.className = `message ${role}`;
    if (id) div.id = id;
    if (img) {
        const imgEl = document.createElement("img");
        imgEl.src = img;
        imgEl.alt = "attachment";
        imgEl.className = "chat-image";
        div.appendChild(imgEl);
        if (displayText && String(displayText).trim().length > 0) {
            const caption = document.createElement("div");
            caption.className = "chat-image-caption";
            caption.textContent = displayText;
            div.appendChild(caption);
        }
    } else {
        const isModelMessage = typeof role === "string" && role.includes("model") && !role.includes("loading-pulse");
        const shouldType = options.typing === true || (options.typing !== false && isModelMessage);
        if (shouldType) {
            div.textContent = "";
            box.appendChild(div);
            box.scrollTop = box.scrollHeight;
            typeMessageFast(div, displayText, box, options.speed || 2.2);
            return;
        }
        div.textContent = displayText;
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    const swiftChatBtn = document.getElementById("swift-chat-btn");
    if (swiftChatBtn) swiftChatBtn.addEventListener("click", enterSwiftChatMode);

    updateHomeEmptyState();
}

function addToCache(sid, msg) {
    if (!messageCache[sid]) messageCache[sid] = [];
    messageCache[sid].push(msg);
    if (sid === currentSessionId) updateHomeEmptyState();
}

function updateActiveChatHighlight(id) {
    document.querySelectorAll('.chat-item').forEach(e => e.classList.remove('active'));
    document.querySelector(`.chat-item[data-id="${id}"]`)?.classList.add('active');
}

function generateSessionId() { return "sess-" + Math.random().toString(36).substr(2, 9); }

// ==========================================
// 8. INITIALIZATION
// ==========================================

// Initialize app - no authentication needed
async function startApp() {
    //("🚀 Initializing app...");
    await initializeFirebase();
    await loadSecurityConfig();
    updateBrandHeader(false);
    //("✅ App Initialized");

    // Hide preloader immediately
    const preloader = document.getElementById('preloader');
    if (preloader) {
        //("📵 Hiding preloader...");
        toggleLoader(false);
    }

    // Keep auth modal visible until user logs in or chooses guest
    await restoreLoginSession();

    initAuthPanelAutoHeightObservers();
    syncAuthPanelsHeight(false);
    window.addEventListener("resize", () => {
        const authModal = document.getElementById("auth-modal");
        if (authModal && !authModal.classList.contains("hidden")) {
            syncAuthPanelsHeight(false);
        }
    });

    // 1. SETUP LOGIN BUTTON (already has onclick in HTML, ensure it's not duplicated)
    const loginBtn = document.querySelector("#auth-login-panel .btn-primary");
    if (loginBtn && !loginBtn.hasAttribute('data-initialized')) {
        loginBtn.setAttribute('data-initialized', 'true');
        //("✅ Login button ready");
    }

    // 2. SETUP SIGNUP CREATE BUTTON (already has onclick in HTML, ensure it's working)
    const signupCreateBtn = document.querySelector("#auth-signup-panel .btn-primary");
    if (signupCreateBtn && !signupCreateBtn.hasAttribute('data-initialized')) {
        signupCreateBtn.setAttribute('data-initialized', 'true');
        //("✅ Signup button ready");
    }

    // 3. SETUP SEND BUTTON
    const oldBtn = document.getElementById("send-btn");
    if (oldBtn) {
        const newBtn = oldBtn.cloneNode(true);
        oldBtn.parentNode.replaceChild(newBtn, oldBtn);
        newBtn.addEventListener("click", (e) => {
            e.preventDefault(); 
            e.stopImmediatePropagation();
            if (isSending) return; // Guard
            sendMessage(e);
        });
    }

    // 4. SETUP INPUT KEY LISTENER
    const msgInput = document.getElementById("msg-input");
    if (msgInput) {
        const newInput = msgInput.cloneNode(true);
        msgInput.parentNode.replaceChild(newInput, msgInput);
        newInput.id = "msg-input";
        enableGestureScrollForMessageInput(newInput);
        autoResizeMessageInput(newInput);
        newInput.addEventListener("input", () => autoResizeMessageInput(newInput));
        newInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { 
                e.preventDefault();
                e.stopImmediatePropagation();
                if (isSending) return; // Guard
                sendMessage(e);
            }
        });
    }

    // 5. SETUP SIDEBAR BUTTONS
    const openSidebarBtn = document.getElementById("open-sidebar-btn");
    if (openSidebarBtn) {
        openSidebarBtn.addEventListener("click", (e) => toggleSidebar(e));
    }

    const closeSidebarBtn = document.getElementById("close-sidebar-btn");
    if (closeSidebarBtn) {
        closeSidebarBtn.addEventListener("click", (e) => toggleSidebar(e));
    }

    setupSidebarSwipeClose();

    const newChatBtn = document.getElementById("new-chat-btn");
    if (newChatBtn) {
        newChatBtn.addEventListener("click", () => createNewChat());
    }

    // 5. SETUP IMAGE INPUT
    const imgInput = document.getElementById("img-input");
    if (imgInput) {
        const newImgInput = imgInput.cloneNode(true);
        imgInput.parentNode.replaceChild(newImgInput, imgInput);
        newImgInput.id = "img-input";
        newImgInput.addEventListener("change", handleImageSelection);
    }

    // 5. MOBILE AUTO-SCROLL
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            const chatBox = document.getElementById("chat-box");
            if (chatBox) chatBox.scrollTo({ top: chatBox.scrollHeight, behavior: 'smooth' });
            if (document.activeElement.tagName === "TEXTAREA") {
                document.activeElement.scrollIntoView({ block: "center", behavior: "smooth" });
            }
        });
    }

    // 6. OUTSIDE CLICK (Close Sidebar on Mobile)
    document.addEventListener('click', (e) => {
        const sidebar = document.getElementById("sidebar");
        
        if (window.innerWidth <= 768 && sidebar.classList.contains("mobile-open")) {
            if (!sidebar.contains(e.target)) {
                sidebar.classList.remove("mobile-open");
            }
        }

        if (!e.target.closest(".chat-actions")) {
            closeAllChatMenus();
        }
    });

    // 7. SERVER ALERT HANDLER
    const serverAlertOk = document.getElementById("server-alert-ok");
    if (serverAlertOk) {
        serverAlertOk.addEventListener("click", hideServerAlert);
    }

    // 8. SETTINGS MODAL HANDLERS
    setupSettingsHandlers();
    
    // 9. DEEP RESEARCH BUTTON
    const deepResearchBtn = document.getElementById("deep-research-btn");
    if (deepResearchBtn) {
        deepResearchBtn.addEventListener("click", openDeepResearchPopup);
        // Initialize badge count
        updateDeepResearchBadge();
        // Update button state based on guest mode
        updateDeepResearchButtonState();
    }

    const swiftChatBtn = document.getElementById("swift-chat-btn");
    if (swiftChatBtn) {
        swiftChatBtn.addEventListener("click", enterSwiftChatMode);
    }

    // Initialize SwiftChat model selector drop-up
    initSwiftModelSelector();

    updateHomeEmptyState();
}

// 🔒 Call startApp when DOM is ready
document.addEventListener("DOMContentLoaded", startApp);

// ==========================================
// 10. SETTINGS & ACCOUNT FUNCTIONS
// ==========================================

function setupSettingsHandlers() {
    const moreBtn = document.getElementById("more-btn");
    const closeSettingsBtn = document.getElementById("close-settings-btn");
    const settingsModal = document.getElementById("settings-modal");
    const settingsMenuBtns = document.querySelectorAll(".settings-menu-btn");
    const settingsAlert = document.getElementById("settings-alert");
    const settingsAlertOk = document.getElementById("settings-alert-ok");
    const closeModelBtn = document.getElementById("close-model-btn");
    const cancelModelBtn = document.getElementById("cancel-model-btn");

    if (moreBtn) {
        moreBtn.addEventListener("click", () => {
            settingsModal.classList.remove("hidden");
            settingsModal.classList.add("active");
        });
    }

    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener("click", closeSettingsModal);
    }

    settingsMenuBtns.forEach(btn => {
        btn.addEventListener("click", handleSettingsAction);
    });

    // Close modal when clicking outside settings panel
    settingsModal.addEventListener("click", (e) => {
        if (e.target === settingsModal) {
            closeSettingsModal();
        }
    });

    if (settingsAlertOk) {
        settingsAlertOk.addEventListener("click", hideSettingsAlert);
    }

    if (settingsAlert) {
        settingsAlert.addEventListener("click", (e) => {
            if (e.target === settingsAlert) {
                hideSettingsAlert();
            }
        });
    }

    if (closeModelBtn) {
        closeModelBtn.addEventListener("click", closeModelModal);
    }

    if (cancelModelBtn) {
        cancelModelBtn.addEventListener("click", closeModelModal);
    }

    // Setup other modal close handlers
    setupModalBackdropClosers();
}

// Close modals when clicking outside
function setupModalBackdropClosers() {
    const modals = [
        { element: document.getElementById("model-modal"), closer: closeModelModal },
        { element: document.getElementById("password-modal"), closer: closePasswordModal },
        { element: document.getElementById("terms-modal"), closer: closeTermsModal },
        { element: document.getElementById("export-modal"), closer: closeExportModal },
        { element: document.getElementById("feedback-modal"), closer: closeFeedbackModal },
        { element: document.getElementById("logout-modal"), closer: closeLogoutModal },
        { element: document.getElementById("delete-account-modal"), closer: closeDeleteModal },
        { element: document.getElementById("deep-research-popup"), closer: closeDeepResearchPopup }
    ];

    modals.forEach(({ element, closer }) => {
        if (element) {
            element.addEventListener("click", (e) => {
                if (e.target === element) {
                    closer();
                }
            });
        }
    });

    // Close all modals with ESC key
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            const settingsAlert = document.getElementById("settings-alert");
            if (settingsAlert && settingsAlert.classList.contains("active")) {
                hideSettingsAlert();
            }
            const settingsModal = document.getElementById("settings-modal");
            if (settingsModal && !settingsModal.classList.contains("hidden")) {
                closeSettingsModal();
            }
            modals.forEach(({ element, closer }) => {
                if (element && !element.classList.contains("hidden")) {
                    closer();
                }
            });
        }
    });
}

function closeSettingsModal() {
    const settingsModal = document.getElementById("settings-modal");
    const settingsPanel = document.querySelector(".settings-panel");
    
    if (settingsPanel) {
        settingsPanel.classList.add("closing");
        setTimeout(() => {
            settingsModal.classList.add("hidden");
            settingsModal.classList.remove("active");
            settingsPanel.classList.remove("closing");
        }, 300);
    }
}

function handleSettingsAction(e) {
    const action = this.getAttribute("data-action");
    closeSettingsModal();

    // Small delay for smooth transition
    setTimeout(() => {
        switch(action) {
            case "select-model":
                if (isGuest) {
                    showSettingsAlert("Login Required", "Please log in to use model selection.");
                    return;
                }
                openModelModal();
                break;
            case "change-password":
                if (isGuest) {
                    showSettingsAlert("Guest Mode", "Password updates are disabled in guest mode. Log in to change your password.");
                    return;
                }
                openPasswordModal();
                break;
            case "view-terms":
                openTermsModal();
                break;
            case "export-chat":
                openExportModal();
                break;
            case "feedback":
                if (isGuest) {
                    showSettingsAlert("Guest Mode", "Please log in to give feedback.");
                    return;
                }
                openFeedbackModal();
                break;
            case "logout":
                openLogoutModal();
                break;
            case "delete-account":
                if (isGuest) {
                    showSettingsAlert("Guest Account", "This account is a guest account and cannot be deleted.");
                    return;
                }
                openDeleteAccountModal();
                break;
        }
    }, 200);
}

function updateSettingsAvailability() {
    const modelBtn = document.querySelector('.settings-menu-btn[data-action="select-model"]');
    const changePasswordBtn = document.querySelector('.settings-menu-btn[data-action="change-password"]');
    const feedbackBtn = document.querySelector('.settings-menu-btn[data-action="feedback"]');
    const deleteAccountBtn = document.querySelector('.settings-menu-btn[data-action="delete-account"]');
    if (!changePasswordBtn) return;

    if (isGuest) {
        if (modelBtn) {
            modelBtn.classList.add("disabled");
            modelBtn.setAttribute("aria-disabled", "true");
        }
        changePasswordBtn.classList.add("disabled");
        changePasswordBtn.setAttribute("aria-disabled", "true");
        if (feedbackBtn) {
            feedbackBtn.classList.add("disabled");
            feedbackBtn.setAttribute("aria-disabled", "true");
        }
        if (deleteAccountBtn) {
            deleteAccountBtn.classList.add("disabled");
            deleteAccountBtn.setAttribute("aria-disabled", "true");
        }
    } else {
        if (modelBtn) {
            modelBtn.classList.remove("disabled");
            modelBtn.removeAttribute("aria-disabled");
        }
        changePasswordBtn.classList.remove("disabled");
        changePasswordBtn.removeAttribute("aria-disabled");
        if (feedbackBtn) {
            feedbackBtn.classList.remove("disabled");
            feedbackBtn.removeAttribute("aria-disabled");
        }
        if (deleteAccountBtn) {
            deleteAccountBtn.classList.remove("disabled");
            deleteAccountBtn.removeAttribute("aria-disabled");
        }
    }
}

// ==========================================
// FEEDBACK
// ==========================================

function openFeedbackModal() {
    const modal = document.getElementById("feedback-modal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.classList.add("active");
    const input = document.getElementById("feedback-text");
    if (input) input.focus();
    const errorMsg = document.getElementById("feedback-error");
    if (errorMsg) {
        errorMsg.textContent = "";
        errorMsg.classList.remove("show");
    }
}

function closeFeedbackModal() {
    const modal = document.getElementById("feedback-modal");
    if (!modal) return;
    animateModalClose(modal, () => {
        const input = document.getElementById("feedback-text");
        if (input) input.value = "";
        const errorMsg = document.getElementById("feedback-error");
        if (errorMsg) {
            errorMsg.textContent = "";
            errorMsg.classList.remove("show");
        }
    });
}

function showFeedbackError(message) {
    const errorMsg = document.getElementById("feedback-error");
    if (!errorMsg) return;
    errorMsg.textContent = message;
    errorMsg.classList.add("show");
}

async function handleFeedbackSubmit() {
    const feedbackText = document.getElementById("feedback-text");
    const feedbackValue = feedbackText ? feedbackText.value.trim() : "";

    if (!feedbackValue) {
        showFeedbackError("Please enter your feedback before submitting.");
        return;
    }

    if (!db) {
        showFeedbackError("Database not available. Please refresh and try again.");
        return;
    }

    try {
        const errorMsg = document.getElementById("feedback-error");
        if (errorMsg) {
            errorMsg.innerHTML = '<span style="display: inline-block; animation: spin 0.8s linear infinite; margin-right: 8px;">⟳</span>Submitting...';
            errorMsg.classList.add("show");
        }

        const feedbackId = `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await set(ref(db, `feedback/${feedbackId}`), {
            username: currentUser || "guest",
            is_guest: isGuest || currentUser === "guest",
            text: feedbackValue,
            created_at: Date.now()
        });

        closeFeedbackModal();
        showSettingsAlert("Thank You", "Thank you for your feedback!");
    } catch (error) {
        console.error("❌ Feedback submission error:", error);
        showFeedbackError("Failed to submit feedback: " + error.message);
    }
}

// ==========================================
// PASSWORD CHANGE
// ==========================================

function openPasswordModal() {
    const modal = document.getElementById("password-modal");
    modal.classList.remove("hidden");
    modal.classList.add("active");
    document.getElementById("old-password").focus();
    document.getElementById("password-error").classList.remove("show");
}

function closePasswordModal() {
    const modal = document.getElementById("password-modal");
    animateModalClose(modal, () => {
        document.getElementById("old-password").value = "";
        document.getElementById("new-password").value = "";
        document.getElementById("confirm-password").value = "";
        document.getElementById("password-error").classList.remove("show");
    });
}

async function handlePasswordChange() {
    if (isGuest) {
        showPasswordError("Guest accounts cannot change passwords");
        return;
    }
    const oldPassword = document.getElementById("old-password").value.trim();
    const newPassword = document.getElementById("new-password").value.trim();
    const confirmPassword = document.getElementById("confirm-password").value.trim();
    const errorMsg = document.getElementById("password-error");

    errorMsg.classList.remove("show");

    // Validation
    if (!oldPassword || !newPassword || !confirmPassword) {
        showPasswordError("All fields are required");
        return;
    }

    if (newPassword.length < 6) {
        showPasswordError("New password must be at least 6 characters");
        return;
    }

    if (newPassword !== confirmPassword) {
        showPasswordError("New password and confirmation do not match");
        return;
    }

    if (newPassword === oldPassword) {
        showPasswordError("New password must be different from old password");
        return;
    }

    try {
        if (!db) {
            showPasswordError("Database not ready. Please refresh the page.");
            return;
        }

        const userSnap = await get(child(ref(db), `users/${currentUser}`));
        if (!userSnap.exists()) {
            showPasswordError("User not found");
            return;
        }

        const userData = userSnap.val();
        if (!verifyPassword(oldPassword, userData.password)) {
            showPasswordError("Old password is incorrect");
            return;
        }

        await update(ref(db, `users/${currentUser}`), {
            password: encryptPassword(newPassword),
            password_changed_at: Date.now()
        });

        if (auth && auth.currentUser && auth.currentUser.email) {
            try {
                const credential = EmailAuthProvider.credential(auth.currentUser.email, oldPassword);
                await reauthenticateWithCredential(auth.currentUser, credential);
                await updateFirebasePassword(auth.currentUser, newPassword);
            } catch (authError) {
                console.warn("⚠️ Firebase Auth password update warning:", authError.message);
            }
        }

        showSettingsAlert("Success", "Password changed successfully!");
        closePasswordModal();
    } catch (error) {
        showPasswordError("Network error: " + error.message);
    }
}

function showPasswordError(message) {
    const errorMsg = document.getElementById("password-error");
    errorMsg.innerText = message;
    errorMsg.classList.add("show");
}

// ==========================================
// TERMS AND CONDITIONS
// ==========================================

const DEFAULT_TERMS = [
    {
        title: "1. Service Agreement",
        body: "By using ZentiqAI, you agree to these terms and conditions. These terms constitute a legally binding agreement between you and ZentiqAI."
    },
    {
        title: "2. Acceptable Use Policy",
        body: "You agree not to use ZentiqAI for any unlawful or harmful purposes. This includes but is not limited to harassment, abuse, or spreading misinformation."
    },
    {
        title: "3. Intellectual Property",
        body: "All content, features, and functionality of ZentiqAI are owned by ZentiqAI, its licensors, or other providers. You are prohibited from reproducing, transmitting, or distributing any content without permission."
    },
    {
        title: "4. Limitation of Liability",
        body: "ZentiqAI is provided on an \"as-is\" basis. We do not warrant that the service will be uninterrupted or error-free. In no event shall ZentiqAI be liable for any indirect, incidental, or consequential damages."
    },
    {
        title: "5. Privacy and Data Protection",
        body: "We are committed to protecting your personal information and handling it responsibly. Your chats may be used to train our model for future updates."
    },
    {
        title: "6. Modification of Terms",
        body: "We reserve the right to modify these terms at any time. Changes will be effective immediately upon posting to the Service. Your continued use constitutes acceptance of any modifications."
    },
    {
        title: "7. Termination",
        body: "We reserve the right to terminate your account at any time for violation of these terms or for any reason we deem appropriate."
    },
    {
        title: "8. Governing Law",
        body: "These terms are governed by and construed in accordance with applicable laws, and you irrevocably submit to the jurisdiction of courts in the applicable location."
    }
];

async function uploadDefaultTermsToFirebase() {
    const deviceId = getDeviceId();
    if (deviceId !== ADMIN_DEVICE_ID) {
        showInfoPopup("Access Denied", "Only the authorized device can update the terms and conditions.");
        return;
    }
    if (!USE_FIREBASE || !db) {
        showInfoPopup("Firebase Unavailable", "Firebase is not connected. Please configure Firebase first.");
        return;
    }

    try {
        await set(ref(db, "settings/terms"), DEFAULT_TERMS);
        showInfoPopup("Terms Updated", "Terms and conditions were uploaded to Firebase.");
    } catch (error) {
        showInfoPopup("Upload Failed", "Could not upload terms to Firebase.");
    }
}

async function loadTermsFromFirebase() {
    const termsEl = document.getElementById("terms-content");
    if (!termsEl) return;

    termsEl.innerHTML = "<p>Loading terms...</p>";

    if (!USE_FIREBASE || !db) {
        termsEl.innerHTML = "<p>Terms are unavailable at the moment.</p>";
        return;
    }

    try {
        const snapshot = await get(child(ref(db), "settings/terms"));
        if (!snapshot.exists()) {
            termsEl.innerHTML = "<p>Terms are unavailable at the moment.</p>";
            return;
        }

        const termsData = snapshot.val();
        if (typeof termsData === "string") {
            termsEl.innerHTML = termsData;
            return;
        }

        if (Array.isArray(termsData)) {
            termsEl.innerHTML = termsData
                .map((section, index) => {
                    const title = section.title || `Section ${index + 1}`;
                    const body = section.body || "";
                    return `<h3>${title}</h3><p>${body}</p>`;
                })
                .join("");
            return;
        }

        termsEl.textContent = JSON.stringify(termsData, null, 2);
    } catch (error) {
        termsEl.innerHTML = "<p>Failed to load terms. Please try again later.</p>";
    }
}

function openTermsModal() {
    const modal = document.getElementById("terms-modal");
    modal.classList.remove("hidden");
    modal.classList.add("active");
    loadTermsFromFirebase();
}

function closeTermsModal() {
    const modal = document.getElementById("terms-modal");
    animateModalClose(modal);
}

// ==========================================
// CHAT EXPORT
// ==========================================

function openExportModal() {
    const modal = document.getElementById("export-modal");
    modal.classList.remove("hidden");
    modal.classList.add("active");
}

function closeExportModal() {
    const modal = document.getElementById("export-modal");
    animateModalClose(modal);
}

async function exportChat(format) {
    try {
        if (!currentSessionId || !messageCache[currentSessionId]) {
            showSettingsAlert("Error", "No chat to export");
            return;
        }

        const messages = messageCache[currentSessionId];
        
        if (messages.length === 0) {
            showSettingsAlert("Info", "Your chat is empty");
            return;
        }

        let content = "";
        let filename = `ZentiqAI-Chat-${new Date().toISOString().split('T')[0]}`;

        if (format === "json") {
            content = JSON.stringify(messages, null, 2);
            filename += ".json";
        } else if (format === "txt") {
            content = messages
                .map(msg => {
                    const role = msg.role === "user" ? "You" : "ZentiqAI";
                    return `${role}: ${msg.content}`;
                })
                .join("\n\n");
            filename += ".txt";
        }

        // Create blob and download
        const blob = new Blob([content], { 
            type: format === "json" ? "application/json" : "text/plain" 
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        closeExportModal();
        showSettingsAlert("Success", "Chat exported successfully!");
    } catch (error) {
        showSettingsAlert("Error", "Failed to export chat: " + error.message);
    }
}

// ==========================================
// LOGOUT
// ==========================================

function openLogoutModal() {
    const modal = document.getElementById("logout-modal");
    modal.classList.remove("hidden");
    modal.classList.add("active");
}

function closeLogoutModal() {
    const modal = document.getElementById("logout-modal");
    animateModalClose(modal);
}

function handleLogoutConfirm() {
    closeLogoutModal();
    toggleLoader(true);
    setTimeout(() => {
        forceLogout();
        toggleLoader(false);
    }, 1500);
}

// ==========================================
// DELETE ACCOUNT
// ==========================================

function openDeleteAccountModal() {
    const modal = document.getElementById("delete-account-modal");
    modal.classList.remove("hidden");
    modal.classList.add("active");
    document.getElementById("recovery-code").focus();
    document.getElementById("delete-error").classList.remove("show");
}

function closeDeleteModal() {
    const modal = document.getElementById("delete-account-modal");
    animateModalClose(modal, () => {
        document.getElementById("recovery-code").value = "";
        document.getElementById("delete-error").classList.remove("show");
    });
}

async function handleAccountDeletion() {
    const recoveryCode = document.getElementById("recovery-code").value.trim();
    const errorMsg = document.getElementById("delete-error");

    errorMsg.classList.remove("show");

    if (!recoveryCode) {
        showDeleteError("Recovery code is required");
        return;
    }

    // Check if Firebase is initialized
    if (!db) {
        showDeleteError("Database not available. Please refresh and try again.");
        return;
    }

    try {
        // Show loading state
        errorMsg.innerHTML = '<span style="display: inline-block; animation: spin 0.8s linear infinite; margin-right: 8px;">⟳</span>Verifying...';
        errorMsg.classList.add("show");

        // Verify recovery code
        const userSnap = await get(child(ref(db), `users/${currentUser}`));
        
        if (!userSnap.exists()) {
            showDeleteError("Account not found");
            return;
        }

        const userData = userSnap.val();
        
        if (userData.recovery_code !== recoveryCode) {
            showDeleteError("Invalid recovery code");
            return;
        }

        const deviceId = userData.device_id;

        // Delete user data, device mapping, recovery code mapping, and all chats
        await remove(ref(db, `users/${currentUser}`));
        await remove(ref(db, `devices/${deviceId}`));
        await remove(ref(db, `recovery_codes/${recoveryCode}`));
        await remove(ref(db, `chats/${currentUser}`));
        
        //(`✅ Account '${currentUser}' deleted successfully`);

        // Clear localStorage
        localStorage.removeItem(`failed_attempts_${currentUser}`);
        localStorage.removeItem(`lockout_start_${currentUser}`);
        
        closeDeleteModal();
        showSettingsAlert("Account Deleted", "Your account has been permanently deleted. You will be logged out.");
        setTimeout(() => forceLogout(), 2000);

    } catch (error) {
        console.error("❌ Account deletion error:", error);
        showDeleteError("Failed to delete account: " + error.message);
    }
}

function showDeleteError(message) {
    const errorMsg = document.getElementById("delete-error");
    errorMsg.innerText = message;
    errorMsg.classList.add("show");
}

// ==========================================
// DEBUG HELPERS
// ==========================================
async function debugCreateTestUser(username = "test", password = "test123") {
    if (!db) {
        console.error("❌ Firebase not initialized");
        return;
    }
    
    try {
        //(`🧪 Creating test user: ${username}`);
        const deviceId = getDeviceId();
        const recoveryCode = generateRecoveryCode();
        
        await set(ref(db, `users/${username}`), {
            password: password,
            device_id: deviceId,
            recovery_code: recoveryCode,
            created_at: Date.now()
        });
        
        await set(ref(db, `usernames/${username}`), true).catch(e => console.warn("⚠️ Usernames index write failed:", e));
        await set(ref(db, `devices/${deviceId}`), username);
        await set(ref(db, `recovery_codes/${recoveryCode}`), {
            username: username,
            device_id: deviceId
        });
        
        //(`✅ Test user created!`);
        //(`   Username: ${username}`);
        //(`   Password: ${password}`);
        //(`   Recovery Code: ${recoveryCode}`);
        //(`   Try logging in now!`);
        
        return { username, password, recoveryCode };
    } catch (e) {
        console.error("❌ Failed to create test user:", e);
    }
}

async function debugListAllUsers() {
    if (!db) {
        console.error("❌ Firebase not initialized");
        return;
    }
    
    try {
        //("📋 Fetching all users from Firebase...");
        const snapshot = await get(child(ref(db), "users"));
        
        if (snapshot.exists()) {
            const users = snapshot.val();
            //("✅ Users found:");
            Object.keys(users).forEach(username => {
                //(`   - ${username} (password: ${users[username].password})`);
            });
        } else {
            //("⚠️ No users found in Firebase. Run: debugCreateTestUser()");
        }
    } catch (e) {
        console.error("❌ Error fetching users:", e);
    }
}

// ==========================================
// DEEP RESEARCH MODE
// ==========================================

let deepResearchMode = false;
let deepResearchSessionId = "deep-research-session";
let deepResearchMessages = [];

let swiftChatMode = false;
let swiftChatSessionId = "swift-chat-session";
let selectedSwiftModel = "meta-llama/llama-4-scout-17b-16e-instruct";

// SwiftChat model display names map
const SWIFT_MODEL_NAMES = {
    "meta-llama/llama-4-scout-17b-16e-instruct": "Llama 4 Scout 17B",
    "llama-3.3-70b-versatile": "Llama 3.3 70B",
    "meta-llama/llama-prompt-guard-2-22m": "Prompt Guard 2 22M",
    "meta-llama/llama-prompt-guard-2-86m": "Prompt Guard 2 86M",
    "openai/gpt-oss-120b": "GPT OSS 120B",
    "openai/gpt-oss-20b": "GPT OSS 20B",
    "openai/gpt-oss-safeguard-20b": "GPT OSS Safeguard 20B",
    "qwen/qwen3-32b": "Qwen3 32B"
};

function getSwiftModelDisplayName(modelId) {
    return SWIFT_MODEL_NAMES[modelId] || modelId;
}

function showSwiftModelSelector() {
    const selector = document.getElementById("swift-model-selector");
    if (selector) selector.classList.remove("hidden");
}

function hideSwiftModelSelector() {
    const selector = document.getElementById("swift-model-selector");
    if (selector) selector.classList.add("hidden");
    // Also close the dropup if open
    closeSwiftModelDropup();
}

function toggleSwiftModelDropup() {
    const dropup = document.getElementById("swift-model-dropup");
    const toggleBtn = document.getElementById("swift-model-toggle-btn");
    if (!dropup || !toggleBtn) return;

    const isOpen = dropup.classList.contains("open");
    if (isOpen) {
        closeSwiftModelDropup();
    } else {
        dropup.classList.remove("hidden");
        dropup.classList.add("open");
        toggleBtn.classList.add("open");
    }
}

function closeSwiftModelDropup() {
    const dropup = document.getElementById("swift-model-dropup");
    const toggleBtn = document.getElementById("swift-model-toggle-btn");
    if (dropup) {
        dropup.classList.remove("open");
        dropup.classList.add("hidden");
    }
    if (toggleBtn) toggleBtn.classList.remove("open");
}

function selectSwiftModel(modelId) {
    selectedSwiftModel = modelId;

    // Update toggle button label
    const label = document.getElementById("swift-model-current");
    if (label) label.textContent = getSwiftModelDisplayName(modelId);

    // Update active state in the list
    const options = document.querySelectorAll(".swift-model-option");
    options.forEach(opt => {
        if (opt.dataset.model === modelId) {
            opt.classList.add("active");
        } else {
            opt.classList.remove("active");
        }
    });

    // Update brand header model name
    const currentModelName = document.getElementById('current-model-name');
    if (currentModelName && swiftChatMode) {
        currentModelName.textContent = '⚡ ' + getSwiftModelDisplayName(modelId);
    }

    // Close the dropup after selection
    closeSwiftModelDropup();
}

function initSwiftModelSelector() {
    // Toggle button
    const toggleBtn = document.getElementById("swift-model-toggle-btn");
    if (toggleBtn) {
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleSwiftModelDropup();
        });
    }

    // Model option buttons
    const options = document.querySelectorAll(".swift-model-option");
    options.forEach(opt => {
        opt.addEventListener("click", (e) => {
            e.stopPropagation();
            const modelId = opt.dataset.model;
            if (modelId) selectSwiftModel(modelId);
        });
    });

    // Close dropup when clicking outside
    document.addEventListener("click", (e) => {
        const selector = document.getElementById("swift-model-selector");
        if (selector && !selector.contains(e.target)) {
            closeSwiftModelDropup();
        }
    });
}


// Load deep research message count from localStorage
function getDeepResearchCount() {
    const today = new Date().toDateString();
    const stored = JSON.parse(localStorage.getItem('deepResearchData') || '{}');
    
    // Reset if it's a new day
    if (stored.date !== today) {
        return 6; // Reset to 6 messages
    }
    
    return stored.remaining || 6;
}

// Save deep research message count
function saveDeepResearchCount(count) {
    const today = new Date().toDateString();
    localStorage.setItem('deepResearchData', JSON.stringify({
        date: today,
        remaining: count
    }));
}

// Update the badge display
function updateDeepResearchBadge() {
    const badge = document.getElementById('deep-research-count');
    const remaining = getDeepResearchCount();
    if (badge) {
        badge.textContent = remaining;
        badge.style.background = remaining === 0 
            ? 'linear-gradient(135deg, #ff4b4b, #ff2fd0)' 
            : 'linear-gradient(135deg, #8a2be2, #4b0082)';
    }
}

// Open deep research popup
function openDeepResearchPopup() {
    // Check if guest mode - lock deep research for guests
    if (isGuest) {
        showInfoPopup("Login Required", "🔒 Deep Research Mode is a premium feature. Please login or create an account to access advanced AI capabilities.");
        return;
    }
    
    const remaining = getDeepResearchCount();
    const modal = document.getElementById('deep-research-popup');
    const remainingEl = document.getElementById('deep-research-remaining');
    
    if (remainingEl) remainingEl.textContent = remaining;
    
    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('active');
    }
}

// Close deep research popup
function closeDeepResearchPopup() {
    const modal = document.getElementById('deep-research-popup');
    if (modal) {
        modal.classList.remove('active');
        setTimeout(() => modal.classList.add('hidden'), 300);
    }
}

// Enter deep research mode
async function enterDeepResearchMode() {
    const remaining = getDeepResearchCount();
    
    if (remaining <= 0) {
        showInfoPopup("Daily Limit Reached", "You've used all 6 deep research messages today. The limit resets at midnight.");
        closeDeepResearchPopup();
        return;
    }
    
    closeDeepResearchPopup();
    
    // Switch to deep research mode
    deepResearchMode = true;
    
    // Load or create deep research session
    if (!chatSessions[deepResearchSessionId]) {
        chatSessions[deepResearchSessionId] = {
            id: deepResearchSessionId,
            name: "🔬 Deep Research Mode",
            createdAt: Date.now(),
            timestamp: Date.now(),
            pinned: true,
            isDeepResearch: true
        };
        
        // Initialize empty message cache
        messageCache[deepResearchSessionId] = [];
        
        // Save to Firebase if logged in
        if (!isGuest && USE_FIREBASE && db) {
            await set(ref(db, `chats/${currentUser}/meta/${deepResearchSessionId}`), chatSessions[deepResearchSessionId]);
        }
        
        // Add welcome message for new session
        const welcomeMsg = {
            role: "model",
            content: `🔬 **Welcome to Deep Research Mode**\n\nYou have ${remaining} message${remaining !== 1 ? 's' : ''} remaining today.\n\nThis mode uses advanced AI (Gemini API) for complex analysis and deep knowledge queries. Use your messages wisely for:\n\n• Complex research questions\n• In-depth analysis\n• Technical deep-dives\n• Advanced problem-solving\n\nYour message history is preserved separately from normal chats.`,
            timestamp: Date.now(),
            isSystemMessage: true
        };
        addToCache(deepResearchSessionId, welcomeMsg);
    }
    
    // Update chat list to show deep research session
    renderChatList();
    
    // Switch to deep research chat and clear/render messages
    currentSessionId = deepResearchSessionId;
    updateActiveChatHighlight(deepResearchSessionId);
    
    // Load from Firebase when cache is empty, otherwise render local cache.
    if (!messageCache[deepResearchSessionId] || messageCache[deepResearchSessionId].length === 0) {
        await loadHistory(deepResearchSessionId);
    } else {
        const chatBox = document.getElementById("chat-box");
        if (chatBox) chatBox.innerHTML = "";
        renderMessagesFromCache(deepResearchSessionId);
    }
    
    // Update UI to show deep research mode
    updateBrandHeader(true);
    
    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        document.getElementById("sidebar")?.classList.remove("mobile-open");
    }
}

// Exit deep research mode
function exitDeepResearchMode() {
    deepResearchMode = false;
    updateBrandHeader(false);
}

// ==========================================
// SWIFTCHAT MODE
// ==========================================

async function enterSwiftChatMode() {
    if (isGuest) {
        showInfoPopup("Login Required", "🔒 SwiftChat Mode is a premium feature. Please login or create an account.");
        return;
    }
    if (isSending) return;
    if (!isGuest && Object.keys(chatSessions).length >= 10) {
        showInfoPopup("Chat Limit", "You can create up to 10 chats. Please delete a chat to create a new one.");
        return;
    }
    
    deepResearchMode = false;
    swiftChatMode = true;
    
    // Keep SwiftChat as a draft until the first user message is sent.
    // The real sidebar entry is created in sendSwiftChatMessage().
    currentSessionId = "swift-" + generateSessionId();

    messageCache[currentSessionId] = [];
    chatSessions[currentSessionId] = {
        id: currentSessionId,
        name: "⚡ Swift Chat",
        createdAt: Date.now(),
        timestamp: Date.now(),
        pinned: false,
        isSwiftChat: true
    };

    const welcomeMsg = {
        role: "model",
        content: `⚡ **Welcome to SwiftChat Mode**

Experience instant responses powered by the Groq Llama 4 API. This mode provides ultra-fast answers with a lightweight context window.

Your message history is saved separately.`,
        timestamp: Date.now(),
        isSystemMessage: true
    };
    addToCache(currentSessionId, welcomeMsg);

    messageCache[currentSessionId] = [];
    delete chatSessions[currentSessionId];

    renderChatList();
    
    const chatBox = document.getElementById("chat-box");
    if (chatBox) chatBox.innerHTML = "";
    updateActiveChatHighlight(currentSessionId);
    updateHomeEmptyState();
    
    updateBrandHeader('swiftChat');
    showSwiftModelSelector();
    
    if (window.innerWidth <= 768) {
        document.getElementById("sidebar")?.classList.remove("mobile-open");
    }

    // Disable image upload controls in SwiftChat mode
    try {
        const imgInput = document.getElementById("img-input");
        const imgUploadBtn = document.getElementById("img-upload-btn");
        if (imgInput) imgInput.disabled = true;
        if (imgUploadBtn) {
            imgUploadBtn.classList.add("disabled");
            imgUploadBtn.style.pointerEvents = "none";
        }
    } catch (e) {
        // ignore
    }
}

function exitSwiftChatMode() {
    swiftChatMode = false;
    updateBrandHeader(false);
    hideSwiftModelSelector();

    // Re-enable image upload controls when exiting SwiftChat (unless server offline)
    try {
        const imgInput = document.getElementById("img-input");
        const imgUploadBtn = document.getElementById("img-upload-btn");
        if (imgInput && !serverOffline) imgInput.disabled = false;
        if (imgUploadBtn) {
            imgUploadBtn.classList.remove("disabled");
            imgUploadBtn.style.pointerEvents = serverOffline ? "none" : "auto";
        }
    } catch (e) {
        // ignore
    }
}

async function sendSwiftChatMessage(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    if (isSending) return;

    const input = document.getElementById("msg-input");
    const sendBtn = document.getElementById("send-btn");
    const text = input.value.trim();
    const hasImage = !!pendingImageBase64;

    if (!text && !hasImage) return;

    // Materialize SwiftChat draft only when first user message is sent.
    if (!currentSessionId) {
        currentSessionId = "swift-" + generateSessionId();
    }
    if (!chatSessions[currentSessionId]) {
        if (!isGuest && Object.keys(chatSessions).length >= 10) {
            showInfoPopup("Chat Limit", "You can create up to 10 chats. Please delete a chat to create a new one.");
            return;
        }

        chatSessions[currentSessionId] = {
            id: currentSessionId,
            name: "⚡ Swift Chat",
            createdAt: Date.now(),
            timestamp: Date.now(),
            pinned: false,
            isSwiftChat: true
        };

        renderChatList();
        updateActiveChatHighlight(currentSessionId);

        if (!isGuest && USE_FIREBASE && db) {
            await saveSessionMetaToFirebase();
        }
    }

    isSending = true;
    input.disabled = true;
    input.value = "";
    autoResizeMessageInput(input);
    if(sendBtn) {
        sendBtn.classList.add("disabled");
        sendBtn.style.pointerEvents = "none";
    }

    let loadingId;

    try {
        if (!API_BASE || !API_BASE.trim()) {
            addMessageToUI("❌ Backend URL missing.", "model");
            isSending = false;
            input.disabled = false;
            return;
        }

        const imageToSend = pendingImageBase64;
        const userContent = text || "Analyze this image";
        const userMsg = {
            role: "user",
            content: userContent,
            timestamp: Date.now(),
            hasImage,
            image_base64: hasImage ? imageToSend : null
        };
        
        addMessageToUI(text, "user", imageToSend);
        const storedMsg = hasImage
            ? { role: "user", content: userContent, timestamp: userMsg.timestamp, hasImage: true }
            : userMsg;
        addToCache(currentSessionId, storedMsg);
        if (chatSessions[currentSessionId]) {
            chatSessions[currentSessionId].timestamp = userMsg.timestamp;
            renderChatList();
            updateActiveChatHighlight(currentSessionId);
        }
        saveMessageToFirebase(currentSessionId, storedMsg);
        localStorage.setItem('zentiq_header_compact', '1');
        if (hasImage) clearImagePreview();

        loadingId = "loading-" + Date.now();
        addMessageToUI("⚡ Thinking swiftly...", "model loading-pulse", null, loadingId);

        const response = await fetch(`${API_BASE}/api/swift-chat`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                "ngrok-skip-browser-warning": "true"
            },
            body: JSON.stringify({ 
                session_id: currentSessionId, 
                message: text || "Analyze this image",
                image_base64: imageToSend,
                user_id: currentUser,
                swift_model: selectedSwiftModel
            })
        }).catch(() => { throw new Error("Server Offline"); });

        document.getElementById(loadingId)?.remove();

        if (!response.ok) throw new Error("Server Offline");
        const data = await response.json();

        if (data.response) {
            const botMsg = { 
                role: "model", 
                content: data.response, 
                timestamp: Date.now() 
            };
            addMessageToUI(data.response, "model");
            addToCache(currentSessionId, botMsg);
            saveMessageToFirebase(currentSessionId, botMsg);
            
            if (serverOffline) enableMessageInput();
        }

    } catch (err) {
        document.getElementById(loadingId)?.remove();
        if (err.message.includes("Server Offline")) {
            if (!serverOffline) handleServerOffline();
            addMessageToUI("❌ Server is offline. Please try again later.", "model");
        } else {
            addMessageToUI("Error: " + err.message, "model");
        }
    } finally {
        isSending = false;
        if (!serverOffline) {
            input.disabled = false;
            autoResizeMessageInput(input);
            if (shouldAutoFocusMessageInput()) input.focus();
            if(sendBtn) {
                sendBtn.classList.remove("disabled");
                sendBtn.style.pointerEvents = "auto";
            }
        }
    }
}


// Deep research message sender (uses Gemini API)
async function sendDeepResearchMessage(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }

    if (chatSessions[currentSessionId]?.isSwiftChat) {
        await sendSwiftChatMessage(e);
        return;
    }

    if (isSending) {
        console.warn("⛔ BLOCKED: Wait for AI response.");
        return;
    }

    const input = document.getElementById("msg-input");
    const sendBtn = document.getElementById("send-btn");
    const text = input.value.trim();
    const hasImage = !!pendingImageBase64;

    if (!text && !hasImage) return;

    isSending = true;
    input.disabled = true;
    input.value = "";
    autoResizeMessageInput(input);
    if(sendBtn) {
        sendBtn.classList.add("disabled");
        sendBtn.style.pointerEvents = "none";
    }

    let loadingId;

    try {
        if (!API_BASE || !API_BASE.trim()) {
            addMessageToUI("❌ Deep Research backend URL missing. Set apiBase in env.js or run locally on port 8080.", "model");
            isSending = false;
            input.disabled = false;
            autoResizeMessageInput(input);
            if (shouldAutoFocusMessageInput()) input.focus();
            if(sendBtn) {
                sendBtn.classList.remove("disabled");
                sendBtn.style.pointerEvents = "auto";
            }
            return;
        }

        const imageToSend = pendingImageBase64;
        const userContent = text || "Analyze this image";
        const userMsg = {
            role: "user",
            content: userContent,
            timestamp: Date.now(),
            hasImage,
            image_base64: hasImage ? imageToSend : null
        };
        
        addMessageToUI(text, "user", imageToSend);
        const storedMsg = hasImage
            ? { role: "user", content: userContent, timestamp: userMsg.timestamp, hasImage: true }
            : userMsg;
        addToCache(deepResearchSessionId, storedMsg);
        saveMessageToFirebase(deepResearchSessionId, storedMsg);
        localStorage.setItem('zentiq_header_compact', '1');
        if (hasImage) clearImagePreview();

        loadingId = "loading-" + Date.now();
        addMessageToUI(hasImage ? "🔬 Deep analyzing image..." : "🔬 Deep analyzing...", "model loading-pulse", null, loadingId);

        const headers = { 
            "Content-Type": "application/json", 
            "ngrok-skip-browser-warning": "true"
        };

        // Call deep research endpoint
        const response = await fetch(`${API_BASE}/api/deep-research`, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ 
                session_id: deepResearchSessionId, 
                message: text || "Analyze this image in detail",
                image_base64: imageToSend,
                user_id: currentUser
            })
        }).catch(() => { throw new Error("Server Offline"); });

        document.getElementById(loadingId)?.remove();

        if (!response.ok) throw new Error("Server Offline");
        const data = await response.json();

        if (data.response) {
            const botMsg = { 
                role: "model", 
                content: data.response, 
                timestamp: Date.now() 
            };
            addMessageToUI(data.response, "model");
            addToCache(deepResearchSessionId, botMsg);
            saveMessageToFirebase(deepResearchSessionId, botMsg);
            
            if (serverOffline) {
                enableMessageInput();
            }
        }

    } catch (err) {
        document.getElementById(loadingId)?.remove();
        
        if (err.message === "Server Offline" || err.message.includes("Server Offline")) {
            if (!serverOffline) {
                handleServerOffline();
            }
            addMessageToUI("❌ Server is offline. Please try again later.", "model");
        } else {
            addMessageToUI("Error: " + err.message, "model");
        }
    } finally {
        isSending = false;
        if (!serverOffline) {
            input.disabled = false;
            autoResizeMessageInput(input);
            if (shouldAutoFocusMessageInput()) input.focus();
            if(sendBtn) {
                sendBtn.classList.remove("disabled");
                sendBtn.style.pointerEvents = "auto";
            }
        }
    }
}

// ==========================================
// 9. EXPORTS
// ==========================================
window.handleLogin = handleLogin;
window.handleSignUp = handleSignUp;
window.handleGoogleLogin = handleGoogleLogin;
window.handleGuestLogin = handleGuestLogin;
window.openSignupPanel = openSignupPanel;
window.closeSignupPanel = closeSignupPanel;
window.createNewChat = createNewChat;
window.switchChat = switchChat;
window.sendMessage = sendMessage;
window.toggleSidebar = toggleSidebar; 
window.startRenaming = startRenaming;
window.finishRenaming = finishRenaming;
window.deleteChat = deleteChat;
window.toggleChatMenu = toggleChatMenu;
window.togglePinChat = togglePinChat;
window.closeModal = closeModal;
window.closePasswordModal = closePasswordModal;
window.closeTermsModal = closeTermsModal;
window.closeExportModal = closeExportModal;
window.closeFeedbackModal = closeFeedbackModal;
window.closeLogoutModal = closeLogoutModal;
window.handleLogoutConfirm = handleLogoutConfirm;
window.closeDeleteModal = closeDeleteModal;
window.handlePasswordChange = handlePasswordChange;
window.exportChat = exportChat;
window.handleAccountDeletion = handleAccountDeletion;
window.handleFeedbackSubmit = handleFeedbackSubmit;
window.API_BASE = API_BASE;
window.uploadDefaultTermsToFirebase = uploadDefaultTermsToFirebase;
window.getDeviceId = getDeviceId;
window.openDeepResearchPopup = openDeepResearchPopup;
window.closeDeepResearchPopup = closeDeepResearchPopup;
window.enterDeepResearchMode = enterDeepResearchMode;
window.exitDeepResearchMode = exitDeepResearchMode;
window.enterSwiftChatMode = enterSwiftChatMode;
window.exitSwiftChatMode = exitSwiftChatMode;
window.debugCreateTestUser = debugCreateTestUser;
window.debugListAllUsers = debugListAllUsers;
