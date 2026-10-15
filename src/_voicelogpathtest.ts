import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,mkdtempSync,mkdirSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import vm from 'node:vm';import ts from 'typescript';
const root=mkdtempSync(join(tmpdir(),'echo-voice-log-path-'));
try{
 const ast=ts.createSourceFile('log.ts',readFileSync('src/_voicelog.ts','utf8'),ts.ScriptTarget.Latest,true);
 const fn=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='latest');assert(fn);
 const current=join(root,'user-data','runs','voice'),legacy=join(root,'old-checkout','runs','voice');
 const scope=vm.createContext({dirs:[current,legacy],readdirSync,statSync,join});
 vm.runInContext(ts.transpile(fn.getText(ast)),scope);
 assert.equal(scope.latest(),null);
 mkdirSync(legacy,{recursive:true});const old=join(legacy,'old.jsonl');writeFileSync(old,'{}\n');utimesSync(old,1,1);
 assert.equal(scope.latest(),old,'Legacy logs remain readable without migration or deletion');
 mkdirSync(current,{recursive:true});const fresh=join(current,'new.jsonl');writeFileSync(fresh,'{}\n');utimesSync(fresh,2,2);
 assert.equal(scope.latest(),fresh,'Current mutable-data logs are discoverable');
 assert.equal(readFileSync(old,'utf8'),'{}\n');
 console.log('PASS mutable voice-log discovery and preserved legacy fallback; temporary fixture files only');
}finally{rmSync(root,{recursive:true,force:true});}
