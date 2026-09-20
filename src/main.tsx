import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App.tsx";
import { ThemeProvider } from "./lib/theme.tsx";
import { I18nProvider } from "./lib/i18n.tsx";
import { SessionProvider } from "./lib/session.tsx";
import { FormatProvider } from "./lib/format.tsx";
import { PrefsProvider } from "./lib/prefs.tsx";
import "./index.css";

const qc = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <I18nProvider>
          <SessionProvider>
            <FormatProvider>
              <PrefsProvider>
                <App />
              </PrefsProvider>
            </FormatProvider>
          </SessionProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
