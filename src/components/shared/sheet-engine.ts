"use client";

import { type KeyboardEvent, useEffect, useRef, useState } from "react";

export type SheetFieldType =
  | "actions"
  | "boolean"
  | "custom"
  | "image"
  | "json"
  | "longText"
  | "number"
  | "select"
  | "text";

export type SheetCellCoord<Field extends string> = {
  field: Field;
  rowId: string;
};

export type SheetSelection<Field extends string> = {
  anchor: SheetCellCoord<Field>;
  focus: SheetCellCoord<Field>;
};

export type SheetColumn<Row, Field extends string> = {
  editable?: boolean | ((row: Row) => boolean);
  editor?: "custom" | "input" | "select" | "textarea";
  id: Field;
  label: string;
  required?: boolean;
  type: SheetFieldType;
  validator?: (value: string, row: Row) => string | null;
  width: number;
};

export type SheetSchema<Row, Field extends string> = {
  columns: SheetColumn<Row, Field>[];
  getRowId: (row: Row) => string;
};

export type SheetAdapter<Row> = {
  importRows?: (rows: Row[]) => void;
  loadDraft?: () => Row[] | Promise<Row[]>;
  persistDraft?: (rows: Row[]) => void;
  serializeRow?: (row: Row) => unknown;
  submitRows?: (rows: Row[]) => void | Promise<void>;
};

export type SheetPastePolicy<Row> = {
  allowAppend: boolean;
  createRow?: (rowIndex: number) => Row;
  maxNonEmptyRows?: number;
};

export type SheetPasteResult<Row> = {
  appendedRows: number;
  changed: boolean;
  endFieldIndex: number;
  endRowIndex: number;
  rows: Row[];
};

export type SheetTransaction<Row> = {
  after: Row[];
  before: Row[];
  kind: "deleteRange" | "editCell" | "importRows" | "insertRows" | "pasteRange" | "removeRows";
};

type UseSheetEngineOptions<Row, Field extends string> = {
  cloneRows?: (rows: Row[]) => Row[];
  ensureRows?: (rows: Row[]) => Row[];
  fields: readonly Field[];
  getFieldValue: (row: Row, field: Field) => string;
  getRowId: (row: Row) => string;
  hasRowContent?: (row: Row) => boolean;
  historyLimit?: number;
  initialRows: Row[];
  isGlobalUndoBlockedTarget?: (target: EventTarget | null) => boolean;
  onRowsChange?: (rows: Row[]) => void;
  serializeRowsForHistory?: (rows: Row[]) => string;
  setFieldValue: (row: Row, field: Field, value: string) => Row;
  useGlobalUndo?: boolean;
};

function defaultCloneRows<Row>(rows: Row[]) {
  return rows.map((row) => ({ ...(row as Record<string, unknown>) }) as Row);
}

function isUndoShortcut(event: globalThis.KeyboardEvent) {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === "z" || event.code === "KeyZ")
  );
}

function isRedoShortcut(event: globalThis.KeyboardEvent) {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    (((event.shiftKey && event.key.toLowerCase() === "z") || (event.shiftKey && event.code === "KeyZ")) ||
      (!event.shiftKey && (event.key.toLowerCase() === "y" || event.code === "KeyY")))
  );
}

export function isSheetEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export function hasNativeTextSelection(target: EventTarget | null) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return (target.selectionEnd ?? 0) > (target.selectionStart ?? 0);
  }

  return false;
}

export function parseClipboardTable(text: string) {
  const rows: string[][] = [[]];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "\t" && !inQuotes) {
      rows[rows.length - 1].push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }

      rows[rows.length - 1].push(cell);
      cell = "";
      rows.push([]);
      continue;
    }

    cell += char;
  }

  rows[rows.length - 1].push(cell);

  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }

  return rows;
}

/**
 * Applies a clipboard matrix by row/column coordinates. The caller controls whether
 * capacity may grow, which keeps listing tables read/write-only while allowing the
 * dedicated upload sheet to behave like Excel.
 */
