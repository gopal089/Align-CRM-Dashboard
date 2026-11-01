import { describe, it, expect, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseImportFile, boundedUnzip } from "../src/lib/importParser";
import {
  mappedRows,
  inputBatches,
  normalizedPhone,
  importLimits,
  errorCsvData,
} from "../src/lib/contactImport";
const bytes = (s: string) => new TextEncoder().encode(s);
function workbook(
  cell = '<c r="A2" t="inlineStr"><is><t>Alice</t></is></c>',
  other: Record<string, Uint8Array> = {},
) {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(
      '<workbook><sheets><sheet name="Customers" r:id="r1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row><row r="2">' +
        cell +
        "</row></sheetData></worksheet>",
    ),
    ...other,
  });
}
describe("bounded contact file parsing", () => {
  it("reads quoted UTF-8 CSV and real XLSX worksheets without executing cells", () => {
    expect(
      parseImportFile("people.csv", bytes('Name,Notes\nAlice,"Hello, world"'))
        .sheets[0].rows[1],
    ).toEqual(["Alice", "Hello, world"]);
    expect(parseImportFile("people.xlsx", workbook()).sheets[0].rows).toEqual([
      ["Name"],
      ["Alice"],
    ]);
  });
  it("keeps currency formats numeric and offers multiple XLSX worksheets", () => {
    const archive = workbook('<c r="A2" s="0"><v>123</v></c>', {
      "xl/styles.xml": bytes(
        '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="[$USD]0.00"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>',
      ),
      "xl/workbook.xml": bytes(
        '<workbook><sheets><sheet name="One" r:id="r1"/><sheet name="Two" r:id="r2"/></sheets></workbook>',
      ),
      "xl/_rels/workbook.xml.rels": bytes(
        '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet2.xml": bytes(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Second</t></is></c></row></sheetData></worksheet>',
      ),
    });
    const result = parseImportFile("two.xlsx", archive);
    expect(result.sheets.map((s) => s.name)).toEqual(["One", "Two"]);
    expect(result.sheets[0].rows[1][0]).toBe("123");
    expect(result.sheets[1].rows[1][0]).toBe("Second");
  });
  it("rejects oversized files, too many rows/columns and long cells", () => {
    expect(() =>
      parseImportFile("x.csv", new Uint8Array(importLimits.fileBytes + 1)),
    ).toThrow("5 MB");
    expect(() =>
      parseImportFile(
        "x.csv",
        bytes("Name\n" + Array(10001).fill("Alice").join("\n")),
      ),
    ).toThrow("10,000");
    expect(() =>
      parseImportFile("x.csv", bytes(Array(101).fill("x").join(",") + "\na")),
    ).toThrow("100 columns");
    expect(() =>
      parseImportFile("x.csv", bytes("Name\n" + "x".repeat(2001))),
    ).toThrow("2,000");
  });
  it("rejects wrong encodings, malformed CSV and unsupported/macro files", () => {
    expect(() =>
      parseImportFile("x.csv", new Uint8Array([0xff, 0xfe, 65, 0])),
    ).toThrow("UTF-8");
    expect(() =>
      parseImportFile("x.csv", bytes('Name\n"unterminated')),
    ).toThrow("quoting");
    expect(() => parseImportFile("x.xlsm", workbook())).toThrow("Macro");
    expect(() =>
      parseImportFile(
        "x.xlsx",
        workbook(undefined, { "xl/vbaProject.bin": bytes("macro") }),
      ),
    ).toThrow("Macros");
  });
  it("rejects formulas, entities, external links and very sparse worksheets", () => {
    expect(() =>
      parseImportFile(
        "x.xlsx",
        workbook(
          '<c r="A2"><f>HYPERLINK("https://example.invalid")</f><v>1</v></c>',
        ),
      ),
    ).toThrow("formulas");
    expect(() =>
      parseImportFile(
        "x.xlsx",
        workbook(undefined, {
          "xl/workbook.xml": bytes(
            '<!DOCTYPE x [<!ENTITY x "bomb">]><workbook/>',
          ),
        }),
      ),
    ).toThrow("DTD");
    expect(() =>
      parseImportFile(
        "x.xlsx",
        workbook(undefined, {
          "xl/_rels/workbook.xml.rels": bytes(
            '<Relationships><Relationship Id="r1" Target="https://example.invalid" TargetMode="External"/></Relationships>',
          ),
        }),
      ),
    ).toThrow("External");
    expect(() =>
      parseImportFile("x.xlsx", workbook('<c r="XFD2"><v>1</v></c>')),
    ).toThrow("100 columns");
  });
  it("rejects a compressed bomb before expansion and lies about expanded sizes during streaming", () => {
    const bomb = zipSync({ "bomb.xml": new Uint8Array(21 * 1024 * 1024) });
    expect(() => boundedUnzip(bomb)).toThrow("20 MB");
    const lying = zipSync({ "bomb.xml": new Uint8Array(2 * 1024 * 1024) });
    const dv = new DataView(lying.buffer);
    for (let i = 0; i < lying.length - 46; i++)
      if (dv.getUint32(i, true) === 0x02014b50) {
        dv.setUint32(i + 24, 1, true);
        break;
      }
    expect(() => boundedUnzip(lying)).toThrow(/decompression|size/);
  });
  it("maps custom values, zero and No, normalizes keys, and exposes formula errors before upload", () => {
    const field = {
      id: "10000000-0000-0000-0000-000000000001",
      org_id: "o",
      entity: "contacts" as const,
      name: "VIP",
      field_type: "boolean" as const,
      options: [],
      archived_at: null,
    };
    const sheet = {
      name: "CSV",
      rows: [
        ["Name", "Email", "Phone", "VIP"],
        ["Alice", " ALICE@EXAMPLE.COM ", "+91 (999) 123-4567", "No"],
        ['=HYPERLINK("bad")', "", "", ""],
      ],
    };
    const rows = mappedRows(
      sheet,
      ["name", "email", "phone", "cf:" + field.id],
      [field],
    );
    expect(rows[0].payload).toMatchObject({
      email: "alice@example.com",
      phone: "919991234567",
      custom_values: { [field.id]: false },
    });
    expect(rows[0].client_error).toBe("");
    expect(rows[1].client_error).toContain("Formula");
    expect(normalizedPhone("0091 9991234567")).toBe("919991234567");
    expect(() => mappedRows(sheet, ["name", "name", "", ""], [])).toThrow(
      "only once",
    );
  });
  it("protects error CSV headers, formulas and leading whitespace while retaining source values", () => {
    const value = errorCsvData(
      [' =HYPERLINK("x")', "Phone"],
      [
        {
          row_no: 2,
          error: " @SUM(1)",
          source: [' =HYPERLINK("bad")', "+919991234567"],
        },
      ],
    );
    expect(value.labels.column_0).toBe('\' =HYPERLINK("x")');
    expect(value.rows[0]).toMatchObject({
      row: 2,
      error: "' @SUM(1)",
      column_0: '\' =HYPERLINK("bad")',
      column_1: "'+919991234567",
    });
  });
  it("produces an actual protected CSV Blob through the existing download helper", async () => {
    const { csv } = await import("../src/lib/utils");
    let blob: Blob | undefined;
    let clicked = false;
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((value) => {
        blob = value as Blob;
        return "blob:local-import-test";
      });
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    vi.stubGlobal("document", {
      createElement: () => ({
        click: () => {
          clicked = true;
        },
        href: "",
        download: "",
      }),
    });
    const data = errorCsvData(
      ["Name", "Notes"],
      [
        {
          row_no: 2,
          error: "Invalid email",
          source: ["Alice", ' =HYPERLINK("bad")'],
        },
      ],
    );
    csv(data.rows, data.columns, "errors.csv", data.labels);
    expect(clicked).toBe(true);
    expect(await blob!.text()).toContain("' =HYPERLINK");
    create.mockRestore();
    revoke.mockRestore();
    vi.unstubAllGlobals();
  });
  it("keeps uploads at 25 rows and below the server request-byte limit", () => {
    const rows = Array.from({ length: 61 }, (_, i) => ({
      row_no: i + 2,
      payload: { name: "A" },
      source: ["A"],
      client_error: "",
    }));
    const batches = inputBatches(rows);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 11]);
    expect(
      batches.every((b) => bytes(JSON.stringify({ rows: b })).length < 98304),
    ).toBe(true);
  });
});
