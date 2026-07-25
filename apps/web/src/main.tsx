import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { I18nProvider } from "./i18n";
import "./index.css";
import { applyThemePreference, initialThemePreference } from "./lib/preferences";

applyThemePreference(initialThemePreference());

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
