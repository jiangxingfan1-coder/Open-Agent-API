function withTimeout(pending, timeoutMs, message) {
  let timer;
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid desktop process ID.');
  const isRunning = options.isRunning ?? isProcessRunning;
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  while (isRunning(pid)) {
    if (Date.now() >= deadline) throw new Error('The desktop process did not exit.');
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
  }
}

module.exports = { withTimeout, waitForProcessExit };
