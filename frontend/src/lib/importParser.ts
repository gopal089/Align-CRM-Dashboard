import Papa from "papaparse";
import { Unzip, UnzipInflate } from "fflate";
import { SaxesParser } from "saxes";
import { importLimits as limits, validateMatrix } from "./contactImport";
import type { ImportBook, ImportSheet } from "./contactImport";

function xml(
  text: string,
  open: (name: string, attrs: Record<string, string>) => void,
  chars: (value: string) => void = () => {},
  close: (name: string) => void = () => {},
) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new Error("DTD/entities are not allowed in workbooks.");
  let depth = 0;
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => {
    if (++depth > 32) throw new Error("Workbook XML is too deeply nested.");
    open(tag.name, tag.attributes as Record<string, string>);
  });
  parser.on("text", chars);
  parser.on("cdata", chars);
  parser.on("closetag", (tag) => {
    close(tag.name);
    depth--;
  });
  parser.on("doctype", () => {
    throw new Error("Workbook document types are not allowed.");
  });
  parser.write(text).close();
}
export function boundedUnzip(bytes: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (
    end < 0 ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  )
    throw new Error("Use a valid, single-part XLSX file.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true),
    declared = 0;
  if (count === 65535 || count > 1000 || offset === 0xffffffff)
    throw new Error("ZIP64 or oversized workbooks are not supported.");
  const entries = new Map<string, number>();
  const decode = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    )
      throw new Error("Malformed workbook archive.");
    const flags = view.getUint16(offset + 8, true),
      method = view.getUint16(offset + 10, true),
      size = view.getUint32(offset + 24, true),
      len = view.getUint16(offset + 28, true),
      extra = view.getUint16(offset + 30, true),
      comment = view.getUint16(offset + 32, true);
    if (offset + 46 + len + extra + comment > bytes.length)
      throw new Error("Malformed workbook archive.");
    const name = decode.decode(bytes.subarray(offset + 46, offset + 46 + len));
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      size === 0xffffffff ||
      /(^\/|(^|\/)\.\.(\/|$)|\\)/.test(name) ||
      entries.has(name)
    )
      throw new Error(
        "Encrypted, duplicate or unsafe archive entries are not allowed.",
      );
    if (/vba|\.bin$|externalLinks|embeddings|activeX/i.test(name))
      throw new Error(
        "Macros, embedded objects and external links are not allowed.",
      );
    declared += size;
    if (declared > limits.unzippedBytes)
      throw new Error("Unzipped workbook exceeds 20 MB.");
    entries.set(name, size);
    offset += 46 + len + extra + comment;
  }
  const files: Record<string, Uint8Array> = Object.create(null);
  let actual = 0,
    finished = 0;
  const unzip = new Unzip((file) => {
    const expected = entries.get(file.name);
    if (expected === undefined)
      throw new Error("Workbook archive entries disagree.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length;
      actual += data.length;
      if (size > expected || actual > limits.unzippedBytes)
        throw new Error("Workbook decompression limit exceeded.");
      chunks.push(data);
      if (final) {
        if (size !== expected)
          throw new Error("Workbook archive size mismatch.");
        const out = new Uint8Array(size);
        let at = 0;
        for (const part of chunks) {
          out.set(part, at);
          at += part.length;
        }
        files[file.name] = out;
        finished++;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // A small compressed input chunk bounds an inflate allocation even if archive sizes lie.
  for (let at = 0; at < bytes.length; at += 1024)
    unzip.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
  if (finished !== entries.size)
    throw new Error("Incomplete workbook archive.");
  return files;
}
export function parseImportFile(name: string, bytes: Uint8Array): ImportBook {
  if (bytes.length > limits.fileBytes) throw new Error("File exceeds 5 MB.");
  if (!bytes.length) throw new Error("Choose a nonempty CSV or XLSX file.");
  const decode = new TextDecoder("utf-8", { fatal: true });
  if (/\.csv$/i.test(name)) {
    let text: string;
    try {
      text = decode.decode(bytes);
    } catch {
      throw new Error(
        "CSV must use UTF-8 encoding. Export it as CSV UTF-8 and try again.",
      );
    }
    if (text.includes("\0"))
      throw new Error("CSV must use UTF-8 encoding, without NUL characters.");
    const rows: string[][] = [];
    Papa.parse<string[]>(text, {
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      step(result, parser) {
        if (result.errors.some((e) => e.code !== "UndetectableDelimiter")) {
          parser.abort();
          throw new Error("Malformed CSV quoting or delimiter.");
        }
        rows.push(result.data);
        if (rows.length > limits.rows + 1) {
          parser.abort();
          throw new Error("A file can contain at most 10,000 data rows.");
        }
        if (
          result.data.length > limits.columns ||
          result.data.some((c) => c.length > limits.cellLength)
        ) {
          parser.abort();
          throw new Error(
            "Use at most 100 columns and 2,000 characters per cell.",
          );
        }
      },
    });
    validateMatrix(rows);
    return { sheets: [{ name: "CSV", rows }] };
  }
  if (!/\.xlsx$/i.test(name))
    throw new Error(
      "Choose .csv or .xlsx. Macro-enabled and legacy Excel files are not supported.",
    );
  const files = boundedUnzip(bytes);
  const part = (path: string) => {
    if (!files[path]) throw new Error("Required workbook part is missing.");
    return decode.decode(files[path]);
  };
  if (/macroEnabled|vbaProject/i.test(part("[Content_Types].xml")))
    throw new Error("Macros are not allowed.");
  const strings: string[] = [];
  let current = "",
    inText = false;
  if (files["xl/sharedStrings.xml"])
    xml(
      part("xl/sharedStrings.xml"),
      (n) => {
        if (n === "si") current = "";
        if (n === "t") inText = true;
      },
      (v) => {
        if (inText) {
          current += v;
          if (current.length > limits.cellLength)
            throw new Error("Each cell must contain at most 2,000 characters.");
        }
      },
      (n) => {
        if (n === "t") inText = false;
        if (n === "si") {
          strings.push(current);
          if (strings.length > 100000)
            throw new Error("Workbook shared-string limit exceeded.");
        }
      },
    );
  const relations = new Map<string, string>();
  xml(part("xl/_rels/workbook.xml.rels"), (n, a) => {
    if (n === "Relationship") {
      if (a.TargetMode === "External")
        throw new Error("External workbook links are not allowed.");
      if (a.Target && a.Id) {
        const target = a.Target.startsWith("/")
          ? a.Target.slice(1)
          : "xl/" + a.Target;
        if (!target.includes("..")) relations.set(a.Id, target);
      }
    }
  });
  const sheets: { name: string; path: string }[] = [];
  let date1904 = false;
  xml(part("xl/workbook.xml"), (n, a) => {
    if (n === "workbookPr")
      date1904 = a.date1904 === "1" || a.date1904 === "true";
    if (n === "sheet") {
      const path = relations.get(a["r:id"]);
      if (!path) throw new Error("Worksheet relationship is missing.");
      sheets.push({ name: a.name, path });
      if (sheets.length > 20) throw new Error("Use at most 20 worksheets.");
    }
  });
  const dates = new Set<number>();
  const formats = new Set<number>();
  let inXfs = false,
    style = 0;
  if (files["xl/styles.xml"])
    xml(
      part("xl/styles.xml"),
      (n, a) => {
        if (
          n === "numFmt" &&
          /[ymdhis]/i.test(
            (a.formatCode || "").replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ""),
          )
        )
          formats.add(Number(a.numFmtId));
        if (n === "cellXfs") inXfs = true;
        else if (n === "xf" && inXfs) {
          const id = Number(a.numFmtId);
          if (
            (id >= 14 && id <= 22) ||
            (id >= 45 && id <= 47) ||
            formats.has(id)
          )
            dates.add(style);
          style++;
        }
      },
      () => {},
      (n) => {
        if (n === "cellXfs") inXfs = false;
      },
    );
  let cells = 0,
    totalRows = 0;
  const result: ImportSheet[] = sheets.map((sheet) => {
    const rows: string[][] = [];
    let row = 0,
      col = 0,
      type = "",
      value = "",
      inline = "",
      isValue = false,
      isText = false,
      date = false;
    xml(
      part(sheet.path),
      (n, a) => {
        if (n === "f")
          throw new Error(
            "Spreadsheet formulas are not allowed. Replace formulas with values and upload again.",
          );
        if (n === "row") {
          row = Number(a.r || rows.length + 1);
          if (!Number.isInteger(row) || row < 1 || row > limits.rows + 1)
            throw new Error("A file can contain at most 10,000 data rows.");
          while (rows.length < row) rows.push([]);
        }
        if (n === "c") {
          const address = /^([A-Z]+)[1-9][0-9]*$/.exec(a.r || "");
          if (!address) throw new Error("Invalid worksheet cell address.");
          col = 0;
          for (const c of address[1]) col = col * 26 + c.charCodeAt(0) - 64;
          if (col > limits.columns) throw new Error("Use at most 100 columns.");
          if (++cells > limits.cells)
            throw new Error("Workbook exceeds 250,000 cells.");
          type = a.t || "";
          date = dates.has(Number(a.s));
          value = "";
          inline = "";
        }
        if (n === "v") isValue = true;
        if (n === "t") isText = true;
      },
      (v) => {
        if (isValue) value += v;
        if (isText) inline += v;
        if (
          value.length > limits.cellLength ||
          inline.length > limits.cellLength
        )
          throw new Error("Each cell must contain at most 2,000 characters.");
      },
      (n) => {
        if (n === "v") isValue = false;
        if (n === "t") isText = false;
        if (n === "c") {
          let text =
            type === "inlineStr"
              ? inline
              : type === "s"
                ? strings[Number(value)]
                : type === "b"
                  ? value === "1"
                    ? "true"
                    : "false"
                  : value;
          if (text === undefined)
            throw new Error("Invalid shared string index.");
          if (date && type !== "s" && type !== "inlineStr" && value !== "") {
            const serial = Number(value);
            if (!Number.isFinite(serial) || serial < 0 || serial > 2958465)
              throw new Error("Invalid Excel date.");
            text = new Date(
              (date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)) +
                Math.floor(serial) * 86400000,
            )
              .toISOString()
              .slice(0, 10);
          }
          if (type === "e")
            throw new Error(
              "Workbook contains an Excel error cell. Replace errors with plain values.",
            );
          rows[row - 1][col - 1] = text;
        }
      },
    );
    const dense = rows.map((r) =>
      Array.from({ length: r.length }, (_, i) => r[i] || ""),
    );
    while (dense.length && dense[dense.length - 1].every((c) => !c.trim()))
      dense.pop();
    if (dense.length > 1) validateMatrix(dense);
    totalRows += Math.max(0, dense.length - 1);
    return { name: sheet.name, rows: dense };
  });
  if (totalRows > limits.rows)
    throw new Error(
      "The workbook contains more than 10,000 data rows across its worksheets.",
    );
  if (!result.some((s) => s.rows.length > 1))
    throw new Error("The workbook has no data rows.");
  return { sheets: result };
}
