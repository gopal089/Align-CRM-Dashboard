import { describe, expect, it, vi } from "vitest";
import {
  applyCustomFilters,
  archivedViewFields,
  customValue,
  parseCustomFilters,
  serializeCustomValues,
  viewConfiguration,
  visibleColumns,
  type CustomField,
} from "../src/lib/customization";
import { entities } from "../src/lib/model";
import { csv } from "../src/lib/utils";
const id = "10000000-0000-0000-0000-000000000001";
const field = (
  type: CustomField["field_type"] = "text",
  archived = false,
): CustomField => ({
  id,
  org_id: crypto.randomUUID(),
  entity: "leads",
  name: "Custom label",
  field_type: type,
  options: ["Gold"],
  archived_at: archived ? new Date().toISOString() : null,
});
describe("Custom field values and saved configurations", () => {
  it("exports custom labels, false and zero while retaining CSV formula protection", async () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor });
    let blob: Blob | undefined;
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((value) => {
        blob = value as Blob;
        return "blob:local-test";
      });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    try {
      csv(
        [{ id: "row", custom: "=1+1", zero: 0, boolean: false }],
        ["id", "custom", "zero", "boolean"],
        "local.csv",
        { custom: "Custom label" },
      );
      expect(await blob!.text()).toContain(
        '"id","Custom label","zero","boolean"',
      );
      expect(await blob!.text()).toContain('"row","\'=1+1","0","false"');
      expect(anchor.download).toBe("local.csv");
      expect(anchor.click).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(revoke).toHaveBeenCalledWith("blob:local-test");
    } finally {
      create.mockRestore();
      revoke.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it("preserves zero, false and archived values while clearing empty active fields", () => {
    expect(serializeCustomValues({ [id]: "0" }, [field("number")])).toEqual({
      [id]: 0,
    });
    expect(serializeCustomValues({ [id]: false }, [field("boolean")])).toEqual({
      [id]: false,
    });
    expect(serializeCustomValues({ [id]: "" }, [field()])).toEqual({});
    expect(
      serializeCustomValues({ [id]: "Retained" }, [field("text", true)]),
    ).toEqual({ [id]: "Retained" });
  });
  it("rejects invalid numbers, calendar dates and dropdown values", () => {
    for (const value of ["not a number", Infinity, 1e16])
      expect(() =>
        serializeCustomValues({ [id]: value }, [field("number")]),
      ).toThrow();
    expect(() =>
      serializeCustomValues({ [id]: "2026-02-31" }, [field("date")]),
    ).toThrow();
    expect(
      serializeCustomValues({ [id]: "2028-02-29" }, [field("date")]),
    ).toEqual({ [id]: "2028-02-29" });
    expect(() =>
      serializeCustomValues({ [id]: "Missing" }, [field("dropdown")]),
    ).toThrow();
  });
  it("does not persist transient page/new/view selectors or arbitrary parameters", () => {
    expect(
      viewConfiguration(
        new URLSearchParams(
          "q=hello&sort=name&direction=asc&page=9&new=1&saved_view=other&attack=1",
        ),
        ["name"],
      ),
    ).toEqual({
      version: 1,
      columns: ["name"],
      params: { q: "hello", sort: "name", direction: "asc" },
    });
  });
  it("detects archived references in columns, sorting and filters without erasing them", () => {
    const params = new URLSearchParams({
      cf: JSON.stringify([{ field: id, op: "eq", value: "Gold" }]),
      sort: `cf:${id}`,
    });
    const config = viewConfiguration(params, ["name", `cf:${id}`]);
    expect(archivedViewFields(config, [field("text", true)])).toHaveLength(1);
    expect(config.params.cf).toContain(id);
    expect(
      visibleColumns(
        entities.leads,
        new URLSearchParams({ columns: `name,cf:${id}` }),
        [field("text", true)],
      ),
    ).toEqual(["name", `cf:${id}`]);
  });
  it("always keeps name and rejects unknown visible columns", () => {
    expect(
      visibleColumns(
        entities.contacts,
        new URLSearchParams("columns=email,password"),
        [],
      ),
    ).toEqual(["name", "email"]);
    expect(
      visibleColumns(entities.leads, new URLSearchParams(), [field()]),
    ).toContain(`cf:${id}`);
    expect(
      customValue({ custom_values: { [id]: false } } as any, `cf:${id}`),
    ).toBe(false);
  });
  it("rejects forged paths, operators and oversized filter lists", () => {
    for (const input of [
      "not json",
      JSON.stringify([{ field: "org_id", op: "eq", value: "x" }]),
      JSON.stringify([{ field: id, op: "or", value: "x" }]),
      JSON.stringify(
        Array.from({ length: 21 }, () => ({ field: id, op: "eq", value: "x" })),
      ),
    ])
      expect(() => parseCustomFilters(input)).toThrow();
  });
  it("uses typed JSON comparisons for numbers and literal text for contains", () => {
    const query: any = {};
    for (const method of ["filter", "ilike", "is", "not"])
      query[method] = vi.fn(() => query);
    applyCustomFilters(
      query,
      new URLSearchParams({
        cf: JSON.stringify([{ field: id, op: "gte", value: "12" }]),
      }),
      [field("number")],
    );
    expect(query.filter).toHaveBeenCalledWith(
      `custom_values->${id}`,
      "gte",
      "12",
    );
    applyCustomFilters(
      query,
      new URLSearchParams({
        cf: JSON.stringify([{ field: id, op: "contains", value: "100%_" }]),
      }),
      [field()],
    );
    expect(query.ilike).toHaveBeenCalledWith(
      `custom_values->>${id}`,
      "%100\\%\\_%",
    );
    expect(() =>
      applyCustomFilters(
        query,
        new URLSearchParams({
          cf: JSON.stringify([{ field: id, op: "eq", value: "x" }]),
        }),
        [],
      ),
    ).toThrow("unavailable");
  });
  it("empty filters use SQL null checks without replacing the normal search", () => {
    const query: any = { is: vi.fn(), not: vi.fn() };
    query.is.mockReturnValue(query);
    query.not.mockReturnValue(query);
    for (const op of ["empty", "not_empty"])
      applyCustomFilters(
        query,
        new URLSearchParams({
          cf: JSON.stringify([{ field: id, op, value: "" }]),
        }),
        [field()],
      );
    expect(query.is).toHaveBeenCalledWith(`custom_values->>${id}`, null);
    expect(query.not).toHaveBeenCalledWith(`custom_values->>${id}`, "is", null);
  });
});
