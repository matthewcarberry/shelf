import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/rethink-sans/400.css";
import "@fontsource/rethink-sans/600.css";
import "@fontsource/rethink-sans/700.css";
import "@fontsource/rethink-sans/800.css";
import { App } from "./App";
import { registerOfflineSupport } from "./offline";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerOfflineSupport().catch(() => undefined);
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
