const fs = require("fs");
const path = require("path");

const root = __dirname;
const dist = path.join(root, "dist");

const filesToCopy = [
  "index.html",
  "script.js",
  "style.css",
  "icon.png",
  "bg..png",
  "chatbg.jpg",
  "env.js"
];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of filesToCopy) {
  const src = path.join(root, file);
  const dest = path.join(dist, file);
  if (!fs.existsSync(src)) {
    console.warn(`WARN: Missing file, skipping: ${file}`);
    continue;
  }
  fs.copyFileSync(src, dest);
}

// Keep a .jpeg alias for CSS compatibility when source file is .jpg.
const authBgJpg = path.join(dist, "chatbg.jpg");
const authBgJpeg = path.join(dist, "chatbg.jpeg");
if (fs.existsSync(authBgJpg) && !fs.existsSync(authBgJpeg)) {
  fs.copyFileSync(authBgJpg, authBgJpeg);
}

console.log("Prepared dist/ with static assets");
