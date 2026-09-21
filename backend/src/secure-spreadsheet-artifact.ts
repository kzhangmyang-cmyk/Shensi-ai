import { createHash } from "node:crypto";
import XLSX from "xlsx-js-style";

export class SecureSpreadsheetError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SecureSpreadsheetError";
    this.code = code;
  }
}

export interface ParsedSpreadsheetCell {
  text: string;
  formula: string | null;
  /** Original 1-based spreadsheet coordinates; rows retain their legacy compaction. */
  sourceRow?: number;
  sourceColumn?: number;
  /** Whether a formula cell carries an original workbook cached value; never recomputed. */
  hasCachedValue?: boolean;
}

export interface ParsedSpreadsheetSheet {
  name: string;
  rows: Array<Array<ParsedSpreadsheetCell>>;
}

export interface ParsedSpreadsheetArtifact {
  fileHash: string;
  mediaType:
    | "text/csv"
    | "application/vnd.ms-excel"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  sheets: ParsedSpreadsheetSheet[];
}

export interface SecureSpreadsheetLimits {
  maxBytes: number;
  maxSheets: number;
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
}

export interface SecureSpreadsheetArtifactInput {
  content: Buffer;
  mediaType: string;
  limits: SecureSpreadsheetLimits;
}

export function escapeSpreadsheetCell(value: string) {
  return /^[=+\-@]/u.test(value.trimStart()) ? `'${value}` : value;
}

function invalidSpreadsheet(): never {
  throw new SecureSpreadsheetError("IMPORT_ARTIFACT_INVALID");
}

function spreadsheetLimitExceeded(): never {
  throw new SecureSpreadsheetError("IMPORT_LIMIT_EXCEEDED");
}

