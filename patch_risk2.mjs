import fs from 'node:fs';
let content = fs.readFileSync('src/safety/risk.ts', 'utf8');

const fallbackBlock = `// Fallback
      const l = label.toLowerCase();
      const IRREVERSIBLE: Array<[RegExp, string]> = [
        [/\\b(send|reply all|reply|forward)\\b/, "send this message"],
        [/\\b(delete|remove|trash|discard|erase)\\b/, "delete something"],
        [/\\b(pay|buy|purchase|checkout|check out|subscribe)\\b/, "spend your money"],
        [/\\bplace\\b.{0,12}\\border\\b/, "place an order"],
        [/\\bproceed\\b.{0,12}\\b(checkout|payment)\\b/, "start checking out"],
        [/\\badd\\b.{0,10}\\b(cart|basket|bag)\\b/, "add something to your shopping cart"],
        [/\\b(post|publish|tweet|share)\\b/, "publish this publicly"],
        [/\\b(sign in|log in|sign out|log out|deactivate|close account)\\b/, "change who is signed in"],
        [/\\b(confirm|submit|apply now|book now)\\b/, "submit this"],
      ];
      for (const [re, what] of IRREVERSIBLE) {`;

content = content.replace(/\/\/ Fallback\n      const l = label\.toLowerCase\(\);\n      for \(const \[re, what\] of IRREVERSIBLE\) \{/, fallbackBlock);
fs.writeFileSync('src/safety/risk.ts', content);
