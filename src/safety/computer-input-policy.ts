/** Defense in depth for known command routes, NOT an OS sandbox. Arbitrary
 * account-privileged programs cannot be fully classified by source text.
 * Office specialists have no shell/process grants in the first place.
 */
function executableName(program:string):string {
 return program.trim().replace(/^(["'])(.*)\1$/s,'$2').split('/').at(-1)?.toLowerCase()??'';
}

interface LiteralCommand { words:string[]; stdin:string[]; pipe:boolean; }

// Only tokenize literal commands: quotes protect spaces/separators in paths and
// inline code. Heredoc bodies belong to their receiving command, not new shell
// commands. No expansion, filesystem resolution, or command execution occurs.
function literalCommands(command:string):LiteralCommand[] {
 const commands:LiteralCommand[]=[];
 const heredocs:Array<{delimiter:string;stripTabs:boolean;stdin:string[]}>=[];
 let words:string[]=[],stdin:string[]=[],word='',quote='',started=false;
 let heredocTabs:boolean|undefined;
 const endWord=()=>{
  if(started){
   if(heredocTabs!==undefined){
    heredocs.push({delimiter:word,stripTabs:heredocTabs,stdin});
    heredocTabs=undefined;
   }else words.push(word);
  }
  word='';started=false;
 };
 const endCommand=(pipe=false)=>{
  endWord();
  // These reserved words introduce executable conditions/bodies. Classify both
  // branches conservatively without trying to evaluate shell control flow.
  while(words.length&&(/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])||/^(?:if|then|elif|else|while|until|do)$/.test(words[0])))words.shift();
  if(words.length)commands.push({words,stdin,pipe});
  words=[];stdin=[];
 };
 for(let i=0;i<command.length;i++){
  const char=command[i];
  if(char==='\\'&&quote!=="'"&&i+1<command.length){
   const next=command[++i];
   if(next!=='\n'){word+=next;started=true;}
   continue;
  }
  if(quote){if(char===quote)quote='';else word+=char;continue;}
  if(char==='"'||char==="'"){quote=char;started=true;continue;}
  if(char==='#'&&!started){while(i+1<command.length&&command[i+1]!=='\n')i++;continue;}
  if(char==='<'&&command[i+1]==='<'&&command[i+2]!=='<'){
   endWord();heredocTabs=command[i+2]==='-';i+=heredocTabs?2:1;continue;
  }
  const brace=(char==='{'||char==='}')&&!started&&(i+1===command.length||/[\s;&|()]/.test(command[i+1]));
  if(/[;&|\n()]/.test(char)||brace){
   const booleanOr=char==='|'&&command[i+1]==='|';
   endCommand(char==='|'&&!booleanOr);
   if(booleanOr)i++;
   if(char==='\n')for(const heredoc of heredocs.splice(0)){
    const lines:string[]=[];
    while(i+1<command.length){
     const start=i+1,nextLine=command.indexOf('\n',start);
     i=nextLine<0?command.length:nextLine;
     const line=command.slice(start,i);
     const text=heredoc.stripTabs?line.replace(/^\t+/,''):line;
     if(text===heredoc.delimiter)break;
     lines.push(text);
    }
    heredoc.stdin.push(lines.join('\n'));
   }
   continue;
  }
  if(/\s/.test(char)){endWord();continue;}
  word+=char;started=true;
 }
 endCommand();
 return commands;
}

function knownInputText(command:string,depth=0):boolean {
 let piped:string[]=[];
 for(const {words:[name,...args],stdin,pipe} of literalCommands(command)){
  const sources=[...piped,...stdin];
  if(knownInputInvocation(name,args,depth,sources))return true;
  // Treat literal stdin flowing into an interpreter conservatively. Never carry
  // documentation bodies into unrelated commands after a boolean/sequence.
  piped=pipe?sources:[];
 }
 return false;
}

function knownInputInvocation(program:string,args:string[],depth=0,stdin:string[]=[]):boolean {
 const executable=executableName(program);
 if(['cliclick','hooking','echo-pointer'].includes(executable))return true;
 if(executable==='axhelper')return args[0]?.toLowerCase()==='press';

 // Recognize a few transparent launcher forms; this is not a shell sandbox.
 if(depth<8&&['env','exec','command','sudo','time','!'].includes(executable)){
  let index=0;
  while(index<args.length){
   const arg=args[index];
   if(/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)){index++;continue;}
   if(arg==='--'){index++;break;}
   if(['-u','--unset','-C','--chdir'].includes(arg)&&executable==='env'){index+=2;continue;}
   if(['-u','-g'].includes(arg)&&executable==='sudo'){index+=2;continue;}
   if(arg.startsWith('-')){index++;continue;}
   break;
  }
  return index<args.length&&knownInputInvocation(args[index],args.slice(index+1),depth+1,stdin);
 }
 if(depth<8&&/^(?:ba|z|da|k)?sh$/.test(executable)){
  const codeIndex=args.findIndex(arg=>/^-[a-z]*c[a-z]*$/.test(arg));
  return (codeIndex>=0&&knownInputText(args[codeIndex+1]??'',depth+1))||stdin.some(code=>knownInputText(code,depth+1));
 }
 if(!/^(?:python(?:\d+(?:\.\d+)*)?|swift|node(?:js)?|osascript)$/.test(executable))return false;
 const code=[...args,...stdin].join(' ');
 const applescript=executable==='osascript'&&/\b(?:keystroke|key\s+code|AXPress|click|mouse\s+(?:down|up))\b/i.test(code);
 // Require source syntax, not just names in build/typecheck filenames.
 const scripted=/(?:\b(?:import\s+pyautogui|from\s+pyautogui\s+import)|pyautogui\.\w+\s*\(|CGEvent(?:(?:Post|Create)\w*)?\s*\(|sendInputEvent\s*\(|withHumanComputerControl\s*\(|\.(?:typeText|moveMouse|pressKey|click|scroll|drag|setValue)\s*\()/i.test(code);
 return applescript||scripted;
}

export function computerInputRefusal(tool:string,input:Record<string,unknown>):string|undefined {
 // Match LCU as a server-name token, including aliases/case variants. Restrict
 // this rule to the raw js action; research JS and js_reset remain available.
 const mcpName=/^mcp__(.*?)__(.*)$/i.exec(tool);
 const rawLcuJs=mcpName!==null&&mcpName[2].toLowerCase()==='js'&&/(?:^|[^a-z0-9])lcu(?:$|[^a-z0-9])/i.test(mcpName[1]);
 const rawComputerTool=/^mcp__[^]*?(?:computer_use|desktop_control|native_input|cua)__/.test(tool)||tool==='computer'||rawLcuJs;
 const bareTool=tool.split('__').at(-1)??tool;
 const shellTool=/^(?:Bash|run_terminal_command|start_process)$/.test(bareTool);
 const args=Array.isArray(input.args)?input.args.filter((arg):arg is string=>typeof arg==='string'):[];
 const processInput=bareTool==='start_process'&&typeof input.program==='string'&&knownInputInvocation(input.program,args);
 // Inspect every field independently; an empty/benign command must not mask cmd
 // or code. Keep argv intact rather than flattening it into a shell command.
 const commandInput=shellTool&&['command','code','cmd'].some(key=>{
  const value=input[key];
  return typeof value==='string'&&knownInputText(value);
 });
 if(rawComputerTool||processInput||commandInput)return 'Echo autonomous computer input must use approved LCU app tools (plus the guarded pointer-only extension). Legacy helpers, raw computer-use bridges and scripted input bypasses are not permitted. No command was executed.';
 return undefined;
}
