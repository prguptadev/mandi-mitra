import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./lib/api.ts";
import { Toaster, toastError } from "./components/Toaster.tsx";
import { ConfirmProvider } from "./components/Confirm.tsx";
import { FinancialYearProvider } from "./lib/fy.tsx";
import App from "./App.tsx";
import { ThemeProvider } from "./lib/theme.tsx";
import { I18nProvider } from "./lib/i18n.tsx";
import { SessionProvider } from "./lib/session.tsx";
import { FormatProvider } from "./lib/format.tsx";
import { PrefsProvider } from "./lib/prefs.tsx";
import "./index.css";

/* The figures' and Hindi typefaces still come from Google when the internet is
   there. Asked for from here, not from the page's head, so a slow or missing
   connection never holds the first paint: until they arrive (or without the
   internet) the computer's own faces show, as they always did offline. */
try {
  const fonts = document.createElement("link");
  fonts.rel = "stylesheet";
  fonts.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;600;700&family=Roboto+Mono:wght@400;500;600&display=swap";
  document.head.appendChild(fonts);
} catch { /* no fonts from outside: the computer's own are used */ }

const qc = new QueryClient({
  // an action whose screen has no error message of its own still says what went wrong
  mutationCache: new MutationCache({
    onError: (e, _vars, _ctx, mutation) => {
      if (mutation.options.onError) return;
      toastError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    },
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false, staleTime: 10_000,
      // a refusal (no permission, not found) will not change by asking again
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
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
                <ConfirmProvider>
                  <FinancialYearProvider>
                    <App />
                    <Toaster />
                  </FinancialYearProvider>
                </ConfirmProvider>
              </PrefsProvider>
            </FormatProvider>
          </SessionProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
