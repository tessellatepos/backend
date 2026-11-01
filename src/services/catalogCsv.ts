/** Largest CSV body the import accepts. */
export const MAX_CSV_BYTES = 1024 * 1024;
/** Most data rows (header excluded) one import may carry. */
export const MAX_CSV_ROWS = 5000;

/** The CSV is malformed. Carries a fixed message, never CSV content. */
export class CsvError extends Error {
    readonly code: "malformed" | "too_many_rows";

    constructor(code: "malformed" | "too_many_rows", message: string) {
        super(message);
        this.code = code;
    }
}

/**
 * Parses RFC 4180 CSV: quoted cells may hold commas, quotes ("") and
 * newlines. A leading byte-order mark and blank lines are ignored.
 * @param input the CSV text
 * @returns the rows, header included, with the 1-based line each starts on
 */
export function parseCsv(input: string): { line: number; cells: string[] }[] {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const rows: { line: number; cells: string[] }[] = [];
    let cells: string[] = [];
    let cell = "";
    let quoted = false;
    let wasQuoted = false;
    let line = 1;
    let rowLine = 1;

    const endCell = () => {
        cells.push(cell);
        cell = "";
        wasQuoted = false;
    };
    const endRow = () => {
        const blank = cells.length === 0 && cell === "" && !wasQuoted;
        endCell();
        if (!blank) {
            rows.push({ line: rowLine, cells });
            if (rows.length > MAX_CSV_ROWS + 1) {
                throw new CsvError("too_many_rows", "Too many rows");
            }
        }
        cells = [];
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    quoted = false;
                }
            } else {
                if (ch === "\n") line++;
                cell += ch;
            }
        } else if (ch === '"' && cell === "") {
            quoted = true;
            wasQuoted = true;
        } else if (ch === ",") {
            endCell();
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            endRow();
            line++;
            rowLine = line;
        } else {
            cell += ch;
        }
    }
    if (quoted) throw new CsvError("malformed", "Unterminated quote");
    if (cell !== "" || cells.length > 0 || wasQuoted) endRow();
    return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Makes a cell safe to open in a spreadsheet: text a spreadsheet would run
 * as a formula gets a leading apostrophe, which {@link unguardCell} removes.
 * @param value the cell text
 * @returns the text to write
 */
function guardCell(value: string): string {
    return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * Reverses {@link guardCell} on imported text.
 * @param value a cell read from a CSV
 * @returns the original text
 */
export function unguardCell(value: string): string {
    return value.startsWith("'") && FORMULA_START.test(value.slice(1))
        ? value.slice(1)
        : value;
}

/**
 * Writes rows as CSV (CRLF line ends), guarding spreadsheet formulas.
 * @param rows the cells of each row
 * @returns the CSV text
 */
export function serializeCsv(rows: string[][]): string {
    return (
        rows
            .map((row) =>
                row
                    .map((raw) => {
                        const value = guardCell(raw);
                        return /[",\r\n]/.test(value)
                            ? `"${value.replace(/"/g, '""')}"`
                            : value;
                    })
                    .join(","),
            )
            .join("\r\n") + "\r\n"
    );
}