export function applySheetPasteMatrix<Row, Field extends string>(input: {
  fields: readonly Field[];
  getFieldValue: (row: Row, field: Field) => string;
  matrix: string[][];
  policy: SheetPastePolicy<Row>;
  rows: Row[];
  setFieldValue: (row: Row, field: Field, value: string) => Row;
  startFieldIndex: number;
  startRowIndex: number;
}): SheetPasteResult<Row> {
  const { fields, getFieldValue, matrix, policy, setFieldValue, startFieldIndex, startRowIndex } = input;
  if (startRowIndex < 0 || startFieldIndex < 0 || !matrix.length) {
    return {
      appendedRows: 0,
      changed: false,
      endFieldIndex: startFieldIndex,
      endRowIndex: startRowIndex,
      rows: input.rows,
    };
  }

  const nonEmptyRows = matrix.filter((row) => row.some((value) => value.trim() !== "")).length;
  if (policy.maxNonEmptyRows && nonEmptyRows > policy.maxNonEmptyRows) {
    throw new Error(`Paste at most ${policy.maxNonEmptyRows} non-empty rows at a time.`);
  }

  const requiredRowCount = startRowIndex + matrix.length;
  const nextRows = [...input.rows];
  if (requiredRowCount > nextRows.length && policy.allowAppend) {
    if (!policy.createRow) throw new Error("A row factory is required when paste can append rows.");
    while (nextRows.length < requiredRowCount) nextRows.push(policy.createRow(nextRows.length));
  }

  let changed = false;
  const appliedRowCount = Math.max(0, Math.min(matrix.length, nextRows.length - startRowIndex));
  for (let rowOffset = 0; rowOffset < appliedRowCount; rowOffset += 1) {
    const rowIndex = startRowIndex + rowOffset;
    let nextRow = nextRows[rowIndex];
    const cells = matrix[rowOffset];
    for (let columnOffset = 0; columnOffset < cells.length; columnOffset += 1) {
      const field = fields[startFieldIndex + columnOffset];
      if (!field) continue;
      const value = cells[columnOffset];
      if (getFieldValue(nextRow, field) !== value) {
        nextRow = setFieldValue(nextRow, field, value);
        changed = true;
      }
    }
    nextRows[rowIndex] = nextRow;
  }

  return {
    appendedRows: Math.max(0, nextRows.length - input.rows.length),
    changed,
    endFieldIndex: Math.min(
      fields.length - 1,
      startFieldIndex + Math.max(0, ...matrix.map((row) => row.length - 1)),
    ),
    endRowIndex: startRowIndex + Math.max(0, appliedRowCount - 1),
    rows: changed || nextRows.length !== input.rows.length ? nextRows : input.rows,
  };
}

