import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "weui/dist/style/weui.css";
import "./styles/index.css";
import { App } from "./app/App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