export function normalizedSpreadsheetMediaType(
  mediaType: string
): ParsedSpreadsheetArtifact["mediaType"] {
  if (mediaType === "text/csv") return "text/csv";
  if (mediaType === "application/vnd.ms-excel") return mediaType;
  if (mediaType
    === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  invalidSpreadsheet();
}

function parseCsvCells(
  content: Buffer,
  limits: SecureSpreadsheetLimits
): ParsedSpreadsheetSheet[] {
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(content)
    .replace(/^\ufeff/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (character === "\"") {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === "\"") {
      if (cell.length !== 0) invalidSpreadsheet();
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else {
      cell += character;
    }
    if (cell.length > limits.maxCellLength
      || row.length > limits.maxColumns) {
      spreadsheetLimitExceeded();
    }
  }
  if (quoted) invalidSpreadsheet();
  row.push(cell);
  if (row.some((value) => value.length > 0) || rows.length === 0) {
    rows.push(row);
  }
  return [{
    name: "CSV",
    rows: rows.map((values, rowIndex) => values.map((value, columnIndex) => ({
      text: value,
      formula: null,
      sourceRow: rowIndex + 1,
      sourceColumn: columnIndex + 1
    })))
  }];
}

const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const MAX_XLSX_ZIP_ENTRIES = 2_000;
const MAX_XLSX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 100;

function boundedZipRange(
  content: Buffer,
  offset: number,
  size: number
) {
  if (!Number.isSafeInteger(offset)
    || !Number.isSafeInteger(size)
    || offset < 0
    || size < 0
    || offset > content.length
    || size > content.length - offset) {
    invalidSpreadsheet();
  }
  return offset + size;
}

function locateZipEndOfCentralDirectory(content: Buffer) {
  if (content.length < 22) invalidSpreadsheet();
  const lowerBound = Math.max(0, content.length - 22 - 65_535);
  for (
    let offset = content.length - 22;
    offset >= lowerBound;
    offset -= 1
  ) {
    if (content.readUInt32LE(offset)
      !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = content.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === content.length) {
      return offset;
    }
  }
  invalidSpreadsheet();
}

function validateZipExtraFields(
  content: Buffer,
  offset: number,
  length: number
) {
  const end = boundedZipRange(content, offset, length);
  let cursor = offset;
  while (cursor < end) {
    if (end - cursor < 4) invalidSpreadsheet();
    const fieldId = content.readUInt16LE(cursor);
    const fieldLength = content.readUInt16LE(cursor + 2);
    cursor += 4;
    if (fieldId === ZIP64_EXTRA_FIELD_ID) invalidSpreadsheet();
    cursor = boundedZipRange(content, cursor, fieldLength);
    if (cursor > end) invalidSpreadsheet();
  }
  if (cursor !== end) invalidSpreadsheet();
}

function decodeZipEntryName(value: Buffer) {
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    invalidSpreadsheet();
  }
  if (!name
    || name.includes("\u0000")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[a-z]:/iu.test(name)
    || name.split("/").includes("..")) {
    invalidSpreadsheet();
  }
  return name.normalize("NFKC").toLocaleLowerCase();
}

function isDangerousXlsxPackageEntry(name: string) {
  return name === "xl/vbaproject.bin"
    || name.startsWith("xl/externallinks/")
    || name.startsWith("xl/macrosheets/")
    || name.startsWith("xl/intlmacrosheets/")
    || name.startsWith("xl/activex/")
    || name.startsWith("xl/embeddings/")
    || name.startsWith("xl/ctrlprops/")
    || name.startsWith("customui/");
}

function assertSafeXlsxZip(content: Buffer) {
  const eocdOffset = locateZipEndOfCentralDirectory(content);
  if (eocdOffset >= 20
    && content.readUInt32LE(eocdOffset - 20)
      === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    invalidSpreadsheet();
  }
  const diskNumber = content.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = content.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = content.readUInt16LE(eocdOffset + 8);
  const totalEntries = content.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = content.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = content.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== totalEntries
    || totalEntries === 0
    || totalEntries === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff) {
    invalidSpreadsheet();
  }
  if (totalEntries > MAX_XLSX_ZIP_ENTRIES) {
    spreadsheetLimitExceeded();
  }
  const centralDirectoryEnd = boundedZipRange(
    content,
    centralDirectoryOffset,
    centralDirectorySize
  );
  if (centralDirectoryEnd !== eocdOffset) invalidSpreadsheet();

  let cursor = centralDirectoryOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  const names = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (boundedZipRange(content, cursor, 46) > centralDirectoryEnd
      || content.readUInt32LE(cursor)
        !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      invalidSpreadsheet();
    }
    const versionNeeded = content.readUInt16LE(cursor + 6);
    const flags = content.readUInt16LE(cursor + 8);
    const compressionMethod = content.readUInt16LE(cursor + 10);
    const compressedSize = content.readUInt32LE(cursor + 20);
    const uncompressedSize = content.readUInt32LE(cursor + 24);
    const fileNameLength = content.readUInt16LE(cursor + 28);
    const extraLength = content.readUInt16LE(cursor + 30);
    const commentLength = content.readUInt16LE(cursor + 32);
    const diskStart = content.readUInt16LE(cursor + 34);
    const localHeaderOffset = content.readUInt32LE(cursor + 42);
    if (versionNeeded >= 45
      || (flags & 0x0041) !== 0
      || ![0, 8].includes(compressionMethod)
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || diskStart !== 0
      || localHeaderOffset === 0xffffffff) {
      invalidSpreadsheet();
    }
    const nameStart = cursor + 46;
    const extraStart = boundedZipRange(
      content,
      nameStart,
      fileNameLength
    );
    const commentStart = boundedZipRange(
      content,
      extraStart,
      extraLength
    );
    const nextEntry = boundedZipRange(
      content,
      commentStart,
      commentLength
    );
    if (nextEntry > centralDirectoryEnd) invalidSpreadsheet();
    const rawName = content.subarray(nameStart, extraStart);
    const name = decodeZipEntryName(rawName);
    if (names.has(name) || isDangerousXlsxPackageEntry(name)) {
      invalidSpreadsheet();
    }
    names.add(name);
    validateZipExtraFields(content, extraStart, extraLength);

    totalCompressedBytes += compressedSize;
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES
      || (uncompressedSize > 0 && compressedSize === 0)
      || uncompressedSize
        > compressedSize * MAX_XLSX_COMPRESSION_RATIO) {
      spreadsheetLimitExceeded();
    }

    const localHeaderEnd = boundedZipRange(
      content,
      localHeaderOffset,
      30
    );
    if (localHeaderEnd > centralDirectoryOffset
      || content.readUInt32LE(localHeaderOffset)
        !== ZIP_LOCAL_FILE_SIGNATURE) {
      invalidSpreadsheet();
    }
    const localVersionNeeded = content.readUInt16LE(
      localHeaderOffset + 4
    );
    const localFlags = content.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = content.readUInt16LE(
      localHeaderOffset + 8
    );
    const localFileNameLength = content.readUInt16LE(
      localHeaderOffset + 26
    );
    const localExtraLength = content.readUInt16LE(
      localHeaderOffset + 28
    );
    if (localVersionNeeded >= 45
      || localFlags !== flags
      || (localFlags & 0x0041) !== 0
      || localCompressionMethod !== compressionMethod) {
      invalidSpreadsheet();
    }
    const localNameStart = localHeaderOffset + 30;
    const localExtraStart = boundedZipRange(
      content,
      localNameStart,
      localFileNameLength
    );
    const localDataStart = boundedZipRange(
      content,
      localExtraStart,
      localExtraLength
    );
    if (localDataStart > centralDirectoryOffset
      || localFileNameLength !== fileNameLength
      || !content.subarray(
        localNameStart,
        localExtraStart
      ).equals(rawName)) {
      invalidSpreadsheet();
    }
    validateZipExtraFields(
      content,
      localExtraStart,
      localExtraLength
    );
    const localDataEnd = boundedZipRange(
      content,
      localDataStart,
      compressedSize
    );
    if (localDataEnd > centralDirectoryOffset) invalidSpreadsheet();
    localRanges.push({
      start: localHeaderOffset,
      end: localDataEnd
    });
    cursor = nextEntry;
  }
  if (cursor !== centralDirectoryEnd
    || (totalUncompressedBytes > 0
      && totalCompressedBytes === 0)
    || totalUncompressedBytes
      > totalCompressedBytes * MAX_XLSX_COMPRESSION_RATIO) {
    if (cursor !== centralDirectoryEnd) invalidSpreadsheet();
    spreadsheetLimitExceeded();
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index - 1]!.end > localRanges[index]!.start) {
      invalidSpreadsheet();
    }
  }
}

