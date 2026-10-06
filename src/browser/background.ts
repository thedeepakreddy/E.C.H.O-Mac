export interface BrowserPage {url: string; title: string; text: string; links: Array<{text: string; url: string}>;}
export interface HiddenPage {
  load(url: string): Promise<void>;
  read(): Promise<BrowserPage>;
  close(): void;
}
export function browserUrl(value: string): string {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)) throw new Error('Background pages require HTTP or HTTPS');
  if(url.username || url.password) throw new Error('Do not put credentials in browser URLs');
  return url.href;
}

/** Ephemeral, unauthenticated browser reads, capped at one renderer on an 8 GB Mac. */
export class BackgroundBrowser {
  private active?: {page: HiddenPage; reject(error: Error): void};
  private closed=false;
  constructor(private readonly makePage:()=>HiddenPage) {}
  async read(value: string, options: {timeoutMs?:number;signal?:AbortSignal;waitForText?:string}={}): Promise<BrowserPage> {
    if(this.closed) throw new Error('Background browser is closed');
    const url=browserUrl(value);
    if(this.active) throw new Error('Background browser is busy; wait for the current page');
    if(options.signal?.aborted) throw new Error('Browser read cancelled');
    const page=this.makePage();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let reject!:(error:Error)=>void;
    const cancellation=new Promise<never>((_,r)=>{reject=r;});
    const active={page,reject}; this.active=active;
    const abort=()=>reject(new Error('Browser read cancelled'));
    options.signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>reject(new Error('Browser page deadline exceeded')),Math.min(60_000,Math.max(1,options.timeoutMs ?? 20_000)));
    try {
      const data=await Promise.race([(async()=>{
        await page.load(url);
        let result=await page.read();
        while(options.waitForText && !result.text.includes(options.waitForText)) {
          await Promise.race([new Promise(resolve=>setTimeout(resolve,100)),cancellation]);
          result=await page.read();
        }
        return result;
      })(),cancellation]);
      browserUrl(data.url);
      return {url:data.url,title:String(data.title).slice(0,300),text:String(data.text).slice(0,24000),links:data.links.slice(0,80).map(l=>({text:String(l.text).slice(0,160),url:String(l.url).slice(0,2000)}))};
    } finally {
      clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
      page.close(); if(this.active===active) this.active=undefined;
    }
  }
  close(): void {this.closed=true;this.active?.reject(new Error('Background browser closed'));}
}

export async function createBackgroundBrowser(): Promise<BackgroundBrowser> {
  const {BrowserWindow}=await import('electron');
  return new BackgroundBrowser(()=>{
    const window=new BrowserWindow({show:false,width:1280,height:800,skipTaskbar:true,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webgl:false,backgroundThrottling:true,
        partition:`echo-page-${crypto.randomUUID()}`}});
    const contents=window.webContents, session=contents.session;
    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(()=>({action:'deny'}));
    session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    session.setPermissionCheckHandler(()=>false);
    session.on('will-download',event=>event.preventDefault());
    session.webRequest.onBeforeRequest((details,callback)=>{
      const protocol=new URL(details.url).protocol;
      callback({cancel:!['http:','https:','data:','blob:'].includes(protocol)});
    });
    const navigation=(event:Electron.Event,url:string)=>{try{browserUrl(url);}catch{event.preventDefault();}};
    contents.on('will-navigate',navigation);contents.on('will-redirect',navigation);
    return {
      load:async url=>{await window.loadURL(url);},
      read:()=>contents.executeJavaScript(`(() => ({url:location.href,title:document.title,
        text:(document.body?.innerText || '').slice(0,24000),
        links:Array.from(document.querySelectorAll('a[href]')).slice(0,80).map(a=>({text:(a.innerText||'').slice(0,160),url:a.href}))}))()`,true),
      close:()=>{if(!window.isDestroyed()) window.destroy();},
    };
  });
}
let browser:Promise<BackgroundBrowser>|undefined;
export async function readBrowserPage(url: string, signal?:AbortSignal, timeoutMs?:number,waitForText?:string): Promise<BrowserPage> {
  browser ??= createBackgroundBrowser();
  return (await browser).read(url,{signal,timeoutMs,waitForText});
}
export async function closeBackgroundBrowser(): Promise<void> {if(browser) (await browser).close();}
