import type { ReactNode } from "react";
import { Logo } from "./ui";
import { titleCase } from "../lib/model";
import { date, money } from "../lib/utils";
import {
  placeholderFiller,
  proposalFields,
  type ProposalContent,
} from "../lib/proposal";

// One layout for the in-app preview, the printed PDF and the client's page,
// so what a client opens always looks like what the team previewed.
export default function ProposalDocument({
  content,
  footer,
  children,
}: {
  content: ProposalContent;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const fill = placeholderFiller(content, money);
  const { org, pitch } = content;
  return (
    <article className="proposal print-content">
      <div className="proposal-header">
        <Logo />
        <div>
          <strong>{org.name}</strong>
          <p>{org.website}</p>
        </div>
      </div>
      <span className="eyebrow">A PROPOSAL FOR WHAT’S NEXT</span>
      <h1>{pitch.name}</h1>
      <p className="proposal-date">
        Prepared {date(pitch.created_at, org.timezone)}
        {content.sender ? ` · ${content.sender}` : ""}
      </p>
      {proposalFields
        .filter((key) => pitch[key])
        .map((key) => (
          <section key={key}>
            <h2>{titleCase(key)}</h2>
            <p>{pitch[key]}</p>
          </section>
        ))}
      {children}
      {content.sections.map((section, i) => (
        <section key={i}>
          <h2>{fill(section.title)}</h2>
          <p>{fill(section.content)}</p>
        </section>
      ))}
      <div className="proposal-total">
        <span>Proposed investment</span>
        <strong>{money(Number(pitch.amount) || 0, org.currency)}</strong>
      </div>
      {pitch.terms && (
        <section>
          <h2>Terms & next steps</h2>
          <p>{pitch.terms}</p>
        </section>
      )}
      <footer>{footer ?? `Prepared by ${org.name} · ${org.currency}`}</footer>
    </article>
  );
}
