// Diagnostic only: make sender and viewer use different native browser engines.
// No application source is modified or deployed.
import {readFile,writeFile} from 'node:fs/promises';
const path=new URL('./run-receiver-fullboard-diagnostic.mjs',import.meta.url);
const original=await readFile(path,'utf8');let code=original;
const once=(a,b)=>{if(code.split(a).length!==2)throw Error('Diagnostic bootstrap mismatch: '+a);code=code.replace(a,b);};
once('let browser;','let browser,hostBrowser;');
once("for(let i=0;i<100;i++)",`hostBrowser=await (engine==='webkit'?chromium:webkit).launch({headless:true,...(engine==='webkit'?{args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns','--allow-loopback-in-peer-connection']}:{})});
 for(let i=0;i<100;i++)`);
once('const context=await browser.newContext(',"const context=await (role==='host'?hostBrowser:browser).newContext(");
once("if(engine==='webkit'&&process.env.WEBKIT_LOCAL_ICE==='1')", "if((role==='viewer'?engine==='webkit':engine==='chromium')&&process.env.WEBKIT_LOCAL_ICE==='1')");
once("['outbound-rtp','inbound-rtp','media-source']", "['outbound-rtp','inbound-rtp','media-source','codec']");
once('await browser?.close();server.kill();','await browser?.close();await hostBrowser?.close();server.kill();');
await writeFile(path,code);
try{await import('./run-empty-receiver-audit.mjs');}finally{await writeFile(path,original);}
