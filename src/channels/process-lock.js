import fs from 'node:fs';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireProcessLock(file, label = 'process') {
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`${label} 已在运行 (pid ${pid})`);
    fs.rmSync(file, { force: true });
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
    } catch {}
  };
}
