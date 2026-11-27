#!/usr/bin/env node
import { main } from './cli.js';

const code = await main(process.argv.slice(2));
// null means a server is running.
if (code !== null) process.exitCode = code;
