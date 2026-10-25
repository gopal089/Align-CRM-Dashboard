import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  UsersRound,
  ContactRound,
  Building2,
  PanelsTopLeft,
  Presentation,
  ChartNoAxesCombined,
  Activity,
  ListTodo,
  Users,
  Settings2,
  FileText,
  Target,
  CreditCard,
} from "lucide-react";
export type Row = {
  id: string;
  org_id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  [key: string]: any;
};
export type Field = {
  key: string;
  label: string;
  type?:
    | "text"
    | "email"
    | "number"
    | "date"
    | "datetime-local"
    | "textarea"
    | "select"
    | "relation"
    | "tags"
    | "checkbox";
  required?: boolean;
  options?: string[];
  relation?: string;
  min?: number;
  max?: number;
  hint?: string;
};
export type Entity = {
  key: string;
  table: string;
  title: string;
  singular: string;
  description: string;
  icon: LucideIcon;
  columns: string[];
  fields: Field[];
  status?: string[];
  search: string[];
};
const owner: Field = {
  key: "owner_id",
  label: "Owner",
  type: "relation",
  relation: "memberships",
  required: true,
};
const notes: Field = { key: "notes", label: "Notes", type: "textarea" };
const company: Field = {
  key: "company_id",
  label: "Company",
  type: "relation",
  relation: "companies",
};
const contact: Field = {
  key: "contact_id",
  label: "Contact",
  type: "relation",
  relation: "contacts",
};
const lead: Field = {
  key: "lead_id",
  label: "Lead",
  type: "relation",
  relation: "leads",
};
const deal: Field = {
  key: "deal_id",
  label: "Deal",
  type: "relation",
  relation: "deals",
};
const name: Field = { key: "name", label: "Name", required: true };
const amount: Field = {
  key: "amount",
  label: "Amount",
  type: "number",
  required: true,
  min: 0,
};
const priority: Field = {
  key: "priority",
  label: "Priority",
  type: "select",
  options: ["Low", "Medium", "High"],
  required: true,
};
export const entities: Record<string, Entity> = {
  leads: {
    key: "leads",
    table: "leads",
    title: "Leads",
    singular: "lead",
    description: "Turn new conversations into lasting relationships.",
    icon: UsersRound,
    columns: [
      "name",
      "company_name",
      "status",
      "source",
      "priority",
      "owner_id",
      "created_at",
    ],
    search: ["name", "company_name", "email", "phone"],
    status: ["New", "Contacted", "Qualified", "Converted", "Lost"],
    fields: [
      name,
      { key: "company_name", label: "Company name" },
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Phone" },
      {
        key: "source",
        label: "Source",
        type: "select",
        options: [],
        required: true,
      },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["New", "Contacted", "Qualified", "Lost"],
        required: true,
      },
      priority,
      owner,
      notes,
    ],
  },
  contacts: {
    key: "contacts",
    table: "contacts",
    title: "Contacts",
    singular: "contact",
    description: "The people behind every opportunity.",
    icon: ContactRound,
    columns: [
      "name",
      "email",
      "company_id",
      "job_title",
      "owner_id",
      "created_at",
    ],
    search: ["name", "email", "phone"],
    fields: [
      name,
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Phone" },
      { key: "job_title", label: "Job title" },
      company,
      owner,
      {
        key: "tags",
        label: "Tags",
        type: "tags",
        hint: "Separate tags with commas.",
      },
      notes,
    ],
  },
  companies: {
    key: "companies",
    table: "companies",
    title: "Companies",
    singular: "company",
    description: "A shared view of your customer organizations.",
    icon: Building2,
    columns: ["name", "industry", "size", "location", "owner_id", "created_at"],
    search: ["name", "website", "industry", "location"],
    fields: [
      name,
      {
        key: "website",
        label: "Website",
        hint: "Include https:// for clickable links.",
      },
      { key: "industry", label: "Industry" },
      {
        key: "size",
        label: "Company size",
        type: "select",
        options: ["1–10", "11–50", "51–200", "201–1000", "1000+"],
      },
      { key: "location", label: "Location" },
      owner,
      notes,
    ],
  },
  deals: {
    key: "deals",
    table: "deals",
    title: "Deals & Pipeline",
    singular: "deal",
    description: "Every opportunity. A clear next step.",
    icon: PanelsTopLeft,
    columns: [
      "name",
      "company_id",
      "amount",
      "stage",
      "probability",
      "expected_close_date",
      "owner_id",
    ],
    search: ["name", "notes"],
    fields: [
      name,
      company,
      contact,
      lead,
      amount,
      {
        key: "stage",
        label: "Pipeline stage",
        type: "select",
        options: [],
        required: true,
      },
      {
        key: "probability",
        label: "Probability (%)",
        type: "number",
        min: 0,
        max: 100,
        required: true,
      },
      {
        key: "expected_close_date",
        label: "Expected close date",
        type: "date",
      },
      owner,
      notes,
    ],
  },
  "pitch-desk": {
    key: "pitch-desk",
    table: "pitches",
    title: "Pitch Desk",
    singular: "pitch",
    description: "Thoughtful proposals. Stronger partnerships.",
    icon: Presentation,
    columns: [
      "name",
      "company_id",
      "status",
      "amount",
      "owner_id",
      "created_at",
    ],
    search: ["name", "objective"],
    status: [
      "Draft",
      "Ready to Send",
      "Sent",
      "Accepted",
      "Rejected",
      "Expired",
    ],
    fields: [
      name,
      lead,
      contact,
      company,
      deal,
      {
        key: "template_id",
        label: "Start with a template",
        type: "relation",
        relation: "pitch_templates",
      },
      { key: "objective", label: "Objective", type: "textarea" },
      { key: "problem", label: "Problem statement", type: "textarea" },
      { key: "solution", label: "Proposed solution", type: "textarea" },
      { key: "scope", label: "Scope & deliverables", type: "textarea" },
      { key: "pricing", label: "Pricing details", type: "textarea" },
      amount,
      { key: "terms", label: "Terms", type: "textarea" },
      {
        key: "status",
        label: "Status",
        type: "select",
        options: [
          "Draft",
          "Ready to Send",
          "Sent",
          "Accepted",
          "Rejected",
          "Expired",
        ],
        required: true,
      },
      owner,
    ],
  },
  activities: {
    key: "activities",
    table: "activities",
    title: "Activities",
    singular: "activity",
    description: "A clear history of the work that moves things forward.",
    icon: Activity,
    columns: ["name", "type", "description", "owner_id", "occurred_at"],
    search: ["name", "description"],
    fields: [
      name,
      {
        key: "type",
        label: "Activity type",
        type: "select",
        options: ["Call", "Meeting", "Email", "Note", "Follow-up"],
        required: true,
      },
      { key: "description", label: "Details", type: "textarea" },
      {
        key: "occurred_at",
        label: "Occurred at",
        type: "datetime-local",
        required: true,
      },
      lead,
      contact,
      company,
      deal,
      owner,
    ],
  },
  tasks: {
    key: "tasks",
    table: "tasks",
    title: "Tasks",
    singular: "task",
    description: "Make room for the follow-ups that matter.",
    icon: ListTodo,
    columns: ["name", "status", "priority", "due_date", "owner_id"],
    search: ["name", "description"],
    status: ["Open", "In progress", "Completed"],
    fields: [
      name,
      { key: "description", label: "Description", type: "textarea" },
      { key: "due_date", label: "Due date", type: "date", required: true },
      priority,
      {
        key: "status",
        label: "Status",
        type: "select",
        options: ["Open", "In progress", "Completed"],
        required: true,
      },
      owner,
      lead,
      contact,
      company,
      deal,
    ],
  },
  templates: {
    key: "templates",
    table: "pitch_templates",
    title: "Pitch templates",
    singular: "template",
    description: "Reusable starting points for your next proposal.",
    icon: FileText,
    columns: ["name", "owner_id", "created_at"],
    search: ["name"],
    fields: [
      name,
      { key: "terms", label: "Default terms", type: "textarea" },
      owner,
    ],
  },
  targets: {
    key: "targets",
    table: "sales_targets",
    title: "Sales targets",
    singular: "target",
    description: "Give your team a clear, measurable goal.",
    icon: Target,
    columns: [
      "name",
      "amount",
      "period_start",
      "period_end",
      "team_target",
      "owner_id",
    ],
    search: ["name"],
    fields: [
      name,
      { ...amount, min: 0.01 },
      {
        key: "period_start",
        label: "Period start",
        type: "date",
        required: true,
      },
      { key: "period_end", label: "Period end", type: "date", required: true },
      {
        key: "team_target",
        label: "Team target",
        type: "checkbox",
        hint: "Leave off for an individual target.",
      },
      owner,
    ],
  },
  payments: {
    key: "payments",
    table: "payments",
    title: "Payments",
    singular: "payment",
    description:
      "Manually recorded payments, separate from closed-won deal value.",
    icon: CreditCard,
    columns: ["name", "deal_id", "amount", "paid_at", "reference"],
    search: ["name", "reference"],
    fields: [
      name,
      { ...deal, required: true },
      { ...amount, min: 0.01 },
      {
        key: "paid_at",
        label: "Received at",
        type: "datetime-local",
        required: true,
      },
      { key: "reference", label: "Payment reference" },
      owner,
    ],
  },
};
export const nav = [
  { path: "/dashboard", name: "Overview", icon: LayoutDashboard },
  ...["leads", "contacts", "companies", "deals", "pitch-desk"].map((k) => ({
    path: `/${k}`,
    name: entities[k].title,
    icon: entities[k].icon,
  })),
  { path: "/reports/sales", name: "Sales Reports", icon: ChartNoAxesCombined },
  ...["activities", "tasks"].map((k) => ({
    path: `/${k}`,
    name: entities[k].title,
    icon: entities[k].icon,
  })),
  { path: "/team", name: "Team", icon: Users },
  { path: "/settings", name: "Settings", icon: Settings2 },
];
export const labels: Record<string, string> = {
  name: "Name",
  company_name: "Company",
  company_id: "Company",
  contact_id: "Contact",
  lead_id: "Lead",
  deal_id: "Deal",
  owner_id: "Owner",
  created_at: "Created",
  expected_close_date: "Close date",
  due_date: "Due date",
  job_title: "Job title",
  occurred_at: "Occurred",
  period_start: "From",
  period_end: "Until",
  team_target: "Team target",
  paid_at: "Received",
};
export const titleCase = (s: string) =>
  labels[s] || s.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
