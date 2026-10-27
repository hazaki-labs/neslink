import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { normalizeCheat, parseCheat, type Cheat } from "@neslink/core";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";

/**
 * The player's cheats for this ROM: add, switch on and off, remove. In a room
 * only the host's apply (for everyone); others see what the game runs with.
 */
export function CheatPanel({
  cheats,
  onChange,
  mode,
  roomCodes,
}: {
  cheats: Cheat[];
  onChange: (cheats: Cheat[]) => void;
  /** "solo": apply at once. "host": apply for everyone. "guest": the host's apply, not ours. */
  mode: "solo" | "host" | "guest";
  /** What the room's game runs with, when in one. */
  roomCodes: string[] | null;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);

  const add = () => {
    const normalized = normalizeCheat(code);
    if (!parseCheat(normalized)) {
      setInvalid(true);
      return;
    }
    const rest = cheats.filter((c) => c.code !== normalized);
    onChange([...rest, { code: normalized, name: name.trim(), enabled: true }]);
    setCode("");
    setName("");
    setInvalid(false);
  };

  const inputClass =
    "min-w-0 rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted-foreground">
        {mode === "solo" ? t.cheats.hintSolo : mode === "host" ? t.cheats.hintHost : t.cheats.hintGuest}
      </p>
      {roomCodes !== null && (
        <p className="text-muted-foreground">
          {roomCodes.length === 0 ? t.cheats.roomNone : t.cheats.roomActive(roomCodes.join("  "))}
        </p>
      )}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={code}
          maxLength={120}
          placeholder={t.cheats.codePlaceholder}
          aria-label={t.cheats.code}
          aria-invalid={invalid}
          className={`${inputClass} flex-[2] font-mono uppercase ${invalid ? "border-destructive" : ""}`}
          onChange={(e) => {
            setCode(e.target.value);
            setInvalid(false);
          }}
        />
        <input
          value={name}
          maxLength={40}
          placeholder={t.cheats.namePlaceholder}
          aria-label={t.cheats.name}
          className={`${inputClass} flex-1`}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={!code.trim()}>
          <Plus data-icon="inline-start" />
          {t.cheats.add}
        </Button>
      </form>
      {invalid && <p className="text-destructive">{t.cheats.invalid}</p>}
      {cheats.length === 0 ? (
        <p className="text-muted-foreground">{t.cheats.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {cheats.map((cheat) => (
            <li key={cheat.code} className="flex items-center gap-2">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={cheat.enabled}
                  onChange={(e) =>
                    onChange(cheats.map((c) => (c.code === cheat.code ? { ...c, enabled: e.target.checked } : c)))
                  }
                />
                <span className="truncate font-mono">{cheat.code}</span>
                {cheat.name && <span className="truncate text-muted-foreground">{cheat.name}</span>}
              </label>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t.cheats.remove}
                onClick={() => onChange(cheats.filter((c) => c.code !== cheat.code))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
