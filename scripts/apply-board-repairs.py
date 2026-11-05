#!/usr/bin/env python3
"""Reproduce regressions first, then apply the reviewed source diff."""
import base64, lzma, pathlib, subprocess, sys
mode = sys.argv[1] if len(sys.argv) == 2 else ''
if mode not in ('--tests', '--apply'):
    raise SystemExit('Use --tests or --apply')
root = pathlib.Path(__file__).parent / '.board-repair-payload'
prefix = 'TESTS' if mode == '--tests' else 'SOURCE'
encoded = ''.join(p.read_text().strip() for p in sorted(root.glob(prefix + '*.txt')))
patch = lzma.decompress(base64.b64decode(encoded))
subprocess.run(['git', 'apply', '--unidiff-zero', '--check', '-'], input=patch, check=True)
subprocess.run(['git', 'apply', '--unidiff-zero', '-'], input=patch, check=True)
if mode == '--tests':
    p = pathlib.Path('scripts/test-board-repairs.mjs')
    p.write_text(p.read_text() + "\n\ntest('eraser UI cannot bypass category protection through legacy partial mode',()=>{\n const source=readFileSync(new URL('../src/components/Toolbar.jsx',import.meta.url),'utf8');\n assert.equal(source.includes(\"setEraserMode('partial')\"),false);\n});\n")
else:
    p = pathlib.Path('src/components/Toolbar.jsx')
    s = p.read_text()
    start = s.index('        {showEraserSettings && (')
    end = s.index('        {showSelectedStyleControls', start)
    s = s[:start] + s[end:]
    s = s.replace("  const showEraserSettings = tool === 'eraser';\n", '')
    p.write_text(s)
    p = pathlib.Path('scripts/test-board-repairs-browser.mjs')
    s = p.read_text()
    s = s.replace("  page.on('pageerror', error => errors.push(error.message));", "  page.on('pageerror', error => {errors.push(error.message);console.error('BROWSER ERROR',error.stack);});\n  page.on('console', message => {if(['warning','error'].includes(message.type())) console.log('BROWSER CONSOLE',message.type(),message.text());});")
    s = s.replace("} catch(error) {", """} catch(error) {
  if (page) console.log('READINESS DIAGNOSTIC',JSON.stringify(await page.evaluate(()=>{
    const el=document.querySelector('.toolbar-shell');let fiber=el?.[Object.keys(el).find(k=>k.startsWith('__reactFiber'))];
    const components=[];while(fiber){if(typeof fiber.type==='function'){const states=[];let index=0;for(let h=fiber.memoizedState;h;h=h.next,index++){const v=h.memoizedState;if(v===null||['string','number','boolean'].includes(typeof v))states.push([index,v]);}components.push({name:fiber.type.name,canEdit:fiber.memoizedProps?.canEdit,states});}fiber=fiber.return;}
    return{dataset:{...document.documentElement.dataset},components,text:document.body.innerText.slice(0,4000)};
  }).catch(e=>({error:String(e)}))));
""")
    p.write_text(s)