export function useSheetEngine<Row, Field extends string>({
  cloneRows = defaultCloneRows,
  ensureRows,
  fields,
  getFieldValue,
  getRowId,
  hasRowContent,
  historyLimit = 80,
  initialRows,
  isGlobalUndoBlockedTarget,
  onRowsChange,
  serializeRowsForHistory,
  setFieldValue,
  useGlobalUndo = false,
}: UseSheetEngineOptions<Row, Field>) {
  function normalizeRows(nextRows: Row[]) {
    return ensureRows ? ensureRows(nextRows) : nextRows;
  }

  function historyKey(nextRows: Row[]) {
    return serializeRowsForHistory ? serializeRowsForHistory(nextRows) : JSON.stringify(nextRows);
  }

  const [rows, setRowsState] = useState<Row[]>(() => normalizeRows(initialRows));
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [activeCell, setActiveCell] = useState<SheetCellCoord<Field> | null>(null);
  const [editingCell, setEditingCell] = useState<SheetCellCoord<Field> | null>(null);
  const [selection, setSelection] = useState<SheetSelection<Field> | null>(null);
  const [isSelectingCells, setIsSelectingCells] = useState(false);
  const [isSelectingRows, setIsSelectingRows] = useState(false);
  const activeCellRef = useRef<SheetCellCoord<Field> | null>(activeCell);
  const cellSelectionAnchorRef = useRef<SheetCellCoord<Field> | null>(null);
  const dirtyCellsRef = useRef<Map<string, string>>(new Map());
  const editingCellRef = useRef<SheetCellCoord<Field> | null>(editingCell);
  const fieldsRef = useRef(fields);
  const isSelectingRowsRef = useRef(false);
  const redoRowsRef = useRef<Row[][]>([]);
  const rowSelectionAnchorRef = useRef<string | null>(null);
  const rowsRef = useRef<Row[]>(rows);
  const selectionRef = useRef<SheetSelection<Field> | null>(selection);
  const undoRowsRef = useRef<Row[][]>([]);

  activeCellRef.current = activeCell;
  editingCellRef.current = editingCell;
  fieldsRef.current = fields;
  selectionRef.current = selection;

  const validRows = hasRowContent ? rows.filter(hasRowContent) : rows;
  const selectedRows = rows.filter((row) => selectedRowIds.has(getRowId(row)));
  const selectedValidRows = hasRowContent
    ? rows.filter((row) => selectedRowIds.has(getRowId(row)) && hasRowContent(row))
    : selectedRows;
  const allRowsSelected =
    validRows.length > 0 && validRows.every((row) => selectedRowIds.has(getRowId(row)));

  function recordHistory(previousRows: Row[], nextRows: Row[]) {
    if (historyKey(previousRows) === historyKey(nextRows)) return;

    undoRowsRef.current = [...undoRowsRef.current.slice(1 - historyLimit), cloneRows(previousRows)];
    redoRowsRef.current = [];
  }

  function publishRows(nextRows: Row[]) {
    rowsRef.current = nextRows;
    setRowsState(nextRows);
    onRowsChange?.(nextRows);
  }

  function applyRowsFromHistory(nextRows: Row[]) {
    const stableRows = normalizeRows(cloneRows(nextRows));

    dirtyCellsRef.current.clear();
    publishRows(stableRows);
    setEditingCell(null);
    setSelection(null);
    setIsSelectingRows(false);
    isSelectingRowsRef.current = false;
    setSelectedRowIds((currentSelectedRowIds) => {
      const nextRowIds = new Set(stableRows.map(getRowId));
      return new Set(Array.from(currentSelectedRowIds).filter((rowId) => nextRowIds.has(rowId)));
    });
  }

  function hydrateRows(nextRows: Row[]) {
    const stableRows = normalizeRows(nextRows);

    dirtyCellsRef.current.clear();
    redoRowsRef.current = [];
    undoRowsRef.current = [];
    publishRows(stableRows);
    setSelectedRowIds(new Set());
    setEditingCell(null);
    setSelection(null);
    setIsSelectingRows(false);
    isSelectingRowsRef.current = false;
    rowSelectionAnchorRef.current = null;
  }

  function replaceRows(nextRows: Row[], options: { recordHistory?: boolean } = {}) {
    const stableRows = normalizeRows(nextRows);
    const shouldRecordHistory = options.recordHistory ?? true;

    if (shouldRecordHistory) {
      recordHistory(rowsRef.current, stableRows);
    }

    dirtyCellsRef.current.clear();
    publishRows(stableRows);
    setSelectedRowIds((currentSelectedRowIds) => {
      const nextRowIds = new Set(stableRows.map(getRowId));
      return new Set(Array.from(currentSelectedRowIds).filter((rowId) => nextRowIds.has(rowId)));
    });
    setIsSelectingRows(false);
    isSelectingRowsRef.current = false;
  }

  function removeRowsById(rowIds: Iterable<string>, fallbackRows: Row[] = []) {
    const rowIdSet = new Set(rowIds);

    if (rowIdSet.size === 0) return rowsRef.current;

    const filteredRows = rowsRef.current.filter((row) => !rowIdSet.has(getRowId(row)));
    const stableRows = normalizeRows(filteredRows.length ? filteredRows : fallbackRows);

    recordHistory(rowsRef.current, stableRows);
    dirtyCellsRef.current.clear();
    publishRows(stableRows);
    setEditingCell(null);
    setSelection(null);
    setIsSelectingRows(false);
    isSelectingRowsRef.current = false;
    setActiveCell((currentActiveCell) =>
      currentActiveCell && stableRows.some((row) => getRowId(row) === currentActiveCell.rowId)
        ? currentActiveCell
        : null,
    );
    setSelectedRowIds((currentSelectedRowIds) => {
      const stableRowIds = new Set(stableRows.map(getRowId));
      return new Set(Array.from(currentSelectedRowIds).filter((rowId) => stableRowIds.has(rowId)));
    });

    return stableRows;
  }

  function removeSelectedRows(fallbackRows: Row[] = []) {
    return removeRowsById(selectedRowIds, fallbackRows);
  }

  function undoRows() {
    const undoRows = undoRowsRef.current;
    const previousRows = undoRows[undoRows.length - 1];

    if (!previousRows) return;

    undoRowsRef.current = undoRows.slice(0, -1);
    redoRowsRef.current = [...redoRowsRef.current.slice(1 - historyLimit), cloneRows(rowsRef.current)];
    applyRowsFromHistory(previousRows);
  }

  function redoRows() {
    const redoRows = redoRowsRef.current;
    const nextRows = redoRows[redoRows.length - 1];

    if (!nextRows) return;

    redoRowsRef.current = redoRows.slice(0, -1);
    undoRowsRef.current = [...undoRowsRef.current.slice(1 - historyLimit), cloneRows(rowsRef.current)];
    applyRowsFromHistory(nextRows);
  }

  function cellKey(rowId: string, field: Field) {
    return `${rowId}:${field}`;
  }

  function queueCellValue(rowId: string, field: Field, value: string) {
    dirtyCellsRef.current.set(cellKey(rowId, field), value);
  }

  function discardQueuedCellValue(rowId: string, field: Field) {
    dirtyCellsRef.current.delete(cellKey(rowId, field));
  }

  function commitDirtyCells() {
    const dirtyCells = dirtyCellsRef.current;

    if (dirtyCells.size === 0) return rowsRef.current;

    const previousRows = cloneRows(rowsRef.current);
    const nextRows = normalizeRows(
      rowsRef.current.map((row) => {
        let nextRow = row;
        const rowId = getRowId(row);

        for (const field of fieldsRef.current) {
          const key = cellKey(rowId, field);

          if (!dirtyCells.has(key)) continue;

          nextRow = setFieldValue(nextRow, field, dirtyCells.get(key) ?? "");
        }

        return nextRow;
      }),
    );

    recordHistory(previousRows, nextRows);
    dirtyCells.clear();
    publishRows(nextRows);
    return nextRows;
  }

  function updateCell(rowId: string, field: Field, value: string) {
    replaceRows(
      rowsRef.current.map((row) => (getRowId(row) === rowId ? setFieldValue(row, field, value) : row)),
    );
  }

  function fieldIndex(field: Field) {
    return fieldsRef.current.indexOf(field);
  }

  function selectionBounds(currentSelection = selectionRef.current) {
    if (!currentSelection) return null;

    const currentRows = rowsRef.current;
    const anchorRowIndex = currentRows.findIndex((row) => getRowId(row) === currentSelection.anchor.rowId);
    const focusRowIndex = currentRows.findIndex((row) => getRowId(row) === currentSelection.focus.rowId);
    const anchorFieldIndex = fieldIndex(currentSelection.anchor.field);
    const focusFieldIndex = fieldIndex(currentSelection.focus.field);

    if (anchorRowIndex < 0 || focusRowIndex < 0 || anchorFieldIndex < 0 || focusFieldIndex < 0) {
      return null;
    }

    return {
      endFieldIndex: Math.max(anchorFieldIndex, focusFieldIndex),
      endRowIndex: Math.max(anchorRowIndex, focusRowIndex),
      startFieldIndex: Math.min(anchorFieldIndex, focusFieldIndex),
      startRowIndex: Math.min(anchorRowIndex, focusRowIndex),
    };
  }

  function isCellSelected(rowId: string, field: Field) {
    const bounds = selectionBounds();

    if (!bounds) return false;

    const rowIndex = rowsRef.current.findIndex((row) => getRowId(row) === rowId);
    const currentFieldIndex = fieldIndex(field);

    return (
      rowIndex >= bounds.startRowIndex &&
      rowIndex <= bounds.endRowIndex &&
      currentFieldIndex >= bounds.startFieldIndex &&
      currentFieldIndex <= bounds.endFieldIndex
    );
  }

  function copySelectionAsTsv() {
    const bounds = selectionBounds();

    if (!bounds) return "";

    const selectedRowsForCopy = rowsRef.current.slice(bounds.startRowIndex, bounds.endRowIndex + 1);
    const selectedFields = fieldsRef.current.slice(bounds.startFieldIndex, bounds.endFieldIndex + 1);

    return selectedRowsForCopy
      .map((row) => selectedFields.map((field) => getFieldValue(row, field)).join("\t"))
      .join("\n");
  }

  function clearSelection() {
    const bounds = selectionBounds();

    if (!bounds) return;

    replaceRows(
      rowsRef.current.map((row, rowIndex) => {
        if (rowIndex < bounds.startRowIndex || rowIndex > bounds.endRowIndex) return row;

        let nextRow = row;

        fieldsRef.current.forEach((field, currentFieldIndex) => {
          if (currentFieldIndex >= bounds.startFieldIndex && currentFieldIndex <= bounds.endFieldIndex) {
            nextRow = setFieldValue(nextRow, field, "");
          }
        });

        return nextRow;
      }),
    );
  }

  function activateCell(rowId: string, field: Field, extendSelection = false) {
    const nextCell = { field, rowId };

    setActiveCell(nextCell);
    setEditingCell(null);
    setSelection((currentSelection) =>
      extendSelection && currentSelection
        ? { anchor: currentSelection.anchor, focus: nextCell }
        : { anchor: nextCell, focus: nextCell },
    );
  }

  function isCellActive(rowId: string, field: Field) {
    return activeCellRef.current?.rowId === rowId && activeCellRef.current.field === field;
  }

  function isCellEditing(rowId: string, field: Field) {
    return editingCellRef.current?.rowId === rowId && editingCellRef.current.field === field;
  }

  function startCellRangeSelection(rowId: string, field: Field, extendSelection = false) {
    const nextCell = { field, rowId };
    const anchor = extendSelection && selectionRef.current ? selectionRef.current.anchor : nextCell;

    cellSelectionAnchorRef.current = anchor;
    setActiveCell(nextCell);
    setEditingCell(null);
    setSelection({ anchor, focus: nextCell });
    setIsSelectingCells(true);
  }

  function extendCellRangeSelection(rowId: string, field: Field) {
    const anchor = cellSelectionAnchorRef.current;
    if (!anchor) return false;

    const focus = { field, rowId };
    setActiveCell(focus);
    setSelection({ anchor, focus });
    return anchor.rowId !== focus.rowId || anchor.field !== focus.field;
  }

  function stopCellRangeSelection() {
    cellSelectionAnchorRef.current = null;
    setIsSelectingCells(false);
  }

  function moveActiveCell(rowOffset: number, fieldOffset: number, extendSelection = false) {
    const currentRows = rowsRef.current;
    const currentFields = fieldsRef.current;
    const firstRowId = currentRows[0] ? getRowId(currentRows[0]) : "";
    const currentCell = activeCellRef.current ?? {
      field: currentFields[0],
      rowId: firstRowId,
    };
    const currentRowIndex = Math.max(0, currentRows.findIndex((row) => getRowId(row) === currentCell.rowId));
    const currentFieldIndex = Math.max(0, fieldIndex(currentCell.field));
    let nextRowIndex = Math.max(0, currentRowIndex + rowOffset);
    let nextFieldIndex = currentFieldIndex + fieldOffset;

    if (nextFieldIndex < 0) {
      nextFieldIndex = currentFields.length - 1;
      nextRowIndex = Math.max(0, nextRowIndex - 1);
    } else if (nextFieldIndex >= currentFields.length) {
      nextFieldIndex = 0;
      nextRowIndex += 1;
    }

    const targetRow = currentRows[nextRowIndex];

    if (!targetRow) return;

    activateCell(getRowId(targetRow), currentFields[nextFieldIndex], extendSelection);
  }

  function toggleRowSelection(rowId: string, checked: boolean) {
    rowSelectionAnchorRef.current = rowId;
    setSelectedRowIds((currentSelectedRowIds) => {
      const nextSelectedRowIds = new Set(currentSelectedRowIds);

      if (checked) {
        nextSelectedRowIds.add(rowId);
      } else {
        nextSelectedRowIds.delete(rowId);
      }

      return nextSelectedRowIds;
    });
  }

  function toggleAllValidRows(checked: boolean) {
    rowSelectionAnchorRef.current = null;
    setSelectedRowIds(checked ? new Set(validRows.map(getRowId)) : new Set());
  }

  function rowIdsInRange(anchorRowId: string, focusRowId: string) {
    const anchorIndex = rowsRef.current.findIndex((row) => getRowId(row) === anchorRowId);
    const focusIndex = rowsRef.current.findIndex((row) => getRowId(row) === focusRowId);

    if (anchorIndex < 0 || focusIndex < 0) return [focusRowId];

    const startIndex = Math.min(anchorIndex, focusIndex);
    const endIndex = Math.max(anchorIndex, focusIndex);

    return rowsRef.current.slice(startIndex, endIndex + 1).map(getRowId);
  }

  function selectRowRange(anchorRowId: string, focusRowId: string, additive = false) {
    const rangeRowIds = rowIdsInRange(anchorRowId, focusRowId);

    setSelectedRowIds((currentSelectedRowIds) => {
      const nextSelectedRowIds = additive ? new Set(currentSelectedRowIds) : new Set<string>();

      for (const rowId of rangeRowIds) {
        nextSelectedRowIds.add(rowId);
      }

      return nextSelectedRowIds;
    });
  }

  function startRowRangeSelection(rowId: string, options: { additive?: boolean; extend?: boolean } = {}) {
    const anchorRowId = options.extend && rowSelectionAnchorRef.current ? rowSelectionAnchorRef.current : rowId;

    rowSelectionAnchorRef.current = anchorRowId;
    isSelectingRowsRef.current = true;
    setIsSelectingRows(true);
    selectRowRange(anchorRowId, rowId, options.additive);
  }

  function extendRowRangeSelection(rowId: string) {
    if (!isSelectingRowsRef.current) return;

    const anchorRowId = rowSelectionAnchorRef.current ?? rowId;
    selectRowRange(anchorRowId, rowId);
  }

  function stopRowRangeSelection() {
    isSelectingRowsRef.current = false;
    setIsSelectingRows(false);
  }

  useEffect(() => {
    if (!useGlobalUndo) return;

    function handleWindowKeyDown(event: globalThis.KeyboardEvent) {
      if (!isUndoShortcut(event) && !isRedoShortcut(event)) return;
      if (isSheetEditableTarget(event.target) || isGlobalUndoBlockedTarget?.(event.target)) return;

      event.preventDefault();

      if (isUndoShortcut(event)) {
        undoRows();
      } else {
        redoRows();
      }
    }

    window.addEventListener("keydown", handleWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  });

  useEffect(() => {
    if (!isSelectingCells && !isSelectingRows) return;

    function stopPointerSelection() {
      cellSelectionAnchorRef.current = null;
      setIsSelectingCells(false);
      isSelectingRowsRef.current = false;
      setIsSelectingRows(false);
    }

    window.addEventListener("pointerup", stopPointerSelection);

    return () => {
      window.removeEventListener("pointerup", stopPointerSelection);
    };
  }, [isSelectingCells, isSelectingRows]);

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (editingCellRef.current) {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditingCell(null);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActiveCell(-1, 0, event.shiftKey);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActiveCell(1, 0, event.shiftKey);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveActiveCell(0, -1, event.shiftKey);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      moveActiveCell(0, 1, event.shiftKey);
    } else if (event.key === "Tab") {
      event.preventDefault();
      moveActiveCell(0, event.shiftKey ? -1 : 1);
    } else if (event.key === "Enter" || event.key === "F2") {
      if (!activeCellRef.current) return;
      event.preventDefault();
      setEditingCell(activeCellRef.current);
    } else if (activeCellRef.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      updateCell(activeCellRef.current.rowId, activeCellRef.current.field, event.key);
      setEditingCell(activeCellRef.current);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      clearSelection();
    }
  }

  return {
    activateCell,
    activeCell,
    allRowsSelected,
    clearSelection,
    commitDirtyCells,
    copySelectionAsTsv,
    discardQueuedCellValue,
    editingCell,
    fields,
    handleGridKeyDown,
    hydrateRows,
    isCellActive,
    isCellEditing,
    isCellSelected,
    isSelectingCells,
    isSelectingRows,
    moveActiveCell,
    queueCellValue,
    redoRows,
    removeRowsById,
    removeSelectedRows,
    replaceRows,
    rows,
    rowsRef,
    selectedRowIds,
    selectedRows,
    selectedValidRows,
    selection,
    setActiveCell,
    setEditingCell,
    setIsSelectingCells,
    setSelectedRowIds,
    setSelection,
    startCellRangeSelection,
    extendCellRangeSelection,
    stopCellRangeSelection,
    startRowRangeSelection,
    extendRowRangeSelection,
    stopRowRangeSelection,
    toggleAllValidRows,
    toggleRowSelection,
    undoRows,
    updateCell,
    validRows,
  };
}
