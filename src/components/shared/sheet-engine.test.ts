import { describe, expect, it } from "vitest";
import { applySheetPasteMatrix, parseClipboardTable } from "@/components/shared/sheet-engine";

type Row = { id: string; price: string; sku: string; title: string };
type Field = "sku" | "title" | "price";
const fields: Field[] = ["sku", "title", "price"];

function apply(rows: Row[], matrix: string[][], startRowIndex: number, startFieldIndex: number, allowAppend: boolean) {
  return applySheetPasteMatrix({
    fields,
    getFieldValue: (row, field) => row[field],
    matrix,
    policy: {
      allowAppend,
      createRow: (index) => ({ id: `row-${index}`, price: "", sku: "", title: "" }),
      maxNonEmptyRows: 100,
    },
    rows,
    setFieldValue: (row, field, value) => ({ ...row, [field]: value }),
    startFieldIndex,
    startRowIndex,
  });
}

describe("sheet clipboard engine", () => {
  it("parses quoted tabs, quoted newlines, and preserves blank coordinate rows", () => {
    expect(parseClipboardTable('A\t"two\tparts"\r\n\r\nB\t"line 1\nline 2"\r\n')).toEqual([
      ["A", "two\tparts"],
      [""],
      ["B", "line 1\nline 2"],
    ]);
  });

  it("never appends when the table policy disables append", () => {
    const rows = [{ id: "one", price: "", sku: "", title: "" }];
    const result = apply(rows, [["SKU-1"], ["SKU-2"]], 0, 0, false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sku).toBe("SKU-1");
    expect(result.appendedRows).toBe(0);
  });

  it("appends only the exact overflow and supports a later coordinate paste", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ id: `row-${index}`, price: "", sku: "", title: "" }));
    const first = apply(rows, Array.from({ length: 10 }, (_, index) => [`SKU-${index}`]), 45, 0, true);
    expect(first.rows).toHaveLength(55);
    expect(first.appendedRows).toBe(5);
    const second = apply(first.rows, Array.from({ length: 10 }, (_, index) => [String(index + 1)]), 45, 2, true);
    expect(second.rows).toHaveLength(55);
    expect(second.rows[45]).toMatchObject({ price: "1", sku: "SKU-0" });
  });
});
