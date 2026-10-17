import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";
import "./index.css";
import { NesApp } from "@/components/emulator/nes-app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="flex flex-1 justify-center px-4 py-10 sm:py-16">
      <NesApp />
    </main>
  </StrictMode>,
);
