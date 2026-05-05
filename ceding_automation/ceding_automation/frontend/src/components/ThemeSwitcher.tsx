import { useTheme, ThemeName } from "@/hooks/useTheme";
import { Palette, Check } from "lucide-react";
import { useState, useRef, useEffect } from "react";

const themes: { name: ThemeName; label: string; description: string; colors: [string, string, string] }[] = [
  { name: "ocean", label: "Ocean", description: "Modern & rounded", colors: ["hsl(220,40%,13%)", "hsl(187,70%,38%)", "hsl(210,20%,98%)"] },
  { name: "furnley", label: "Furnley", description: "Corporate & warm", colors: ["hsl(220,38%,15%)", "hsl(38,85%,48%)", "hsl(40,30%,97%)"] },
  { name: "forest", label: "Forest", description: "Soft & organic", colors: ["hsl(150,35%,13%)", "hsl(152,65%,36%)", "hsl(140,20%,97%)"] },
  { name: "royal", label: "Royal", description: "Bold & angular", colors: ["hsl(262,40%,14%)", "hsl(262,60%,50%)", "hsl(260,20%,97%)"] },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="Switch theme"
      >
        <Palette className="h-5 w-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-border bg-card shadow-xl z-50 p-2">
          <p className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Choose Theme</p>
          {themes.map((t) => (
            <button
              key={t.name}
              onClick={() => { setTheme(t.name); setOpen(false); }}
              className={`flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-sm transition-colors ${
                theme === t.name ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted"
              }`}
            >
              <div className="flex gap-0.5 shrink-0">
                {t.colors.map((c, i) => (
                  <div key={i} className="h-4 w-4 rounded-full border border-border/50" style={{ backgroundColor: c }} />
                ))}
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium text-sm">{t.label}</p>
                <p className="text-[10px] text-muted-foreground">{t.description}</p>
              </div>
              {theme === t.name && <Check className="h-4 w-4 text-primary shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
