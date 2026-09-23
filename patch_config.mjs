import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configPath = path.join(os.homedir(), '.jarvis', 'config.json');
let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Switch away from Sarvam to local free alternatives
config.voice.sttProvider = 'whisper';
config.voice.ttsEngine = 'mac';

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Updated config.json successfully');
