import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
const db = new PGlite();
const owner = "20000000-0000-0000-0000-000000000001",
  rep = "20000000-0000-0000-0000-000000000002",
  outsider = "20000000-0000-0000-0000-000000000003";
let org: string, other: string, pitch: string;
async function user(id: string) {
  await db.exec(
    `reset role; insert into auth.sessions(id,user_id) values('${id}','${id}') on conflict do nothing; insert into private.security_sessions(session_id,user_id) values('${id}','${id}') on conflict do nothing; select set_config('request.jwt.claims','{"session_id":"${id}"}',false)`,
  );
  await db.exec(
    `reset role; set role authenticated; select set_config('request.jwt.claim.sub','${id}',false)`,
  );
}
// The public link is served by the server, never by a signed-in user.
async function server() {
  await db.exec(
    "reset role; select set_config('request.jwt.claim.sub','',false)",
  );
}
async function rows(sql: string, params: any[] = []) {
  return (await db.query<any>(sql, params)).rows;
}
const hash = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
async function begin(link = hash(), as = owner, target = pitch) {
  await user(as);
  const [r] = await rows(
    "select public.proposal_begin($1,'client@example.com','Client','Proposal: Website','Hello there',$2) v",
    [target, link],
  );
  return { send: r.v, link };
}
async function sent() {
  const b = await begin();
  await rows("select public.proposal_finish($1,true,'re_test')", [b.send.id]);
  return b;
}
async function open(link: string, viewer: string | null = null) {
  await server();
  return (
    await rows("select public.proposal_open($1,'Desktop',$2) v", [
      link,
      viewer,
    ])
  )[0].v;
}
async function status() {
  await server();
  return (await rows("select status from public.pitches where id=$1", [pitch]))[0]
    .status;
}
beforeAll(async () => {
  await db.exec(
    `create role service_role nologin bypassrls;create role supabase_auth_admin nologin;create role anon nologin;create role authenticated nologin;create schema auth;create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,user_agent text,ip inet);create table auth.users(id uuid primary key,email text);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;insert into auth.users values('${owner}','owner@test.invalid'),('${rep}','rep@test.invalid'),('${outsider}','outsider@test.invalid');`,
  );
  for (const migration of readdirSync("database/supabase/migrations")
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(
      readFileSync(`database/supabase/migrations/${migration}`, "utf8"),
    );
  await user(owner);
  org = (
    await rows("select public.create_workspace('TEST ONLY Proposals','Owner Name') id")
  )[0].id;
  await rows(
    "select public.manage_member($1,'rep@test.invalid','Sales Representative')",
    [org],
  );
  const contact = (
    await rows(
      "insert into public.contacts(org_id,owner_id,name) values($1,$2,'Acme Buyer') returning id",
      [org, owner],
    )
  )[0].id;
  pitch = (
    await rows(
      "insert into public.pitches(org_id,owner_id,name,contact_id,objective,amount) values($1,$2,'Website rebuild',$3,'Grow sales',5000) returning id",
      [org, owner, contact],
    )
  )[0].id;
  await rows(
    "insert into public.pitch_sections(org_id,pitch_id,title,content,position) values($1,$2,'Timeline','Six weeks',0)",
    [org, pitch],
  );
  await user(outsider);
  other = (
    await rows("select public.create_workspace('TEST ONLY Other','Outsider') id")
  )[0].id;
}, 30000);
afterAll(async () => await db.close());

describe("proposal emails and view tracking", () => {
  it("snapshots the proposal and keeps only a hash of the link", async () => {
    const { send, link } = await begin();
    expect(send.reply_to).toBe("owner@test.invalid");
    await server();
    const [s] = await rows("select * from public.proposal_sends where id=$1", [
      send.id,
    ]);
    expect(s.status).toBe("sending");
    expect(s.content.customer).toBe("Acme Buyer");
    expect(s.content.pitch.objective).toBe("Grow sales");
    expect(s.content.sections).toEqual([
      { title: "Timeline", content: "Six weeks" },
    ]);
    expect(
      (await rows("select token_hash from private.proposal_links where send_id=$1", [send.id]))[0]
        .token_hash,
    ).toBe(link);
  });
  it("only the owner or a manager can send, and only inside the workspace", async () => {
    await expect(begin(hash(), rep)).rejects.toThrow(
      "Only the proposal owner or a manager",
    );
    await expect(begin(hash(), outsider)).rejects.toThrow("Proposal not found");
  });
  it("rejects bad input before anything is stored", async () => {
    await user(owner);
    await expect(
      rows(
        "select public.proposal_begin($1,'not-an-email','','Subject','',$2)",
        [pitch, hash()],
      ),
    ).rejects.toThrow("valid recipient email");
    await expect(
      rows(
        "select public.proposal_begin($1,'a@example.com','',E'Two\\nlines','',$2)",
        [pitch, hash()],
      ),
    ).rejects.toThrow("one line");
    await expect(
      rows(
        "select public.proposal_begin($1,'a@example.com','','Subject','','short')",
        [pitch],
      ),
    ).rejects.toThrow("Invalid proposal link");
  });
  it("marks the pitch Sent once the email provider accepts it, and only once", async () => {
    const { send } = await begin();
    await rows("select public.proposal_finish($1,true,'re_1')", [send.id]);
    expect(await status()).toBe("Sent");
    await user(owner);
    await expect(
      rows("select public.proposal_finish($1,true,'re_2')", [send.id]),
    ).rejects.toThrow("Unknown proposal send");
  });
  it("records a failed delivery without changing the pitch", async () => {
    const { send, link } = await begin();
    await rows(
      "select public.proposal_finish($1,false,null,'Testing emails only to your own address')",
      [send.id],
    );
    await server();
    const [s] = await rows(
      "select status,error from public.proposal_sends where id=$1",
      [send.id],
    );
    expect(s).toEqual({
      status: "failed",
      error: "Testing emails only to your own address",
    });
    await expect(open(link)).rejects.toThrow("not valid");
  });
  it("counts a client visit, moves Sent to Viewed, and credits the sender in history", async () => {
    await user(owner);
    await rows("update public.pitches set status='Draft' where id=$1", [pitch]);
    const { send, link } = await sent();
    expect(await status()).toBe("Sent");
    const first = await open(link);
    expect(first.internal).toBe(false);
    expect(first.content.pitch.name).toBe("Website rebuild");
    expect(await status()).toBe("Viewed");
    await server();
    const [h] = await rows(
      "select changed_by from public.pitch_status_history where pitch_id=$1 and to_status='Viewed' order by changed_at desc limit 1",
      [pitch],
    );
    expect(h.changed_by).toBe(owner);
    // A reload inside 30 minutes is the same visit.
    await open(link);
    const [s] = await rows(
      "select view_count,first_viewed_at from public.proposal_sends where id=$1",
      [send.id],
    );
    expect(s.view_count).toBe(1);
    expect(s.first_viewed_at).not.toBeNull();
    expect(
      await rows("select device from public.proposal_views where send_id=$1", [
        send.id,
      ]),
    ).toEqual([{ device: "Desktop" }]);
    await user(owner);
    const [summary] = await rows("select public.crm_summary($1) s", [org]);
    expect(summary.s.pitchViewed).toBe(1);
    expect(summary.s.pitchSent).toBe(0);
    expect(summary.s.leads).toBe(0);
  });
  it("does not count a workspace member checking their own link", async () => {
    await user(owner);
    await rows("update public.pitches set status='Draft' where id=$1", [pitch]);
    const { send, link } = await sent();
    const result = await open(link, rep);
    expect(result.internal).toBe(true);
    expect(await status()).toBe("Sent");
    expect(
      (await rows("select view_count from public.proposal_sends where id=$1", [send.id]))[0]
        .view_count,
    ).toBe(0);
    // Someone from another workspace is treated as an outside visitor.
    expect((await open(link, outsider)).internal).toBe(false);
  });
  it("refuses unknown, withdrawn and expired links", async () => {
    await expect(open(hash())).rejects.toThrow("not valid");
    await expect(open("not-a-hash")).rejects.toThrow("not valid");
    const withdrawn = await sent();
    await user(rep);
    await expect(
      rows("select public.proposal_revoke($1)", [withdrawn.send.id]),
    ).rejects.toThrow("Unknown proposal send");
    await user(owner);
    await rows("select public.proposal_revoke($1)", [withdrawn.send.id]);
    await expect(open(withdrawn.link)).rejects.toThrow("withdrawn");
    const old = await sent();
    await server();
    await rows(
      "update public.proposal_sends set expires_at=now()-interval '1 minute' where id=$1",
      [old.send.id],
    );
    await expect(open(old.link)).rejects.toThrow("expired");
  });
  it("keeps Viewed for tracking only, while viewed pitches stay editable", async () => {
    await user(owner);
    await rows("update public.pitches set status='Sent' where id=$1", [pitch]);
    await expect(
      rows("update public.pitches set status='Viewed' where id=$1", [pitch]),
    ).rejects.toThrow("set automatically");
    const { link } = await sent();
    await open(link);
    expect(await status()).toBe("Viewed");
    await user(owner);
    await rows("update public.pitches set name='Website rebuild v2' where id=$1", [
      pitch,
    ]);
    await rows("update public.pitches set status='Accepted' where id=$1", [pitch]);
    await expect(begin()).rejects.toThrow("closed");
    await user(owner);
    await rows(
      "update public.pitches set status='Draft',name='Website rebuild' where id=$1",
      [pitch],
    );
  });
  it("lets members read history but never write it, and hides links from everyone", async () => {
    await user(rep);
    expect(
      (await rows("select count(*)::int n from public.proposal_sends where org_id=$1", [org]))[0].n,
    ).toBeGreaterThan(0);
    await expect(
      rows(
        "insert into public.proposal_sends(org_id,pitch_id,sent_by,recipient_email,subject,content) values($1,$2,$3,'x@example.com','x','{}')",
        [org, pitch, rep],
      ),
    ).rejects.toThrow();
    await expect(
      rows("update public.proposal_sends set view_count=99"),
    ).rejects.toThrow();
    await expect(rows("select * from private.proposal_links")).rejects.toThrow();
    await expect(
      rows("select public.proposal_open($1)", [hash()]),
    ).rejects.toThrow("permission denied");
    await user(outsider);
    expect(
      await rows("select * from public.proposal_sends where org_id=$1", [org]),
    ).toHaveLength(0);
    expect(
      await rows("select * from public.proposal_views where org_id=$1", [org]),
    ).toHaveLength(0);
    void other;
  });
});
