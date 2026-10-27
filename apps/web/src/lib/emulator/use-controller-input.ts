import { useCallback, useEffect, useRef } from "react";
import {
  IDLE_CONTROLLER, KeyboardInput, MAX_PLAYERS, mergeControllers, readGamepad, type ControllerState,
} from "@neslink/core";
import type { EmulatorClient } from "./emulator-client";

/**
 * Feeds keyboard, gamepad and on-screen controller state into the emulator.
 * Keyboard and touch drive port 1 (keyboard by key layout); gamepads take
 * ports in connection order. Only changes are sent. Returns the setter the
 * on-screen controller reports to.
 */
export function useControllerInput(client: EmulatorClient | null): (touch: ControllerState) => void {
  const touch = useRef<ControllerState>(IDLE_CONTROLLER);
  const syncNow = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!client) return;
    const keyboard = new KeyboardInput();
    const sent = Array.from({ length: MAX_PLAYERS }, () => ({ held: -1, turbo: -1 }));
    let raf = 0;

    const sync = () => {
      const pads = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => p !== null && p.connected);
      for (let port = 0; port < MAX_PLAYERS; port++) {
        let state = mergeControllers(keyboard.state(port), pads[port] ? readGamepad(pads[port]) : IDLE_CONTROLLER);
        if (port === 0) state = mergeControllers(state, touch.current);
        if (state.held !== sent[port].held || state.turbo !== sent[port].turbo) {
          client.setInput(port, state);
          sent[port] = state;
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
    syncNow.current = sync;
    poll();
    return () => {
      syncNow.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [client]);

  return useCallback((state: ControllerState) => {
    touch.current = state;
    syncNow.current?.();
  }, []);
}