function rowsFromWorksheet(
  sheet: XLSX.WorkSheet,
  limits: SecureSpreadsheetLimits
): Array<Array<ParsedSpreadsheetCell>> {
  const reference = sheet["!ref"];
  if (!reference) return [];
  const range = XLSX.utils.decode_range(reference);
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (![range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger)
    || range.s.r < 0 || range.s.c < 0 || rowCount < 1 || columnCount < 1) {
    invalidSpreadsheet();
  }
  if (rowCount > limits.maxRows || columnCount > limits.maxColumns) {
    spreadsheetLimitExceeded();
  }
  const rows: Array<Array<ParsedSpreadsheetCell>> = [];
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: ParsedSpreadsheetCell[] = [];
    let hasCell = false;
    for (let columnIndex = range.s.c;
      columnIndex <= range.e.c;
      columnIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({
        r: rowIndex,
        c: columnIndex
      })];
      if (cell === undefined || (cell.t === "z" && typeof cell.f !== "string")) {
        row.push({ text: "", formula: null,
          sourceRow: rowIndex + 1, sourceColumn: columnIndex + 1 });
        continue;
      }
      hasCell = true;
      const text = cell.t === "z" ? "" : cell.w !== undefined
        ? String(cell.w)
        : cell.v !== undefined ? String(cell.v) : "";
      row.push({
        text,
        formula: typeof cell.f === "string" ? cell.f : null,
        ...(typeof cell.f === "string" ? { hasCachedValue: cell.t !== "z" && cell.v !== undefined && cell.v !== null } : {}),
        sourceRow: rowIndex + 1,
        sourceColumn: columnIndex + 1
      });
    }
    if (hasCell) rows.push(row);
  }
  return rows;
}

