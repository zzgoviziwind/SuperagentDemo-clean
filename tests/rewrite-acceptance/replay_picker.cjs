// Provide the native chooser's selected value from the isolated fixture directory.
// All other calls retain their original implementation.
const cp = require('node:child_process');
const {promisify} = require('node:util');
const original = cp.execFile;
function picker(exe, args, options) {
  return /powershell\.exe$/i.test(exe) && args.includes('-STA') &&
    options?.env?.SUPERAGENT_PICKER_INITIAL === process.env.SUPERAGENT_REPLAY_PROJECT;
}
function execFile(exe, args, options, cb) {
  if (!picker(exe, args, options)) return original.apply(this, arguments);
  cb(null, Buffer.from(options.env.SUPERAGENT_PICKER_INITIAL).toString('base64'), '');
}
execFile[promisify.custom] = async function(exe, args, options) {
  if (picker(exe, args, options))
    return {stdout: Buffer.from(options.env.SUPERAGENT_PICKER_INITIAL).toString('base64'), stderr:''};
  return promisify(original)(exe, args, options);
};
cp.execFile = execFile;
require('node:module').syncBuiltinESMExports();
