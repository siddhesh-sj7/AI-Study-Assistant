const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const mappings = [
  {
    source: path.join(projectRoot, "css"),
    target: path.join(projectRoot, "public", "css"),
  },
  {
    source: path.join(projectRoot, "js"),
    target: path.join(projectRoot, "public", "js"),
  },
];

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function syncDirectory(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  ensureDirectory(targetDir);

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      syncDirectory(sourcePath, targetPath);
      continue;
    }

    fs.copyFileSync(sourcePath, targetPath);
  }
}

for (const mapping of mappings) {
  syncDirectory(mapping.source, mapping.target);
}

console.log("Synced CSS and JS assets into public/ for deployment.");
