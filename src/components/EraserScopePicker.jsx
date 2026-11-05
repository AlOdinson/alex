import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './LanguageProvider.jsx';

export default function EraserScopePicker({ scope, onChange, onClose }) {
  const { language } = useLanguage();
  const menu = useRef(null);
  const [position, setPosition] = useState({left:12,top:70});
  useEffect(() => {
    const locate = () => {
      const anchor = document.querySelector('[data-tool="eraser"]');
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const width = 216, height = 82;
      const left = Math.max(8, Math.min(window.innerWidth-width-8, r.left+r.width/2-width/2));
      const top = r.top > height+12 ? r.top-height-8 : Math.min(window.innerHeight-height-8, r.bottom+8);
      setPosition(old => old.left===left&&old.top===top ? old : {left,top});
    };
    const outside = event => { if(!menu.current?.contains(event.target)&&!event.target?.closest?.('[data-tool="eraser"]')) onClose(); };
    const escape = event => { if(event.key==='Escape') onClose(); };
    locate(); const observer = new ResizeObserver(locate);
    const dock = document.querySelector('.board-tool-dock'); if(dock) observer.observe(dock);
    window.addEventListener('resize',locate);window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);
    return () => {observer.disconnect();window.removeEventListener('resize',locate);window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);};
  }, [onClose]);
  const labels=language==='en'?['Drawing','Media','All']:['Рисунок','Медиа','Всё'];
  return createPortal(<div ref={menu} className="eraser-scope-menu" role="radiogroup" aria-label={language==='en'?'Eraser targets':'Что стирать'} style={position} data-i18n-skip>
    {['drawing','media','all'].map((value,index)=><button type="button" key={value} role="radio" aria-checked={scope===value} className={scope===value?'selected':''} onPointerUp={event=>{if(event.pointerType==='pen')onChange(value);}} onTouchEnd={event=>{if(Array.from(event.changedTouches??[]).some(t=>t.touchType==='stylus'))onChange(value);}} onClick={()=>onChange(value)} title={labels[index]}>
      <span className="eraser-scope-circle" aria-hidden="true">{['✎','▧','✳'][index]}</span><span>{labels[index]}</span>
    </button>)}
  </div>,document.body);
}
