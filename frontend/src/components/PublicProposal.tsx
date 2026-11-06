import { useEffect, useRef, useState } from "react";
import ProposalDocument from "./ProposalDocument";
import { Logo } from "./ui";
import { date } from "../lib/utils";
import { proposalRequest, type OpenedProposal } from "../lib/proposal";

// The page a client lands on from the email. It runs outside the signed-in
// app: the link itself is the permission, and the token after "#" is never
// sent to the web server.
export default function PublicProposal() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: OpenedProposal }
  >({ kind: "loading" });
  const started = useRef(false);
  useEffect(() => {
    // React may run effects twice in development; one visit, one request.
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    if (!token) {
      setState({ kind: "error", message: "This proposal link is incomplete. Open it again from the email." });
      return;
    }
    proposalRequest<OpenedProposal>("open", { token })
      .then((data) => {
        setState({ kind: "ready", data });
        document.title = `${data.content.pitch.name} · ${data.content.org.name}`;
      })
      .catch((e: Error) => setState({ kind: "error", message: e.message }));
  }, []);

  return (
    <div className="public-proposal">
      {state.kind === "loading" && (
        <div className="public-proposal-notice">
          <Logo />
          <p>Opening proposal…</p>
        </div>
      )}
      {state.kind === "error" && (
        <div className="public-proposal-notice">
          <Logo />
          <h1>We couldn’t open this proposal</h1>
          <p>{state.message}</p>
          <p className="muted">
            If you think this is a mistake, reply to the email you received.
          </p>
        </div>
      )}
      {state.kind === "ready" && (
        <>
          {state.data.internal && (
            <p className="public-proposal-banner">
              You’re signed in to this workspace, so this visit is not counted
              as a client view. Open the link in a private window to see what
              the client sees.
            </p>
          )}
          <ProposalDocument
            content={state.data.content}
            footer={
              <>
                Sent {date(state.data.sent_at, state.data.content.org.timezone)}{" "}
                by {state.data.content.org.name}. This private link works until{" "}
                {date(state.data.expires_at, state.data.content.org.timezone)}.
                {state.data.reply_to && (
                  <>
                    {" "}
                    Questions?{" "}
                    <a href={`mailto:${state.data.reply_to}`}>
                      Email {state.data.content.sender || "the sender"}
                    </a>
                    .
                  </>
                )}
              </>
            }
          />
        </>
      )}
    </div>
  );
}
