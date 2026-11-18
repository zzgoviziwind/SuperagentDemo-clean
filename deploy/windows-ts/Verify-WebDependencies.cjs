const fs = require("node:fs");
const path = require("node:path");

const [lockPath, nodeModules] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
// npm v7+ records the resolved platform-specific tree here, excluding unused optional packages.
const installed = JSON.parse(fs.readFileSync(path.join(nodeModules, ".package-lock.json"), "utf8"));
for (const [name, pkg] of Object.entries(installed.packages)) {
  const expected = lock.packages[name];
  if (!expected || pkg.version !== expected.version || pkg.integrity !== expected.integrity) {
    throw new Error(`Installed web dependencies differ from package-lock.json: ${name}`);
  }
}
