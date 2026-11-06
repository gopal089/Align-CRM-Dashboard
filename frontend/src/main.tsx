import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AuthProvider } from "./lib/auth";
import App from "./App";
import "./styles.css";
// Clients opening an emailed proposal never start the signed-in app.
const PublicProposal = lazy(() => import("./components/PublicProposal"));
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15000, refetchOnWindowFocus: true },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname === "/proposal" ? (
      <Suspense fallback={null}>
        <PublicProposal />
      </Suspense>
    ) : (
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <AuthProvider>
            <App />
            <Toaster position="bottom-right" richColors closeButton />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    )}
  </StrictMode>,
);
