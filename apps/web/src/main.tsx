import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary language={document.documentElement.lang || navigator.language}>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
