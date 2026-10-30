#!/usr/bin/env node
import { main } from '../dist/main.js';
main(['create', ...process.argv.slice(2)]).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
