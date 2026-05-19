import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n/context";
import "./index.css";

// Build version identifier — survives minification as a string literal
// Search for "hermes-admin-build:" in deployed JS to verify deployment
declare const __BUILD_HASH__: string;
if (typeof __BUILD_HASH__ !== "undefined") {
  console.log(`hermes-admin-build:${__BUILD_HASH__}`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
);
