import { useEffect, useState } from "react";
import { X } from "lucide-react";

/* A short note at the bottom of the screen for an action that failed and has
   no message of its own on its screen: nothing fails silently. */

type Note = { id: number; text: string };
let push: ((text: string) => void) | null = null;
export const toastError = (text: string) => push?.(text);

export function Toaster() {
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    push = (text) => {
      const id = Date.now() + Math.random();
      setNotes((l) => [...l.filter((x) => x.text !== text).slice(-2), { id, text }]);
      setTimeout(() => setNotes((l) => l.filter((x) => x.id !== id)), 7000);
    };
    return () => { push = null; };
  }, []);
  if (!notes.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {notes.map((n) => (
        <div key={n.id} role="alert"
          className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-lg border border-bad/40 bg-surface px-4 py-2.5 text-[13px] text-bad shadow-pop">
          <span className="min-w-0 flex-1">{n.text}</span>
          <button type="button" aria-label="Close" className="text-faint hover:text-ink" onClick={() => setNotes((l) => l.filter((x) => x.id !== n.id))}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
