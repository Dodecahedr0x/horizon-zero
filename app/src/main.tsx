import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installDevSimulate } from "./replay";
import "./styles.css";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

const devMode = import.meta.env.VITE_DEV_MODE === "true";

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  if (devMode) {
    await installDevSimulate();
    const { DevApp } = await import("./devEntry");
    root.render(<StrictMode><DevApp /></StrictMode>);
    return;
  }
  const { SolanaRoot } = await import("./solanaEntry");
  root.render(<StrictMode><SolanaRoot /></StrictMode>);
}

boot();
