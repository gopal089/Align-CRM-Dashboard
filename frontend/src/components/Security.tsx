import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "../lib/auth";
import { security, logout } from "../lib/security";
import type { ActiveSession } from "../lib/security";
import { ErrorMessage, Section, Logo } from "./ui";

export function SecurityChallenge() {
  const { checkSecurity } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="auth-main">
      <div className="auth-form">
        <Logo />
        <h1>Two-step verification</h1>
        <p>
          Enter the six-digit code from your authenticator app, or one of your
          saved backup codes.
        </p>
        <form
          className="security-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await security("verify", { code });
              setCode("");
              await checkSecurity();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Authenticator or backup code
            <input
              autoFocus
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              maxLength={64}
            />
          </label>
          <ErrorMessage error={error} />
          <button className="button primary" disabled={busy}>
            Verify and continue
          </button>
        </form>
        <button
          className="button"
          disabled={busy}
          onClick={() => void logout().catch(() => {})}
        >
          Back to sign in
        </button>
        <p>
          If you lost both your authenticator and backup codes, contact the
          person who manages this Align installation. Password reset alone does
          not remove two-step verification.
        </p>
      </div>
    </main>
  );
}
export default function Security() {
  const { securityState, checkSecurity } = useAuth();
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [setup, setSetup] = useState<{
    qr_code: string;
    secret: string;
  } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState(""),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [operation, setOperation] = useState<"disable" | "codes">("disable");
  const load = async () =>
    setSessions(await security<ActiveSession[]>("sessions"));
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setCode("");
      setPassword("");
    }
  }
  return (
    <>
      <Section
        title="Two-step login"
        description="Protect your account using an authenticator app such as Google Authenticator, Microsoft Authenticator, or 1Password."
      >
        <ErrorMessage error={error} />
        <p>
          Two-step login is{" "}
          <strong>{securityState?.enabled ? "on" : "off"}</strong>.
        </p>
        {!securityState?.enabled && !setup && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void run(async () => setSetup(await security("enroll")))
            }
          >
            Set up authenticator
          </button>
        )}
        {setup && (
          <form
            className="security-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await security("enable", { code });
                setCodes(result.codes);
                setSetup(null);
                await checkSecurity();
                await load();
                toast.success("Two-step login enabled");
              });
            }}
          >
            <p>
              Scan this QR code with your authenticator. Keep the setup key
              private.
            </p>
            <img
              width={220}
              height={220}
              alt="Authenticator setup QR code"
              src={
                setup.qr_code.startsWith("data:image/")
                  ? setup.qr_code
                  : `data:image/svg+xml,${encodeURIComponent(setup.qr_code)}`
              }
            />
            <p>
              Manual setup key: <code>{setup.secret}</code>
            </p>
            <label>
              Six-digit code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </label>
            <button className="button primary" disabled={busy}>
              Verify and enable
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setSetup(null)}
            >
              Cancel setup
            </button>
          </form>
        )}
        {codes.length > 0 && (
          <div role="status">
            <h3>Save your backup codes now</h3>
            <p>
              Each code works once. These codes will not be shown again. Save
              them in your password manager.
            </p>
            <pre>{codes.join("\n")}</pre>
            <button
              className="button"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      "Align CRM backup codes — keep private\n\n" +
                        codes.join("\n"),
                    ],
                    { type: "text/plain" },
                  ),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "align-backup-codes.txt";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download codes
            </button>
            <button className="button" onClick={() => setCodes([])}>
              I saved my codes
            </button>
          </div>
        )}
        {securityState?.enabled && (
          <form
            className="security-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await security(operation, { password, code });
                setCodes(result.codes || []);
                await checkSecurity();
                await load();
                toast.success(
                  operation === "disable"
                    ? "Two-step login disabled; other Align sessions logged out"
                    : "New backup codes created; old codes no longer work",
                );
              });
            }}
          >
            <label>
              Action
              <select
                value={operation}
                onChange={(e) =>
                  setOperation(e.target.value as "disable" | "codes")
                }
              >
                <option value="disable">Turn off two-step login</option>
                <option value="codes">Replace backup codes</option>
              </select>
            </label>
            <p>
              Confirm your password and a current authenticator code (or unused
              backup code).
            </p>
            <label>
              Current password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={1024}
              />
            </label>
            <label>
              Authenticator or backup code
              <input
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                maxLength={64}
              />
            </label>
            <button className="button" disabled={busy}>
              {operation === "disable"
                ? "Confirm and turn off"
                : "Replace backup codes"}
            </button>
          </form>
        )}
      </Section>
      <Section
        title="Active Align sessions"
        description="Sessions expire after 30 minutes without activity. Logging out removes CRM access immediately; other open screens clear on their next security check."
      >
        <button
          className="button"
          disabled={busy}
          onClick={() => void run(load)}
        >
          Refresh sessions
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await security("revoke_others");
              await load();
              toast.success("Other Align sessions logged out");
            })
          }
        >
          Log out all other sessions
        </button>
        {sessions.map((s) => (
          <div key={s.id} className="security-session">
            <h3>{s.current ? "This session" : "Other session"}</h3>
            <p>{s.device}</p>
            <p>IP: {s.ip || "Unavailable"} · Location: unavailable</p>
            <p>Last active: {new Date(s.last_active).toLocaleString()}</p>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (s.current) await logout();
                  else {
                    await security("revoke", { session_id: s.id });
                    await load();
                  }
                })
              }
            >
              Log out {s.current ? "this" : "selected"} session
            </button>
          </div>
        ))}
      </Section>
    </>
  );
}
