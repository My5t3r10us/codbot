import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import * as queue from "./queue";
import * as runs from "./runs";
import { App } from "./app/App";
import { applyTheme } from "./app/theme";

await applyTheme();
await runs.init();
await queue.init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
