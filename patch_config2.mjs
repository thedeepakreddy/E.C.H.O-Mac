import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configPath = path.join(os.homedir(), '.jarvis', 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Switch away from auto to en
config.voice.sttLanguage = 'en';

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Updated sttLanguage to "en" successfully');
