import { useEffect } from "react";
import { KeyboardInput, MAX_PLAYERS, readGamepad } from "@neslink/core";
import type { EmulatorClient } from "./emulator-client";

/**
 * Feeds keyboard and gamepad state into the emulator. Keyboard maps to ports
 * by key layout; gamepads take ports in connection order. Only changes are sent.
 */
export function useControllerInput(client: EmulatorClient | null) {
  useEffect(() => {
    if (!client) return;
    const keyboard = new KeyboardInput();
    const sent = new Array<number>(MAX_PLAYERS).fill(-1);
    let raf = 0;

    const sync = () => {
      const pads = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => p !== null && p.connected);
      for (let port = 0; port < MAX_PLAYERS; port++) {
        const mask = keyboard.mask(port) | (pads[port] ? readGamepad(pads[port]) : 0);
        if (mask !== sent[port]) {
          client.setInput(port, mask);
          sent[port] = mask;
        }
      }
    };
    const poll = () => {
      sync();
      raf = requestAnimationFrame(poll);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (keyboard.handle(event.code, event.type === "keydown")) {
        event.preventDefault();
        sync();
      }
    };
    const onBlur = () => {
      keyboard.clear();
      sync();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    poll();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [client]);
}
