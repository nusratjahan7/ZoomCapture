// `npm run dev`: rebuilds the extension pages and the click-tracker content script on every change.
import { spawn } from 'node:child_process';

const vite = (args) =>
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--watch', '--mode', 'development', ...args], {
    stdio: 'inherit',
  });

const children = [vite([]), vite(['-c', 'vite.content.config.ts'])];
const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
