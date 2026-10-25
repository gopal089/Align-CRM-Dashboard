import { useState } from "react";
import {
  ArrowRight,
  Check,
  ShieldCheck,
  Database,
  LoaderCircle,
} from "lucide-react";
import { toast } from "sonner";
import { configured, supabase } from "../lib/client";
import { useAuth } from "../lib/auth";
import { Logo, ErrorMessage } from "./ui";
export default function AuthScreen() {
  const { session, recovery, setRecovery, refresh } = useAuth();
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [show, setShow] = useState(false);
  const onboarding = !!session && !recovery;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") || "").trim();
    const password = String(f.get("password") || "");
    try {
      if (onboarding) {
        const { error } = await supabase.rpc("create_workspace", {
          n: f.get("workspace"),
          person: f.get("name"),
        });
        if (error) throw error;
        await refresh();
        toast.success("Workspace created");
      } else if (recovery) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setRecovery(false);
        history.replaceState(null, "", "/dashboard");
        toast.success("Password updated");
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin + "/dashboard" },
        });
        if (error) throw error;
        if (!data.session)
          setSuccess("Check your email to confirm your account, then sign in.");
      } else if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + "/update-password",
        });
        if (error) throw error;
        setSuccess(
          "If this email has an account, a password reset link has been requested.",
        );
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <aside className="auth-story">
        <Logo />
        <div className="auth-story-main">
          <div className="eyebrow">A LITTLE CLARITY GOES A LONG WAY</div>
          <h1>
            Your relationships.
            <br />
            Your next chapter.
          </h1>
          <p>
            A calmer place to manage your pipeline, build meaningful
            connections, and move your business forward.
          </p>
          <div className="auth-visual" aria-hidden="true">
            <div className="visual-grid" />
            <div className="visual-card">
              <span className="tiny-label">ONE CONNECTED WORKSPACE</span>
              <div className="visual-row">
                <span className="visual-dot" />
                Build relationships
              </div>
              <div className="visual-row">
                <span className="visual-dot" />
                Find the next opportunity
              </div>
              <div className="visual-row">
                <span className="visual-dot" />
                Keep your team in sync
              </div>
              <div className="visual-bottom">
                <span className="brand-mark">
                  <i />
                  <i />
                  <i />
                </span>
                <span>A clearer way forward.</span>
              </div>
            </div>
          </div>
        </div>
        <div className="auth-foot">
          Made for thoughtful sales teams.
          <span>Less friction. More connection.</span>
        </div>
      </aside>
      <main className="auth-main">
        <div className="mobile-brand">
          <Logo />
        </div>
        <div className="auth-form">
          {!configured ? (
            <>
              <span className="setup-icon">
                <Database />
              </span>
              <h1>Connect your workspace</h1>
              <p>
                The application is ready for a Supabase connection. No business
                data has been added.
              </p>
              <ol className="setup-steps">
                <li>Create a Supabase project.</li>
                <li>
                  Apply the migration in <code>database/supabase/migrations</code>.
                </li>
                <li>
                  Copy <code>.env.example</code> to <code>.env.local</code> and
                  set your project URL and public publishable key.
                </li>
                <li>Restart the development server.</li>
              </ol>
              <div className="notice">
                <ShieldCheck size={18} />
                <span>
                  Use a public publishable key. Service-role keys must stay out
                  of the browser.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="eyebrow">
                {onboarding ? "LET’S MAKE IT YOURS" : "WELCOME TO ALIGN"}
              </div>
              <h1>
                {onboarding
                  ? "Create your workspace"
                  : recovery
                    ? "Choose a new password"
                    : mode === "signup"
                      ? "Start your next chapter"
                      : mode === "reset"
                        ? "Reset your password"
                        : "Good to see you again"}
              </h1>
              <p>
                {onboarding
                  ? "A shared home for your customers, opportunities, and team."
                  : recovery
                    ? "Use at least 10 characters to protect your account."
                    : mode === "signup"
                      ? "Create an account to organize your sales in one place."
                      : mode === "reset"
                        ? "We’ll request a secure reset link for your email."
                        : "Sign in to your workspace and pick up where you left off."}
              </p>
              <form onSubmit={submit} className="auth-fields">
                {onboarding ? (
                  <>
                    <label>
                      Your name
                      <input
                        name="name"
                        required
                        maxLength={120}
                        autoComplete="name"
                        placeholder="Your full name"
                      />
                    </label>
                    <label>
                      Workspace name
                      <input
                        name="workspace"
                        required
                        maxLength={120}
                        placeholder="e.g. Acme Studio"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    {!recovery && (
                      <label>
                        Email address
                        <input
                          name="email"
                          type="email"
                          required
                          autoComplete="email"
                          placeholder="you@company.com"
                        />
                      </label>
                    )}
                    {(recovery || mode !== "reset") && (
                      <label>
                        Password
                        <div className="password-input">
                          <input
                            name="password"
                            type={show ? "text" : "password"}
                            required
                            minLength={mode === "login" ? 1 : 10}
                            autoComplete={
                              mode === "login"
                                ? "current-password"
                                : "new-password"
                            }
                            placeholder="Enter your password"
                          />
                          <button type="button" onClick={() => setShow(!show)}>
                            {show ? "Hide" : "Show"}
                          </button>
                        </div>
                      </label>
                    )}
                  </>
                )}
                {error && <ErrorMessage error={error} />}
                {success && (
                  <div className="success" role="status">
                    <Check size={16} />
                    {success}
                  </div>
                )}
                <button className="button primary auth-submit" disabled={busy}>
                  {busy ? <LoaderCircle size={17} className="spin" /> : null}
                  {onboarding
                    ? "Create workspace"
                    : recovery
                      ? "Save password"
                      : mode === "signup"
                        ? "Create account"
                        : mode === "reset"
                          ? "Request reset link"
                          : "Sign in"}
                  <ArrowRight size={17} />
                </button>
              </form>
              {!onboarding && !recovery && (
                <>
                  <div className="auth-switch">
                    {mode === "login" ? (
                      <>
                        New to Align?{" "}
                        <button
                          onClick={() => {
                            setMode("signup");
                            setError("");
                            setSuccess("");
                          }}
                        >
                          Create an account
                        </button>
                      </>
                    ) : (
                      <>
                        Already have an account?{" "}
                        <button
                          onClick={() => {
                            setMode("login");
                            setError("");
                            setSuccess("");
                          }}
                        >
                          Sign in
                        </button>
                      </>
                    )}
                  </div>
                  {mode === "login" && (
                    <button
                      className="forgot"
                      onClick={() => {
                        setMode("reset");
                        setError("");
                      }}
                    >
                      Forgot your password?
                    </button>
                  )}
                </>
              )}
              {onboarding && (
                <button
                  className="forgot"
                  onClick={() => supabase.auth.signOut()}
                >
                  Sign out
                </button>
              )}
              <div className="auth-security">
                <ShieldCheck size={15} />
                Your workspace. Your data. Securely connected.
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
