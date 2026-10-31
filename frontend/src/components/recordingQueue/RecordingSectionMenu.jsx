import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/useT.js";

/** The same indented section menu is used in settings and the recording dialog. */
export default function RecordingSectionMenu({ sections, activeSection, onSelect, className = "", ariaLabel }) {
  const t = useT();
  return <div aria-label={ariaLabel} className={`flex flex-col border-l border-cs2-border-subtle ${className}`}>
    {sections.map(section => <button key={section.id} type="button"
      onClick={() => onSelect(section.id)} aria-current={activeSection === section.id ? "true" : undefined}
      className={`-ml-px border-l py-[5px] pl-3.5 pr-2 text-left text-xs transition-colors hover:text-cs2-text-primary ${activeSection === section.id
        ? "border-cs2-accent text-cs2-text-primary" : "border-transparent text-cs2-text-muted"}`}>
      {t(section.labelKey)}
    </button>)}
  </div>;
}

/** Anchor navigation only scrolls its own pane, including at the bottom. */
export function useRecordingSectionNavigation(sections, open) {
  const scrollRef = useRef(null);
  const jumpRef = useRef(null);
  const [activeSection, setActiveSection] = useState(sections[0].id);
  const jumpToSection = useCallback(id => {
    setActiveSection(id);
    const pane = scrollRef.current;
    const section = pane?.querySelector(`#${id}`);
    if (!section) return;
    const top = Math.max(0, Math.min(pane.scrollTop + section.getBoundingClientRect().top
      - pane.getBoundingClientRect().top - 16, pane.scrollHeight - pane.clientHeight));
    jumpRef.current = Date.now() + 1500;
    if (pane.scrollTo) pane.scrollTo({ top, behavior: "smooth" });
    else pane.scrollTop = top;
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    setActiveSection(sections[0].id);
    jumpRef.current = null;
    const pane = scrollRef.current;
    if (!pane) return undefined;
    pane.scrollTop = 0;
    let frame = 0;
    const sync = () => {
      frame = 0;
      if (jumpRef.current && Date.now() < jumpRef.current) return;
      const box = pane.getBoundingClientRect();
      const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
      let current = sections[0].id;
      for (const section of sections) {
        const element = pane.querySelector(`#${section.id}`);
        if (!element) continue;
        const top = element.getBoundingClientRect().top;
        if (top <= box.top + 96 || (atBottom && top < box.bottom)) current = section.id;
      }
      setActiveSection(current);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const endJump = () => { jumpRef.current = null; };
    const events = ["scrollend", "wheel", "touchstart", "pointerdown", "keydown"];
    pane.addEventListener("scroll", onScroll, { passive: true });
    events.forEach(event => pane.addEventListener(event, endJump, { passive: true }));
    return () => {
      pane.removeEventListener("scroll", onScroll);
      events.forEach(event => pane.removeEventListener(event, endJump));
      if (frame) cancelAnimationFrame(frame);
    };
  }, [open, sections]);

  return { scrollRef, activeSection, jumpToSection };
}
