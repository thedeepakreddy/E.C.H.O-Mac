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
  'test:audio-recovery': 'uses the real audio engine and microphone helper',
  'test:coding-desktop': 'compiles and opens a real native Swift window',
  lcuruntimetest: 'initializes the native LCU runtime without selecting apps or sending input',
  check: 'uses screen capture, permissions and the configured speech engine',
  waketest: 'uses installed macOS voices and local Whisper',
  wakeenginetest: 'uses installed voices and wake models',
  vadtest: 'uses macOS speech synthesis and the native VAD model',
  langroutetest: 'uses installed multilingual voices and Whisper',
  playertest: 'plays audible audio and can capture microphone frames',
  applestttest: 'uses macOS Speech Recognition permission',
};

export const UI_TESTS = {
  superviseduitest:'isolated Electron background-browser/report-window fixture',
  'test:panel-world':'isolated Electron World fixture',
  'test:panel-routes':'isolated Electron navigation fixture',
  'test:panel-performance':'isolated Electron renderer performance fixture',
  'test:panel-companion':'isolated Electron companion fixture',
  'test:panel-bots':'isolated Electron Bots fixture',
  'test:panel-office':'isolated Electron Office fixture',
  'test:panel-markdown':'isolated Electron Markdown fixture',
  'test:coding-ui':'disposable browser and local API/SQLite fixture',
  'test:calculator-ui':'HTML calculator fixture, NOT native macOS Calculator or LCU proof',
};

export function testMode(name) {
  return name in LIVE_TESTS ? 'live' : name in DEVICE_TESTS ? 'device' : name in UI_TESTS ? 'ui' : 'offline';
}

export function validateTestModes(scripts){
  const aliases=new Set(['test:offline','test:ui','test:live','test:device']);
  for(const name of Object.keys(scripts))if(name.startsWith('test:')&&!aliases.has(name)&&!(name in UI_TESTS)&&!(name in DEVICE_TESTS)&&!(name in LIVE_TESTS)){
    throw Error(`Unclassified test script: ${name}. Declare its offline/UI/live/device boundary before running the suite.`);
  }
}

export function selectTests(scripts, mode, filters = []) {
  return Object.keys(scripts).filter(name => name !== 'test')
    .filter(name => name.endsWith('test') || name === 'check' || name === 'e2e' || name in UI_TESTS || name in DEVICE_TESTS || name in LIVE_TESTS)
    .filter(name => testMode(name) === mode && (!filters.length || filters.some(filter => name.includes(filter))));
}
