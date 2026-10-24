import { Component, lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { Routes, Route, Navigate, Link } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { configured } from "./lib/client";
import { entities } from "./lib/model";
import AuthScreen from "./components/AuthScreen";
import Shell from "./components/Shell";
const Dashboard = lazy(() => import("./components/Dashboard"));
const Reports = lazy(() => import("./components/Reports"));
const RecordList = lazy(() => import("./components/RecordList"));
const RecordDetail = lazy(() => import("./components/RecordDetail"));
const Settings = lazy(() => import("./components/Settings"));
const Team = lazy(() => import("./components/Team"));
import { ErrorMessage, Loading, Empty } from "./components/ui";
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <h1>Something needs attention</h1>
        <ErrorMessage error={this.state.error} />
        <button className="button" onClick={() => location.reload()}>
          Reload application
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function AppRoutes() {
  const { session, org, loading, error, recovery } = useAuth();
  if (loading)
    return (
      <div className="startup-loading">
        <Loading rows={4} />
      </div>
    );
  if (error)
    return (
      <div className="fatal-error">
        <h1>Workspace connection failed</h1>
        <ErrorMessage error={error} retry={() => location.reload()} />
        <p>Check the Supabase connection and apply the project migrations.</p>
      </div>
    );
  if (!configured || !session || !org || recovery) return <AuthScreen />;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        {Object.values(entities).map((entity) => (
          <Route key={entity.key} path={entity.key}>
            <Route
              index
              element={
                entity.key === "payments" && !org.payment_tracking ? (
                  <Empty
                    title="Payment tracking is turned off"
                    description="An administrator can enable manual payments in Settings."
                    link="/settings?tab=integrations"
                  />
                ) : (
                  <RecordList key={entity.key} entity={entity} />
                )
              }
            />
            <Route
              path=":id"
              element={<RecordDetail key={entity.key} entity={entity} />}
            />
          </Route>
        ))}
        <Route path="reports/sales" element={<Reports />} />
        <Route path="team" element={<Team />} />
        <Route path="settings" element={<Settings key={org.id} />} />
        <Route path="login" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="update-password"
          element={<Navigate to="/dashboard" replace />}
        />
        <Route
          path="*"
          element={
            <div className="not-found">
              <h1>Page not found</h1>
              <p>This page may have moved.</p>
              <Link className="button primary" to="/dashboard">
                Back to overview
              </Link>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="startup-loading">
            <Loading rows={4} />
          </div>
        }
      >
        <AppRoutes />
      </Suspense>
    </ErrorBoundary>
  );
}
