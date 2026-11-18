// Applied only to the prepare CLI. Refuse and record any attempted socket or subprocess use.
const fs = require('node:fs');
const block = (name) => () => {
  fs.appendFileSync(process.env.REVIEW_SIDE_EFFECTS, name + '\n');
  throw Error('Unexpected prepare side effect: ' + name);
};
for (const [api, names] of [
  [require('node:child_process'), ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],
  [require('node:net').Server.prototype, ['listen']],
  [require('node:net').Socket.prototype, ['connect']],
  [require('node:dgram'), ['createSocket']],
  [require('node:dns'), ['lookup','resolve']],
  [globalThis, ['fetch']],
]) for (const name of names) api[name] = block(name);
require('node:module').syncBuiltinESMExports();
