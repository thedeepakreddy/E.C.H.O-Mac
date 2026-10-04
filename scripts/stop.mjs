#!/usr/bin/env node
// Electron's existing single-instance channel delivers the request to Echo.
// A stopped app exits before startup rather than launching a fresh assistant.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(require('electron'), [join(root), '--echo-shutdown'], { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(`Could not request Echo shutdown: ${error.message}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
