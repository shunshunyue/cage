#!/usr/bin/env node
import { main } from '../dist/main.js';
main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
