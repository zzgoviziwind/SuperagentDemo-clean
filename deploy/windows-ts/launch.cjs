const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");

const stopFile = process.env.SUPERAGENT_STOP_FILE;
const logDirectory = process.env.SUPERAGENT_LOG_DIRECTORY;
delete process.env.SUPERAGENT_STOP_FILE;
delete process.env.SUPERAGENT_LOG_DIRECTORY;

// A detached Windows process must not hold the caller's PowerShell output pipe.
// The preloader opens its own logs instead of using Start-Process redirection.
const stdout = fs.openSync(path.join(logDirectory, "stdout.log"), "a");
const stderr = fs.openSync(path.join(logDirectory, "stderr.log"), "a");
function logStream(fd) {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        fs.writeFileSync(fd, chunk);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}
Object.defineProperties(process, {
  stdout: { value: logStream(stdout) },
  stderr: { value: logStream(stderr) },
});
process.on("uncaughtExceptionMonitor", error => {
  fs.writeFileSync(stderr, `${error.stack ?? error}\n`);
});
process.on("exit", () => {
  fs.closeSync(stdout);
  fs.closeSync(stderr);
});

const timer = setInterval(() => {
  // Windows cannot deliver POSIX SIGTERM to another Node process. Dispatch
  // the same event inside this process so the server's handler can close SQLite.
  if (stopFile && process.listenerCount("SIGTERM") !== 0 && fs.existsSync(stopFile)) {
    clearInterval(timer);
    process.emit("SIGTERM");
  }
}, 200);
timer.unref();
