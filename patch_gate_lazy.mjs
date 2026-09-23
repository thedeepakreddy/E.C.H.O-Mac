import fs from 'node:fs';

let content = fs.readFileSync('src/safety/gate.ts', 'utf8');

// Replace eager init
content = content.replace(
  /const tsClient = new TypeSafeClient\(\);/,
  'let tsClient: TypeSafeClient | null = null;\nfunction getTsClient() {\n  if (!tsClient) tsClient = new TypeSafeClient();\n  return tsClient;\n}'
);

// Replace tsClient calls
content = content.replace(
  /await tsClient\.systemOne/g,
  'await getTsClient().systemOne'
);

fs.writeFileSync('src/safety/gate.ts', content);
