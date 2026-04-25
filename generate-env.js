const fs = require("fs");
const path = require("path");

const requiredKeys = [
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_MESSAGING_SENDER_ID",
  "FIREBASE_APP_ID"
];

const missingKeys = requiredKeys.filter((key) => !String(process.env[key] || "").trim());
if (missingKeys.length > 0) {
  console.warn("WARNING: Missing Vercel environment variables (Firebase won't work):");
  missingKeys.forEach((key) => console.warn(`- ${key}`));
  console.warn("Writing env.js with empty values. Set these in Vercel Dashboard > Settings > Environment Variables.");
}

const config = {
  apiBase: process.env.API_BASE || process.env.API_BASE_URL || "",
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    databaseURL: process.env.FIREBASE_DATABASE_URL || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: process.env.FIREBASE_APP_ID || "",
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || ""
  },
  security: {
    masterPassword: process.env.MASTER_PASSWORD || "",
    encryptionKey: process.env.ENCRYPTION_KEY || "default-key",
    adminDeviceId: process.env.ADMIN_DEVICE_ID || ""
  }
};

const output = `window.__ZENTIQ_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`;
const outFile = path.join(__dirname, "env.js");
fs.writeFileSync(outFile, output, "utf8");

console.log("Generated env.js from environment variables");