function parseXlsxCellsAfterSafeZipValidation(
  content: Buffer,
  limits: SecureSpreadsheetLimits
): ParsedSpreadsheetSheet[] {
  assertSafeXlsxZip(content);
  return parseWorkbookCells(content, limits);
}

function parseLegacyExcelCells(content: Buffer, limits: SecureSpreadsheetLimits): ParsedSpreadsheetSheet[] {
  const compound = content.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  let source: Buffer | string = content;
  if (!compound) {
    try {
      source = new TextDecoder(content[0] === 0xff && content[1] === 0xfe ? 'utf-16le' : 'utf-8', { fatal: true }).decode(content).replace(/^\ufeff/u, '').trim();
    } catch { invalidSpreadsheet(); }
    // Only static HTML tables or Excel 2003 SpreadsheetML; never arbitrary text,
    // entity declarations, active content or external-resource instructions.
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<(?:script|iframe|object|embed|link)\b|\bon\w+\s*=|\b(?:src|href)\s*=/iu.test(source)) invalidSpreadsheet();
    const html = /^(?:<html\b|<table\b)/iu.test(source) && /<table\b/iu.test(source);
    const xml = /^(?:<\?xml[^>]*>\s*)?<Workbook\b/iu.test(source)
      && /urn:schemas-microsoft-com:office:spreadsheet/u.test(source);
    if (!html && !xml) invalidSpreadsheet();
  }
  return parseWorkbookCells(source, limits, true);
}

function parseWorkbookCells(
  content: Buffer | string,
  limits: SecureSpreadsheetLimits,
  legacy = false
): ParsedSpreadsheetSheet[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(content, {
      type: typeof content === 'string' ? 'string' : "buffer",
      cellDates: false,
      cellFormula: true,
      sheetStubs: true,
      bookVBA: legacy,
      dense: false
    });
  } catch {
    invalidSpreadsheet();
  }
  if (legacy && (workbook.vbaraw || workbook.SheetNames.some(name => String(workbook.Sheets[name]?.['!type']) === 'macro'))) invalidSpreadsheet();
  if (workbook.SheetNames.length < 1
    || workbook.SheetNames.length > limits.maxSheets) {
    spreadsheetLimitExceeded();
  }
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) invalidSpreadsheet();
    return { name, rows: rowsFromWorksheet(sheet, limits) };
  });
}

function assertSpreadsheetShape(
  sheets: ParsedSpreadsheetSheet[],
  limits: SecureSpreadsheetLimits
) {
  if (sheets.some((sheet) => sheet.rows.length > limits.maxRows
    || sheet.rows.some((row) => row.length > limits.maxColumns
      || row.some((cell) => cell.text.length > limits.maxCellLength)))) {
    spreadsheetLimitExceeded();
  }
}

export function parseSecureSpreadsheetArtifact(
  input: SecureSpreadsheetArtifactInput
): ParsedSpreadsheetArtifact {
  if (input.content.length > input.limits.maxBytes) {
    spreadsheetLimitExceeded();
  }
  const fileHash = `sha256:${createHash("sha256")
    .update(input.content).digest("hex")}`;
  const mediaType = normalizedSpreadsheetMediaType(input.mediaType);
  const sheets = mediaType === "text/csv"
    ? parseCsvCells(input.content, input.limits)
    : mediaType === 'application/vnd.ms-excel' ? parseLegacyExcelCells(input.content, input.limits)
    : parseXlsxCellsAfterSafeZipValidation(input.content, input.limits);
  assertSpreadsheetShape(sheets, input.limits);
  return { fileHash, mediaType, sheets };
}
