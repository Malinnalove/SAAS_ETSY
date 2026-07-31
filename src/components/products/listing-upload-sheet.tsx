"use client";

import { AlertTriangle, Check, LoaderCircle, Send, Settings2, Trash2 } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListingGridCellEditor } from "@/components/products/listing-grid-cell-editor";
import { DataGrid, type DataGridColumn } from "@/components/shared/data-grid";
import { hasNativeTextSelection, parseClipboardTable, useSheetEngine } from "@/components/shared/sheet-engine";
import { listingFieldDefinitions } from "@/features/products/listing-workbench-model";
import {
  isListingUploadRowEmpty,
  listingUploadRowErrors,
  listingUploadValueAsText,
  LISTING_UPLOAD_FIELDS,
  setListingUploadCell,
} from "@/features/products/listing-upload-model";
import type { Locale } from "@/shared/i18n";
import type {
  ListingShopDefaults,
  ListingUploadField,
  ListingUploadRow,
  ListingUploadWorkspace,
  ListingValidationErrors,
} from "@/shared/types/listing-workbench";

type ApiError = Error & { rowErrors?: Array<{ errors: ListingValidationErrors; rowId: number }>; status?: number };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const csrfToken = typeof document === "undefined"
    ? ""
    : (document.getElementById("app-csrf-token") as HTMLInputElement | null)?.value ?? "";
  const method = String(init?.method ?? "GET").toUpperCase();
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(!["GET", "HEAD", "OPTIONS"].includes(method) ? { "x-csrf-token": csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(String(body.error ?? `Request failed (${response.status}).`)) as ApiError;
    error.status = response.status;
    if (Array.isArray(body.rowErrors)) error.rowErrors = body.rowErrors as ApiError["rowErrors"];
    throw error;
  }
  return body as T;
}

function setUploadField(row: ListingUploadRow, field: ListingUploadField, value: string): ListingUploadRow {
  const applied = setListingUploadCell(row.values, field, value, row.values.price?.currency || "USD");
  const validationErrors = { ...row.validationErrors };
  if (applied.error) validationErrors[field] = applied.error;
  else delete validationErrors[field];
  return { ...row, validationErrors, values: applied.values };
}

const uploadDefaultSummaryFields: ListingUploadField[] = [
  "price",
  "quantity",
  "state",
  "taxonomyId",
  "shippingProfileId",
  "readinessStateId",
  "returnPolicyId",
  "shouldAutoRenew",
];

function uploadDefaultSummaryValue(defaults: ListingShopDefaults, field: ListingUploadField, locale: Locale) {
  const value = defaults.values[field];
  if (field === "price") {
    return defaults.values.price
      ? `${defaults.values.price.amount} ${defaults.values.price.currency}`
      : "";
  }
  if (field === "shouldAutoRenew") {
    return value ? (locale === "zh" ? "是" : "Yes") : (locale === "zh" ? "否" : "No");
  }
  return value === null || value === undefined || value === "" ? "" : String(value);
}

