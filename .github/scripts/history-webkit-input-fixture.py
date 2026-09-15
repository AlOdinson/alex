from pathlib import Path
p=Path('scripts/test-history-device-matrix-e2e.mjs')
s=p.read_text()
start=s.index('    // WebKit pen events are injected')
end=s.index('\n  }\n}\nasync function selectLast',start)
s=s[:start]+'''    // Scripted finger TouchEvents exercise WebKit's actual free-drawing path
    // for both mobile profiles. Chromium covers native CDP pen input separately.
    // Pointer-only and stylus-only injection are not faithful Apple Pencil
    // emulation here; those probes did not produce a stroke and are NOT PASS.
    await page.locator('canvas.upper-canvas').evaluate((canvas, { a, b }) => {
      const send = (type, x, y) => {
        const touch = { identifier: 71, target: canvas, clientX:x, clientY:y,
          pageX:x+scrollX, pageY:y+scrollY, screenX:x, screenY:y,
          radiusX:1, radiusY:1, rotationAngle:0, force:0.5, touchType:'direct' };
        const active = type === 'touchend' ? [] : [touch];
        const event = new Event(type, { bubbles:true, cancelable:true });
        Object.defineProperties(event, {
          touches:{value:active}, targetTouches:{value:active}, changedTouches:{value:[touch]},
        });
        canvas.dispatchEvent(event);
      };
      send('touchstart',a.x,a.y);
      for(let i=1;i<=8;i++) send('touchmove',a.x+(b.x-a.x)*i/8,a.y+(b.y-a.y)*i/8);
      send('touchend',b.x,b.y);
    }, { a, b });'''+s[end:]
p.write_text(s)
