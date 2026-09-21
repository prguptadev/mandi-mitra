import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./lib/api.ts";
import { Toaster, toastError } from "./components/Toaster.tsx";
import { ConfirmProvider } from "./components/Confirm.tsx";
import App from "./App.tsx";
import { ThemeProvider } from "./lib/theme.tsx";
import { I18nProvider } from "./lib/i18n.tsx";
import { SessionProvider } from "./lib/session.tsx";
import { FormatProvider } from "./lib/format.tsx";
import { PrefsProvider } from "./lib/prefs.tsx";
import "./index.css";

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
                  <App />
                  <Toaster />
                </ConfirmProvider>
              </PrefsProvider>
            </FormatProvider>
          </SessionProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