export function ListingUploadSheet({
  locale,
  onConverted,
  onEditDefaults,
  selectedShopId,
  shopDefaults,
}: {
  locale: Locale;
  onConverted: () => void;
  onEditDefaults: () => void;
  selectedShopId: number;
  shopDefaults: ListingShopDefaults;
}) {
  const [workspace, setWorkspace] = useState<ListingUploadWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const [rawValues, setRawValues] = useState<Record<string, string>>({});
  const [expandedCell, setExpandedCell] = useState<{ field: ListingUploadField; rowId: string } | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollSyncSourceRef = useRef<"grid" | "top" | null>(null);
  const fields = useMemo(() => [...LISTING_UPLOAD_FIELDS], []);
  const defaultSummary = useMemo(() => {
    const definitions = new Map(listingFieldDefinitions.map((definition) => [definition.id, definition]));
    return uploadDefaultSummaryFields.flatMap((field) => {
      const value = uploadDefaultSummaryValue(shopDefaults, field, locale);
      const definition = definitions.get(field);
      return value && definition ? [{ field, label: definition.label[locale], value }] : [];
    });
  }, [locale, shopDefaults]);
  const sheet = useSheetEngine<ListingUploadRow, ListingUploadField>({
    fields,
    getFieldValue: (row, field) => rawValues[`${row.id}:${field}`] ?? listingUploadValueAsText(row.values, field),
    getRowId: (row) => String(row.id),
    hasRowContent: (row) => !isListingUploadRowEmpty(row.values),
    initialRows: [],
    setFieldValue: setUploadField,
    useGlobalUndo: true,
  });
  const {
    activeCell,
    allRowsSelected,
    copySelectionAsTsv,
    editingCell,
    handleGridKeyDown,
    hydrateRows,
    isCellActive,
    isCellEditing,
    isCellSelected,
    moveActiveCell,
    rows,
    rowsRef,
    selectedRowIds,
    selection,
    setEditingCell,
    setSelectedRowIds,
    startCellRangeSelection,
    extendCellRangeSelection,
    stopCellRangeSelection,
    startRowRangeSelection,
    extendRowRangeSelection,
    stopRowRangeSelection,
    toggleAllValidRows,
    updateCell,
  } = sheet;
  const hydrateRowsRef = useRef(hydrateRows);
  useEffect(() => {
    hydrateRowsRef.current = hydrateRows;
  }, [hydrateRows]);

  const uploadSelectionBounds = useMemo(() => {
    if (!selection) return null;
    const anchorRowIndex = rows.findIndex((row) => String(row.id) === selection.anchor.rowId);
    const focusRowIndex = rows.findIndex((row) => String(row.id) === selection.focus.rowId);
    const anchorFieldIndex = fields.indexOf(selection.anchor.field);
    const focusFieldIndex = fields.indexOf(selection.focus.field);
    if (anchorRowIndex < 0 || focusRowIndex < 0 || anchorFieldIndex < 0 || focusFieldIndex < 0) return null;
    return {
      endFieldIndex: Math.max(anchorFieldIndex, focusFieldIndex),
      endRowIndex: Math.max(anchorRowIndex, focusRowIndex),
      startFieldIndex: Math.min(anchorFieldIndex, focusFieldIndex),
      startRowIndex: Math.min(anchorRowIndex, focusRowIndex),
    };
  }, [fields, rows, selection]);

  const loadWorkspace = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await fetchJson<ListingUploadWorkspace>(`/api/listing-workbench/upload?shopId=${selectedShopId}`);
      setWorkspace(result);
      hydrateRowsRef.current(result.rows);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Batch upload could not be loaded." });
    } finally {
      setIsLoading(false);
    }
  }, [selectedShopId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  function beginCellSelection(
    event: ReactPointerEvent<HTMLElement>,
    rowId: string,
    field: ListingUploadField,
  ) {
    if (event.button !== 0) return;
    if (!event.shiftKey && isCellActive(rowId, field)) {
      stopCellRangeSelection();
      setEditingCell({ field, rowId });
      focusUploadCellEditor(rowId, field, true);
      return;
    }
    event.preventDefault();
    startCellRangeSelection(rowId, field, event.shiftKey);
  }

  function focusUploadCellEditor(rowId: string, field: ListingUploadField, selectValue = false) {
    window.requestAnimationFrame(() => {
      const editor = document.querySelector(`[data-grid-focus-key="listing-upload:${rowId}:${field}"]`);
      if (!(editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement)) return;
      editor.focus({ preventScroll: true });
      if (selectValue) editor.select();
    });
  }

  function openUploadCellEditor(rowId: string, field: ListingUploadField, expand: boolean) {
    setEditingCell({ field, rowId });
    setExpandedCell(expand ? { field, rowId } : null);
    focusUploadCellEditor(rowId, field, !expand);
  }

  function closeUploadCellEditor(row: ListingUploadRow, field: ListingUploadField) {
    void saveCell(row, field);
    setExpandedCell((current) => current?.rowId === String(row.id) && current.field === field ? null : current);
    setEditingCell((current) => current?.rowId === String(row.id) && current.field === field ? null : current);
  }

  function handleUploadCellKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
    row: ListingUploadRow,
    field: ListingUploadField,
  ) {
    const isExpanded = expandedCell?.rowId === String(row.id) && expandedCell.field === field;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setExpandedCell(null);
      setEditingCell(null);
      event.currentTarget.closest<HTMLElement>(".dataGrid")?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && (!isExpanded || !event.shiftKey))) {
      event.preventDefault();
      event.stopPropagation();
      closeUploadCellEditor(row, field);
      moveActiveCell(event.key === "Enter" ? 1 : 0, event.key === "Tab" ? (event.shiftKey ? -1 : 1) : 0);
      event.currentTarget.closest<HTMLElement>(".dataGrid")?.focus({ preventScroll: true });
    }
  }

  function handleUploadGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const currentCell = activeCell;
    const startsEditing = !editingCell && currentCell && (
      event.key === "Enter" ||
      event.key === "F2" ||
      (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
    );
    if (
      startsEditing &&
      currentCell &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      setRawValues((current) => ({ ...current, [`${currentCell.rowId}:${currentCell.field}`]: event.key }));
    }
    handleGridKeyDown(event);
    if (startsEditing && currentCell) focusUploadCellEditor(currentCell.rowId, currentCell.field, event.key === "Enter" || event.key === "F2");
  }

  async function saveCell(row: ListingUploadRow, field: ListingUploadField) {
    const key = `${row.id}:${field}`;
    const value = rawValues[key];
    if (value === undefined) return;
    try {
      const result = await fetchJson<{ row: ListingUploadRow }>("/api/listing-workbench/upload", {
        body: JSON.stringify({ expectedVersion: row.version, field, rowId: row.id, shopId: selectedShopId, value }),
        method: "PATCH",
      });
      setRawValues((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      hydrateRows(rows.map((item) => item.id === result.row.id ? result.row : item));
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Cell could not be saved." });
    }
  }

  async function pasteAtActiveCell(text: string) {
    if (!activeCell) return false;
    const matrix = parseClipboardTable(text);
    if (!matrix.length) return false;
    if (matrix.filter((row) => row.some((cell) => cell.trim())).length > 100) {
      setNotice({ tone: "error", text: locale === "zh" ? "单次最多粘贴 100 个非空数据行。" : "Paste at most 100 non-empty rows." });
      return true;
    }
    setIsLoading(true);
    try {
      const result = await fetchJson<{ rows: ListingUploadRow[] }>("/api/listing-workbench/upload/paste", {
        body: JSON.stringify({
          fields,
          matrix,
          shopId: selectedShopId,
          startField: activeCell.field,
          startRowId: Number(activeCell.rowId),
        }),
        method: "POST",
      });
      setRawValues({});
      hydrateRows(result.rows);
      setNotice({ tone: "success", text: locale === "zh" ? "已按单元格坐标保存粘贴内容。" : "Paste saved by cell coordinates." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Paste failed." });
    } finally {
      setIsLoading(false);
    }
    return true;
  }

  async function deleteSelected() {
    const rowIds = Array.from(selectedRowIds).map(Number);
    if (!rowIds.length) return;
    setIsLoading(true);
    try {
      const result = await fetchJson<{ rows: ListingUploadRow[] }>("/api/listing-workbench/upload/rows", {
        body: JSON.stringify({ rowIds, shopId: selectedShopId }),
        method: "DELETE",
      });
      setRawValues({});
      hydrateRows(result.rows);
      setSelectedRowIds(new Set());
      setNotice({ tone: "success", text: locale === "zh" ? "已删除选中暂存行，并补足空行。" : "Selected staging rows deleted and blank rows refilled." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Delete failed." });
    } finally {
      setIsLoading(false);
    }
  }

  async function convertSelected() {
    const rowIds = Array.from(selectedRowIds).map(Number);
    if (!rowIds.length) return;
    setIsLoading(true);
    try {
      const result = await fetchJson<{ converted: number }>("/api/listing-workbench/upload/commit", {
        body: JSON.stringify({ requestKey: crypto.randomUUID(), rowIds, shopId: selectedShopId }),
        method: "POST",
      });
      setSelectedRowIds(new Set());
      setNotice({ tone: "success", text: locale === "zh" ? `已将 ${result.converted} 个产品加入批量上传。` : `${result.converted} products added to Batch upload.` });
      await loadWorkspace();
      onConverted();
    } catch (error) {
      const apiError = error as ApiError;
      if (apiError.rowErrors?.length) {
        const errors = new Map(apiError.rowErrors.map((item) => [item.rowId, item.errors]));
        hydrateRows(rowsRef.current.map((row) => errors.has(row.id) ? { ...row, validationErrors: errors.get(row.id)! } : row));
      }
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Rows could not be converted." });
    } finally {
      setIsLoading(false);
    }
  }

  const columns: DataGridColumn<ListingUploadRow>[] = (() => {
    const definitions = new Map(listingFieldDefinitions.map((definition) => [definition.id, definition]));
    return [
      {
        cell: ({ row }) => (
          <div
            className="workbenchRowSelectHitbox"
            onPointerDown={(event) => startRowRangeSelection(String(row.original.id), { additive: event.ctrlKey || event.metaKey, extend: event.shiftKey })}
            onPointerEnter={() => extendRowRangeSelection(String(row.original.id))}
          >
            <input
              aria-label={`${locale === "zh" ? "选择第" : "Select row"} ${row.original.position + 1}`}
              checked={selectedRowIds.has(String(row.original.id))}
              readOnly
              type="checkbox"
            />
            <span>{row.original.position + 1}</span>
          </div>
        ),
        header: () => (
          <input
            aria-label={locale === "zh" ? "选择全部非空行" : "Select all non-empty rows"}
            checked={allRowsSelected}
            onChange={(event) => toggleAllValidRows(event.target.checked)}
            type="checkbox"
          />
        ),
        id: "select",
        meta: { align: "center", className: "workbenchSelectCell", stickyLeft: 0 },
        size: 64,
      },
      ...fields.map((field, fieldIndex): DataGridColumn<ListingUploadRow> => {
        const definition = definitions.get(field)!;
        return {
          cell: ({ row }) => {
            const rowId = String(row.original.id);
            const rowIndex = rows.findIndex((item) => String(item.id) === rowId);
            const key = `${rowId}:${field}`;
            const value = rawValues[key] ?? listingUploadValueAsText(row.original.values, field);
            const error = listingUploadRowErrors(row.original.values, row.original.validationErrors, shopDefaults.values)[field];
            const defaultValue = listingUploadValueAsText(shopDefaults.values, field);
            const isSelected = isCellSelected(rowId, field);
            const isEditing = isCellEditing(rowId, field);
            const isExpanded = expandedCell?.rowId === rowId && expandedCell.field === field;
            const supportsExpansion = ["longText", "tags", "text"].includes(definition.type);
            const isSelectionTop = isSelected && rowIndex === uploadSelectionBounds?.startRowIndex;
            const isSelectionBottom = isSelected && rowIndex === uploadSelectionBounds?.endRowIndex;
            const isSelectionLeft = isSelected && fieldIndex === uploadSelectionBounds?.startFieldIndex;
            const isSelectionRight = isSelected && fieldIndex === uploadSelectionBounds?.endFieldIndex;
            const updateValue = (nextValue: string) => {
              setRawValues((current) => ({ ...current, [key]: nextValue }));
              updateCell(rowId, field, nextValue);
            };
            const placeholder = defaultValue
              ? `${locale === "zh" ? "默认" : "Default"}: ${defaultValue}`
              : undefined;
            return (
              <div
                className={[
                  "workbenchCell",
                  "listingUploadCell",
                  isSelected ? "selected" : "",
                  isEditing ? "editing" : "",
                  isExpanded ? "expanded" : "",
                  error ? "invalid" : "",
                  isSelectionTop ? "selection-top" : "",
                  isSelectionBottom ? "selection-bottom" : "",
                  isSelectionLeft ? "selection-left" : "",
                  isSelectionRight ? "selection-right" : "",
                ].filter(Boolean).join(" ")}
                title={error ?? undefined}
              >
                <ListingGridCellEditor
                  definition={definition}
                  editing={isEditing}
                  expanded={isExpanded}
                  field={field}
                  focusScope="listing-upload"
                  locale={locale}
                  onBlur={() => closeUploadCellEditor(row.original, field)}
                  onChange={updateValue}
                  onDoubleClick={() => openUploadCellEditor(rowId, field, supportsExpansion)}
                  onKeyDown={(event) => handleUploadCellKeyDown(event, row.original, field)}
                  onPointerDown={(event) => beginCellSelection(event, rowId, field)}
                  onPointerEnter={() => extendCellRangeSelection(rowId, field)}
                  placeholder={placeholder}
                  rowId={rowId}
                  value={value}
                />
              </div>
            );
          },
          header: definition.label[locale],
          id: field,
          meta: { className: `workbenchFieldCell field-${field}` },
          size: definition.defaultWidth,
        };
      }),
    ];
  })();

  const minWidth = columns.reduce((total, column) => total + Number(column.size ?? 160), 0);

  function syncHorizontalScroll(source: "grid" | "top") {
    if (scrollSyncSourceRef.current && scrollSyncSourceRef.current !== source) return;
    const sourceElement = source === "top" ? topScrollRef.current : gridScrollRef.current;
    const targetElement = source === "top" ? gridScrollRef.current : topScrollRef.current;
    if (!sourceElement || !targetElement) return;
    scrollSyncSourceRef.current = source;
    targetElement.scrollLeft = sourceElement.scrollLeft;
    window.requestAnimationFrame(() => {
      scrollSyncSourceRef.current = null;
    });
  }

  return (
    <div className="listingUploadSheet">
      {notice ? <div className={notice.tone === "error" ? "notice errorNotice" : "notice successNotice"}>{notice.tone === "error" ? <AlertTriangle size={16} /> : <Check size={16} />}{notice.text}</div> : null}
      <div className="listingUploadDefaultsBar">
        <div className="listingUploadDefaultsCopy">
          <span className="tinyLabel">{locale === "zh" ? "默认上新设置" : "Listing defaults"}</span>
          <p>{locale === "zh" ? "单个新建和每一行批量上传都会自动带入；表格中填写的值会覆盖默认值。" : "Applied to single-item creation and every batch row; values entered in the table override the defaults."}</p>
          <div className="listingUploadDefaultChips">
            {defaultSummary.length ? defaultSummary.map((item) => <span key={item.field}><b>{item.label}</b>{item.value}</span>) : <span className="empty">{locale === "zh" ? "尚未配置可用的默认值" : "No usable defaults configured"}</span>}
          </div>
        </div>
        <button className="button quiet compactButton" onClick={onEditDefaults} type="button"><Settings2 size={15} />{locale === "zh" ? "修改默认设置" : "Edit defaults"}</button>
      </div>
      <div className="workbenchToolbar listingUploadToolbar">
        <p>{locale === "zh" ? "按 Excel 坐标分批粘贴；空行不会加入批量上传，也不会立即上传 Etsy。" : "Paste in Excel coordinates. Empty rows are ignored and nothing is uploaded to Etsy yet."}</p>
        <span>{locale === "zh" ? `已选 ${selectedRowIds.size} 行` : `${selectedRowIds.size} selected`}</span>
        <button className="button quiet" disabled={!selectedRowIds.size || isLoading} onClick={() => void deleteSelected()} type="button"><Trash2 size={15} />{locale === "zh" ? "删除选中" : "Delete selected"}</button>
        <button className="button" disabled={!selectedRowIds.size || isLoading} onClick={() => void convertSelected()} type="button"><Send size={15} />{locale === "zh" ? "加入批量上传" : "Add to Batch upload"}</button>
      </div>
      <div
        aria-label={locale === "zh" ? "批量上传表格横向滚动" : "Batch upload horizontal scroll"}
        className="stickyHorizontalScroll listingUploadHorizontalScroll"
        onScroll={() => syncHorizontalScroll("top")}
        ref={topScrollRef}
        tabIndex={0}
      >
        <div className="stickyHorizontalScrollInner" style={{ width: Math.max(980, minWidth) }} />
      </div>
      <div className="workbenchGrid listingUploadGrid">
        {isLoading && !workspace ? <div className="listingUploadLoading"><LoaderCircle className="spin" size={18} />{locale === "zh" ? "加载批量上传表…" : "Loading batch upload…"}</div> : null}
        <DataGrid
          ariaLabel={locale === "zh" ? "批量上传" : "Batch upload"}
          className="listingWorkbenchGrid listingUploadDataGrid"
          columns={columns}
          data={rows}
          enableColumnResizing
          estimateRowHeight={48}
          fillWidth
          getRowId={(row) => String(row.id)}
          minWidth={Math.max(980, minWidth)}
          onCopy={(event) => {
            if (hasNativeTextSelection(event.target)) return;
            const text = copySelectionAsTsv();
            if (!text) return;
            event.preventDefault();
            event.clipboardData.setData("text/plain", text);
          }}
          onKeyDown={handleUploadGridKeyDown}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain");
            if (!text || !activeCell) return;
            event.preventDefault();
            void pasteAtActiveCell(text);
          }}
          onPointerUp={() => {
            stopCellRangeSelection();
            stopRowRangeSelection();
          }}
          onScroll={() => syncHorizontalScroll("grid")}
          overscan={12}
          rowClassName={(row) => isListingUploadRowEmpty(row.original.values) ? "listingUploadEmptyRow" : "listingUploadDataRow"}
          scrollContainerRef={gridScrollRef}
        />
      </div>
      <div className="workbenchPager"><span>{locale === "zh" ? `${rows.length} 个持久化行位（最低 50 行）` : `${rows.length} persistent row slots (minimum 50)`}</span></div>
    </div>
  );
}
