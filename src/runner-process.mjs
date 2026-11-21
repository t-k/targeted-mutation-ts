import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [pidReport, timeout, command, ...args] = process.argv.slice(2);
const parent = process.ppid;
const child = spawn(process.execPath, [command, ...args], { detached: process.platform !== 'win32', stdio: 'inherit' });
let closed = false;
let status;
let interrupted = false;

function signalChild(signal) {
  if (!child.pid) return false;
  try {
    if (process.platform === 'win32') return child.kill(signal);
    return process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
}

function finish(code) {
  if (closed) return;
  closed = true;
  clearTimeout(deadline);
  clearInterval(parentWatch);
  status = interrupted ? 124 : code;
  if (!signalChild('SIGTERM')) {
    process.exitCode = status;
    return;
  }
  setTimeout(() => {
    signalChild('SIGKILL');
    process.exitCode = status;
  }, 120);
}

const deadline = setTimeout(() => {
  interrupted = true;
  finish(124);
}, Number(timeout));
const parentWatch = process.platform === 'win32' ? null : setInterval(() => {
  if (process.ppid === parent) return;
  interrupted = true;
  finish(124);
}, 200);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    finish(124);
  });
}
child.once('spawn', () => writeFileSync(pidReport, String(child.pid)));
child.once('exit', code => finish(code ?? 1));
child.once('error', error => {
  console.error(error.message);
  finish(1);
});
