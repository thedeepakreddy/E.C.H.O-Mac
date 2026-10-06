export const LIVE_TESTS = {
  e2e: 'sends requests through the configured brain',
  safetytest: 'uses the real brain and confirmation flow',
  livetest: 'opens a real Gemini Live session',
  sttstreamtest: 'uses cloud speech recognition',
  ttsstreamtest: 'uses cloud speech synthesis',
  outsidetoolstest: 'connects to configured remote MCP servers',
  scriptvoicetest: 'uses configured cloud voices',
  openroutertest: 'queries the public OpenRouter service; live turns are opt-in',
};

export const DEVICE_TESTS = {
  check: 'uses screen capture, permissions and the configured speech engine',
  waketest: 'uses installed macOS voices and local Whisper',
  wakeenginetest: 'uses installed voices and wake models',
  vadtest: 'uses macOS speech synthesis and the native VAD model',
  langroutetest: 'uses installed multilingual voices and Whisper',
  playertest: 'plays audible audio and can capture microphone frames',
  applestttest: 'uses macOS Speech Recognition permission',
};

export function testMode(name) {
  return name in LIVE_TESTS ? 'live' : name in DEVICE_TESTS ? 'device' : 'offline';
}

export function selectTests(scripts, mode, filters = []) {
  return Object.keys(scripts).filter(name => name !== 'test' && !name.startsWith('test:'))
    .filter(name => name.endsWith('test') || name === 'check' || name === 'e2e')
    .filter(name => testMode(name) === mode && (!filters.length || filters.some(filter => name.includes(filter))));
}
