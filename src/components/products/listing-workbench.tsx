"use client";

import Image from "next/image";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardPaste,
  Columns3,
  Copy,
  GripVertical,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  createContext,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DataGrid, type DataGridColumn } from "@/components/shared/data-grid";
import { ListingGridCellEditor } from "@/components/products/listing-grid-cell-editor";
import { ListingUploadSheet } from "@/components/products/listing-upload-sheet";
import { hasNativeTextSelection, parseClipboardTable, useSheetEngine } from "@/components/shared/sheet-engine";
import { listingFieldDefinitions } from "@/features/products/listing-workbench-model";
import {
  MAX_LISTING_VARIATION_GROUPS,
  rebuildInventoryForVariationGroups,
  variationGroupsFromInventory,
  type ListingVariationGroupDraft,
} from "@/features/products/listing-workbench-variations";
import type { Locale } from "@/shared/i18n";
import type {
  ListingDraftPatch,
  ListingDraftValues,
  ListingDeleteAttempt,
  ListingFieldDefinition,
  ListingRowsPage,
  ListingSavedView,
  ListingSavedViewDefinition,
  ListingShopDefaults,
  ListingSort,
  ListingViewFilter,
  ListingWorkspaceRow,
} from "@/shared/types/listing-workbench";

type EditableField = Exclude<keyof ListingDraftValues, "inventory">;

type ApiError = Error & { status?: number };

type WorkbenchExpandedCellState = {
  field: EditableField;
  rowId: string;
};

type VariantGroupEditorState = {
  groups: ListingVariationGroupDraft[];
  rowId: string;
};

type ImageAltEditorState = {
  image: ListingWorkspaceRow["images"][number];
  rowId: string;
  value: string;
};

type ImageDragState = {
  index: number;
  rowId: string;
};

const editableFields = listingFieldDefinitions
  .map((field) => field.id)
  .filter((field): field is EditableField => field !== "inventory");
const defaultColumnOrder = [...editableFields];
const defaultColumnSizing = Object.fromEntries(
  listingFieldDefinitions.filter((field) => field.id !== "inventory").map((field) => [field.id, field.defaultWidth]),
);
const defaultSettingFields: EditableField[] = [
  "description",
  "tags",
  "materials",
  "price",
  "quantity",
  "taxonomyId",
  "shippingProfileId",
  "readinessStateId",
  "returnPolicyId",
  "shopSectionId",
  "whoMade",
  "whenMade",
  "type",
  "isSupply",
  "shouldAutoRenew",
  "state",
];
const defaultSettingFieldSet = new Set<EditableField>(defaultSettingFields);

const lifecycleCopy = {
  zh: {
    deleting: "删除中",
    archived: "已归档",
    changed: "已修改",
    conflict: "有冲突",
    draft: "草稿",
    failed: "发布失败",
    invalid: "需修正",
    live: "线上",
    publishing: "发布中",
    queued: "排队中",
  },
  en: {
    deleting: "Deleting",
    archived: "Archived",
    changed: "Changed",
    conflict: "Conflict",
    draft: "Draft",
    failed: "Failed",
    invalid: "Needs fixes",
    live: "Live",
    publishing: "Publishing",
    queued: "Queued",
  },
};

const systemViewCopy: Record<Locale, Record<ListingViewFilter, string>> = {
  zh: { all: "全部 Listing", attention: "待处理", changed: "草稿与已修改", failed: "发布失败", inactive: "已下架" },
  en: { all: "All listings", attention: "Needs attention", changed: "Drafts & changes", failed: "Publish failed", inactive: "Inactive" },
};

const listingStateCopy: Record<string, { en: string; zh: string }> = {
  active: { en: "Active", zh: "已上架" },
  draft: { en: "Etsy draft", zh: "线上草稿" },
  edit: { en: "Editing", zh: "编辑中" },
  expired: { en: "Expired", zh: "已过期" },
  inactive: { en: "Inactive", zh: "已下架" },
  sold_out: { en: "Sold out", zh: "已售罄" },
};

const copy = {
  zh: {
    add: "新建 Listing",
    advanced: "高级字段",
    allLoaded: "已加载全部",
    close: "关闭",
    columns: "字段",
    details: "详情",
    discard: "放弃草稿",
    empty: "当前视图没有 Listing。",
    loadMore: "加载更多",
    newView: "视图名称",
    publish: "发布选中项",
    saveView: "保存当前视图",
    search: "搜索标题、SKU 或 Listing ID",
    selected: (count: number) => `已选择 ${count} 行`,
    variants: "变体与 SKU",
  },
  en: {
    add: "New Listing",
    advanced: "Advanced fields",
    allLoaded: "All rows loaded",
    close: "Close",
    columns: "Fields",
    details: "Details",
    discard: "Discard draft",
    empty: "No listings in this view.",
    loadMore: "Load more",
    newView: "View name",
    publish: "Publish selected",
    saveView: "Save current view",
    search: "Search title, SKU, or Listing ID",
    selected: (count: number) => `${count} selected`,
    variants: "Variants and SKUs",
  },
};

const fieldById = new Map(listingFieldDefinitions.map((field) => [field.id, field]));

function draftValueAsText(values: ListingDraftValues, field: EditableField) {
  const value = values[field];
  if (field === "price") return values.price ? String(values.price.amount) : "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return String(value);
  return value === null || value === undefined ? "" : String(value);
}

function valueAsText(row: ListingWorkspaceRow, field: EditableField) {
  return draftValueAsText(row.values, field);
}

function parsedFieldValue(values: ListingDraftValues, field: EditableField, value: string): ListingDraftValues[EditableField] {
  const definition = fieldById.get(field);
  if (field === "price") {
    const amount = Number(value);
    return (Number.isFinite(amount)
      ? { amount, currency: values.price?.currency || "USD" }
      : null) as ListingDraftValues[EditableField];
  }
  if (definition?.type === "number") {
    const numberValue = Number(value);
    return (value.trim() && Number.isFinite(numberValue) ? numberValue : null) as ListingDraftValues[EditableField];
  }
  if (definition?.type === "boolean") return (value === "true") as ListingDraftValues[EditableField];
  if (definition?.type === "tags") {
    return value.split(/[,\n]+/g).map((item) => item.trim()).filter(Boolean) as ListingDraftValues[EditableField];
  }
  return value as ListingDraftValues[EditableField];
}

function defaultSettingsClipboardText(values: ListingDraftValues) {
  return JSON.stringify({
    kind: "etsy-listing-defaults",
    version: 1,
    values: { ...values, sku: "", title: "" },
  }, null, 2);
}

function isDefaultInventory(value: unknown): value is NonNullable<ListingDraftValues["inventory"]> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { products?: unknown }).products);
}

function normalizedDefaultClipboardValue(field: EditableField, rawValue: string) {
  const value = rawValue.trim();
  const normalized = value.toLocaleLowerCase();
  const aliases: Partial<Record<EditableField, Record<string, string>>> = {
    isSupply: { "0": "false", "1": "true", false: "false", no: "false", true: "true", yes: "true", 否: "false", 是: "true" },
    shouldAutoRenew: { "0": "false", "1": "true", false: "false", no: "false", true: "true", yes: "true", 否: "false", 是: "true" },
    state: { active: "active", draft: "draft", inactive: "inactive", 保存为etsy草稿: "draft", 发布时上架: "active", 发布时下架: "inactive" },
    type: { digital: "download", download: "download", physical: "physical", 实物: "physical", 数字商品: "download" },
    whoMade: { collective: "collective", i_did: "i_did", someone_else: "someone_else", 他人制作: "someone_else", 我制作: "i_did" },
  };
  return aliases[field]?.[normalized] ?? value;
}

function defaultsFromClipboardText(current: ListingDraftValues, text: string) {
  try {
    const parsed = JSON.parse(text) as { kind?: unknown; values?: unknown };
    if (parsed.kind === "etsy-listing-defaults" && parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values)) {
      const copied = parsed.values as Partial<ListingDraftValues>;
      const copiedDefaults = Object.fromEntries(defaultSettingFields
        .filter((field) => field in copied)
        .map((field) => [field, copied[field]])) as ListingDraftPatch;
      return {
        ...current,
        ...copiedDefaults,
        ...(copied.inventory === null || isDefaultInventory(copied.inventory) ? { inventory: copied.inventory } : {}),
      };
    }
  } catch {
    // Older copied settings use the row-based clipboard format below.
  }

  const rows = parseClipboardTable(text).filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) return null;
  const dataRows = rows[0]?.[0]?.trim().toLocaleLowerCase() === "field" ? rows.slice(1) : rows;
  let next = current;
  let applied = 0;

  for (const row of dataRows) {
    const field = row[0]?.trim() as EditableField;
    if (!defaultSettingFieldSet.has(field) || row.length < 2) continue;
    const rawValue = normalizedDefaultClipboardValue(field, row.slice(1).join("\t"));
    next = { ...next, [field]: parsedFieldValue(next, field, rawValue) };
    applied += 1;
  }

  return applied ? next : null;
}

function setWorkspaceField(row: ListingWorkspaceRow, field: EditableField, value: string): ListingWorkspaceRow {
  return {
    ...row,
    dirtyFields: Array.from(new Set([...row.dirtyFields, field])),
    lifecycle: row.kind === "new" ? "draft" : "changed",
    values: { ...row.values, [field]: parsedFieldValue(row.values, field, value) },
  };
}

function variationPropertyIds(inventory: NonNullable<ListingDraftValues["inventory"]>) {
  return Array.from(new Set(
    inventory.products.flatMap((product) => product.property_values.map((property) => Number(property.property_id)))
      .filter((propertyId) => Number.isInteger(propertyId) && propertyId > 0),
  ));
}

function variationDraftId(prefix: string) {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
}

function emptyVariationGroup(index: number, locale: Locale, usedPropertyIds: number[] = []): ListingVariationGroupDraft {
  const propertyId = [513, 514].find((candidate) => !usedPropertyIds.includes(candidate)) ?? 514;
  return {
    id: variationDraftId("variation-group"),
    name: locale === "zh" ? `变量 ${index + 1}` : `Option ${index + 1}`,
    propertyId,
    scaleId: null,
    values: [{ id: variationDraftId("variation-value"), value: "" }],
  };
}

type WorkbenchSelectionBounds = {
  endFieldIndex: number;
  endRowIndex: number;
  startFieldIndex: number;
  startRowIndex: number;
} | null;

type WorkbenchGridContextValue = {
  allRowsSelected: boolean;
  extendRowSelection: (event: ReactPointerEvent<HTMLDivElement>, rowId: string) => void;
  isCellEditing: (rowId: string, field: EditableField) => boolean;
  isCellExpanded: (rowId: string, field: EditableField) => boolean;
  isCellSelected: (rowId: string, field: EditableField) => boolean;
  renderFieldEditor: (row: ListingWorkspaceRow, definition: ListingFieldDefinition) => ReactNode;
  selectedRowIds: Set<string>;
  selectionBounds: WorkbenchSelectionBounds;
  startRowSelection: (event: ReactPointerEvent<HTMLDivElement>, rowId: string) => void;
  toggleAllValidRows: (checked: boolean) => void;
  toggleRowSelection: (rowId: string, checked: boolean) => void;
};

const WorkbenchGridContext = createContext<WorkbenchGridContextValue | null>(null);

function useWorkbenchGridContext() {
  const context = useContext(WorkbenchGridContext);
  if (!context) throw new Error("Workbench grid cells must be rendered inside WorkbenchGridContext.");
  return context;
}

function WorkbenchGridFieldCell({
  definition,
  fieldIndex,
  row,
  rowIndex,
}: {
  definition: ListingFieldDefinition;
  fieldIndex: number;
  row: ListingWorkspaceRow;
  rowIndex: number;
}) {
  const context = useWorkbenchGridContext();
  const field = definition.id as EditableField;
  const isSelected = context.isCellSelected(row.rowId, field);
  const isEditing = context.isCellEditing(row.rowId, field);
  const isExpanded = context.isCellExpanded(row.rowId, field);
  const hasValidationError = Boolean(row.validationErrors[definition.id]);
  const bounds = context.selectionBounds;
  const isSelectionTop = isSelected && rowIndex === bounds?.startRowIndex;
  const isSelectionBottom = isSelected && rowIndex === bounds?.endRowIndex;
  const isSelectionLeft = isSelected && fieldIndex === bounds?.startFieldIndex;
  const isSelectionRight = isSelected && fieldIndex === bounds?.endFieldIndex;

  return (
    <div
      className={[
        "workbenchCell",
        hasValidationError ? "invalid" : "",
        isSelected ? "selected" : "",
        isEditing ? "editing" : "",
        isExpanded ? "expanded" : "",
        isSelectionTop ? "selection-top" : "",
        isSelectionBottom ? "selection-bottom" : "",
        isSelectionLeft ? "selection-left" : "",
        isSelectionRight ? "selection-right" : "",
      ].filter(Boolean).join(" ")}
      title={row.validationErrors[definition.id] ?? ""}
    >
      {context.renderFieldEditor(row, definition)}
    </div>
  );
}

function WorkbenchGridRowCheckbox({ rowId, rowIndex }: { rowId: string; rowIndex: number }) {
  const context = useWorkbenchGridContext();
  const selected = context.selectedRowIds.has(rowId);
  return (
    <div
      className={selected ? "workbenchRowSelectHandle selected" : "workbenchRowSelectHandle"}
      onPointerDown={(event) => context.startRowSelection(event, rowId)}
      onPointerEnter={(event) => context.extendRowSelection(event, rowId)}
    >
      <input
        aria-label={`${rowIndex + 1}`}
        checked={selected}
        onClick={(event) => { if (event.detail > 0) event.preventDefault(); }}
        readOnly
        type="checkbox"
      />
    </div>
  );
}

function WorkbenchGridSelectAllCheckbox() {
  const context = useWorkbenchGridContext();
  return <input aria-label="Select all" checked={context.allRowsSelected} onChange={(event) => context.toggleAllValidRows(event.target.checked)} type="checkbox" />;
}

function statusTone(lifecycle: ListingWorkspaceRow["lifecycle"]) {
  if (["failed", "conflict", "invalid"].includes(lifecycle)) return "danger";
  if (["queued", "publishing", "deleting"].includes(lifecycle)) return "warning";
  if (["changed", "draft"].includes(lifecycle)) return "info";
  return "success";
}

function formatDate(value: string, locale: Locale) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() === 0) return "-";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

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
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`) as ApiError;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchFormJson<T>(url: string, body: FormData): Promise<T> {
  const csrfToken = typeof document === "undefined"
    ? ""
    : (document.getElementById("app-csrf-token") as HTMLInputElement | null)?.value ?? "";
  const response = await fetch(url, { body, headers: { "x-csrf-token": csrfToken }, method: "POST" });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`) as ApiError;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function ListingWorkbench({
  initialPage,
  initialSearch = "",
  initialSort = "updated_desc",
  initialState = "",
  initialView = "all",
  locale,
  savedViews: initialSavedViews,
  selectedShopId,
  shopDefaults: initialShopDefaults,
}: {
  initialPage: ListingRowsPage;
  initialSearch?: string;
  initialSort?: ListingSort;
  initialState?: string;
  initialView?: ListingViewFilter;
  locale: Locale;
  savedViews: ListingSavedView[];
  selectedShopId: number;
  shopDefaults: ListingShopDefaults;
}) {
  const labels = copy[locale];
  const [view, setView] = useState<ListingViewFilter>(initialView);
  const [workspaceMode, setWorkspaceMode] = useState<"listings" | "upload">(
    initialView === "changed" ? "upload" : "listings",
  );
  const [sort, setSort] = useState<ListingSort>(initialSort);
  const [stateFilter, setStateFilter] = useState(initialState);
  const [listingStates, setListingStates] = useState(initialPage.states);
  const [search, setSearch] = useState(initialSearch);
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [savedViews, setSavedViews] = useState(initialSavedViews);
  const [visibleFields, setVisibleFields] = useState<Set<keyof ListingDraftValues>>(
    () => new Set(listingFieldDefinitions.filter((field) => field.defaultVisible).map((field) => field.id)),
  );
  const [columnOrder, setColumnOrder] = useState<EditableField[]>(defaultColumnOrder);
  const [columnSizing, setColumnSizing] = useState<Record<string, number>>(defaultColumnSizing);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [isLoading, setIsLoading] = useState(false);
  const [isMediaBusy, setIsMediaBusy] = useState(false);
  const [shopDefaults, setShopDefaults] = useState(initialShopDefaults);
  const [defaultEditor, setDefaultEditor] = useState(initialShopDefaults.values);
  const [defaultVariationGroups, setDefaultVariationGroups] = useState<ListingVariationGroupDraft[]>(() => variationGroupsFromInventory(initialShopDefaults.values.inventory));
  const [defaultClipboardNotice, setDefaultClipboardNotice] = useState<string | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showUploadImporter, setShowUploadImporter] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [activeImagePreviewUrl, setActiveImagePreviewUrl] = useState<string | null>(null);
  const [imageAltEditor, setImageAltEditor] = useState<ImageAltEditorState | null>(null);
  const [imageDrag, setImageDrag] = useState<ImageDragState | null>(null);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [expandedCell, setExpandedCell] = useState<WorkbenchExpandedCellState | null>(null);
  const [variantCombinationEditorRowId, setVariantCombinationEditorRowId] = useState<string | null>(null);
  const [variantGroupEditor, setVariantGroupEditor] = useState<VariantGroupEditorState | null>(null);
  const [viewName, setViewName] = useState("");
  const [activeSavedViewId, setActiveSavedViewId] = useState<number | null>(null);
  const [activeAttemptIds, setActiveAttemptIds] = useState<number[]>([]);
  const [activeDeleteAttemptIds, setActiveDeleteAttemptIds] = useState<number[]>([]);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const firstQueryEffect = useRef(true);
  const workbenchCellSelectionDidMoveRef = useRef(false);
  const pendingChangesRef = useRef<Map<string, ListingDraftPatch>>(new Map());
  const saveTimersRef = useRef<Map<string, number>>(new Map());
  const saveChainsRef = useRef<Map<string, Promise<void>>>(new Map());
  const flushRowRef = useRef<(rowId: string) => Promise<void>>(async () => undefined);
  const sheetFields = useMemo(
    () => columnOrder.filter((field) => visibleFields.has(field)),
    [columnOrder, visibleFields],
  );
  const sheet = useSheetEngine<ListingWorkspaceRow, EditableField>({
    fields: sheetFields,
    getFieldValue: valueAsText,
    getRowId: (row) => row.rowId,
    initialRows: initialPage.rows,
    setFieldValue: setWorkspaceField,
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
    replaceRows,
    rows,
    rowsRef,
    selection,
    setActiveCell,
    setEditingCell,
    setSelectedRowIds,
    selectedRowIds,
    startCellRangeSelection,
    extendCellRangeSelection,
    stopCellRangeSelection,
    toggleAllValidRows,
    toggleRowSelection,
    updateCell,
  } = sheet;
  const hydrateRowsFnRef = useRef(hydrateRows);
  const replaceRowsFnRef = useRef(replaceRows);
  const rowSelectionAnchorRef = useRef<string | null>(null);
  const rowSelectionDragRef = useRef<{
    anchorRowId: string;
    baseSelection: Set<string>;
    mode: "deselect" | "select";
  } | null>(null);
  const nextCursorRef = useRef(initialPage.nextCursor);
  useEffect(() => {
    hydrateRowsFnRef.current = hydrateRows;
    replaceRowsFnRef.current = replaceRows;
  }, [hydrateRows, replaceRows]);

  useEffect(() => {
    function stopRowSelection() {
      rowSelectionDragRef.current = null;
    }
    window.addEventListener("pointerup", stopRowSelection);
    window.addEventListener("pointercancel", stopRowSelection);
    return () => {
      window.removeEventListener("pointerup", stopRowSelection);
      window.removeEventListener("pointercancel", stopRowSelection);
    };
  }, []);

  const activeRow = activeRowId ? rows.find((row) => row.rowId === activeRowId) ?? null : null;
  const isVariantCombinationEditorOpen = Boolean(activeRowId && variantCombinationEditorRowId === activeRowId);
  const activeVariantGroupEditor = activeRow && variantGroupEditor?.rowId === activeRow.rowId ? variantGroupEditor : null;
  const selectedDraftRows = rows.filter((row) => selectedRowIds.has(row.rowId) && row.draftId && row.draftVersion);
  const selectedRows = rows.filter((row) => selectedRowIds.has(row.rowId));
  const selectedRowsIncludeLocked = selectedRows.some((row) => ["queued", "publishing", "deleting"].includes(row.lifecycle));
  const selectionBounds = useMemo(() => {
    if (!selection) return null;

    const anchorRowIndex = rows.findIndex((row) => row.rowId === selection.anchor.rowId);
    const focusRowIndex = rows.findIndex((row) => row.rowId === selection.focus.rowId);
    const anchorFieldIndex = sheetFields.indexOf(selection.anchor.field);
    const focusFieldIndex = sheetFields.indexOf(selection.focus.field);

    if (anchorRowIndex < 0 || focusRowIndex < 0 || anchorFieldIndex < 0 || focusFieldIndex < 0) return null;

    return {
      endFieldIndex: Math.max(anchorFieldIndex, focusFieldIndex),
      endRowIndex: Math.max(anchorRowIndex, focusRowIndex),
      startFieldIndex: Math.min(anchorFieldIndex, focusFieldIndex),
      startRowIndex: Math.min(anchorRowIndex, focusRowIndex),
    };
  }, [rows, selection, sheetFields]);

  function applyRowSelectionDrag(focusRowId: string) {
    const drag = rowSelectionDragRef.current;
    if (!drag) return;
    const anchorIndex = rowsRef.current.findIndex((row) => row.rowId === drag.anchorRowId);
    const focusIndex = rowsRef.current.findIndex((row) => row.rowId === focusRowId);
    if (anchorIndex < 0 || focusIndex < 0) return;
    const startIndex = Math.min(anchorIndex, focusIndex);
    const endIndex = Math.max(anchorIndex, focusIndex);
    const next = new Set(drag.baseSelection);
    for (const row of rowsRef.current.slice(startIndex, endIndex + 1)) {
      if (drag.mode === "select") next.add(row.rowId);
      else next.delete(row.rowId);
    }
    setSelectedRowIds(next);
  }

  function startWorkbenchRowSelection(event: ReactPointerEvent<HTMLDivElement>, rowId: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.querySelector("input")?.focus({ preventScroll: true });
    const anchorRowId = event.shiftKey && rowSelectionAnchorRef.current ? rowSelectionAnchorRef.current : rowId;
    if (!event.shiftKey) rowSelectionAnchorRef.current = rowId;
    rowSelectionDragRef.current = {
      anchorRowId,
      baseSelection: new Set(selectedRowIds),
      mode: selectedRowIds.has(rowId) && !event.shiftKey ? "deselect" : "select",
    };
    applyRowSelectionDrag(rowId);
  }

  function extendWorkbenchRowSelection(event: ReactPointerEvent<HTMLDivElement>, rowId: string) {
    if (!rowSelectionDragRef.current) return;
    if (event.buttons === 0) {
      rowSelectionDragRef.current = null;
      return;
    }
    applyRowSelectionDrag(rowId);
  }

  function stopWorkbenchRowSelection() {
    rowSelectionDragRef.current = null;
  }

  function toggleWorkbenchRowSelection(rowId: string, checked: boolean) {
    rowSelectionAnchorRef.current = rowId;
    toggleRowSelection(rowId, checked);
  }

  useEffect(() => {
    if (!activeImagePreviewUrl) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveImagePreviewUrl(null);
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [activeImagePreviewUrl]);

  const replaceRow = useCallback((nextRow: ListingWorkspaceRow) => {
    replaceRowsFnRef.current(rowsRef.current.map((row) => (row.rowId === nextRow.rowId ? nextRow : row)), { recordHistory: false });
  }, [rowsRef]);

  const flushRow = useCallback(async (rowId: string) => {
    const timer = saveTimersRef.current.get(rowId);
    if (timer) window.clearTimeout(timer);
    saveTimersRef.current.delete(rowId);
    const changes = pendingChangesRef.current.get(rowId);
    if (!changes || !Object.keys(changes).length) return saveChainsRef.current.get(rowId) ?? Promise.resolve();
    pendingChangesRef.current.delete(rowId);
    const previous = saveChainsRef.current.get(rowId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = rowsRef.current.find((row) => row.rowId === rowId);
      if (!current) return;
      try {
        const payload = current.draftId && current.draftVersion
          ? await fetchJson<{ row: ListingWorkspaceRow }>(`/api/listing-workbench/drafts/${current.draftId}`, {
              body: JSON.stringify({ changes, expectedVersion: current.draftVersion }),
              method: "PATCH",
            })
          : await fetchJson<{ row: ListingWorkspaceRow }>("/api/listing-workbench/drafts", {
              body: JSON.stringify({ changes, listingId: current.listingId, shopId: selectedShopId }),
              method: "POST",
            });
        replaceRow(payload.row);
        setNotice(null);
      } catch (error) {
        pendingChangesRef.current.set(rowId, {
          ...changes,
          ...(pendingChangesRef.current.get(rowId) ?? {}),
        });
        const status = (error as ApiError).status;
        if (!status || status >= 500) {
          const retryTimer = window.setTimeout(() => void flushRowRef.current(rowId), 1500);
          saveTimersRef.current.set(rowId, retryTimer);
        } else if (status === 409) {
          replaceRowsFnRef.current(
            rowsRef.current.map((row) => row.rowId === rowId ? { ...row, lifecycle: "conflict" } : row),
            { recordHistory: false },
          );
        }
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "Draft save failed." });
      }
    });
    saveChainsRef.current.set(rowId, next);
    await next;
  }, [replaceRow, rowsRef, selectedShopId]);

  useEffect(() => {
    flushRowRef.current = flushRow;
  }, [flushRow]);

  function queueSave(rowId: string, changes: ListingDraftPatch) {
    pendingChangesRef.current.set(rowId, { ...(pendingChangesRef.current.get(rowId) ?? {}), ...changes });
    const currentTimer = saveTimersRef.current.get(rowId);
    if (currentTimer) window.clearTimeout(currentTimer);
    saveTimersRef.current.set(rowId, window.setTimeout(() => void flushRow(rowId), 500));
  }

  function editField(row: ListingWorkspaceRow, field: EditableField, value: string) {
    if (["queued", "publishing"].includes(row.lifecycle)) return;
    updateCell(row.rowId, field, value);
    const nextRow = rowsRef.current.find((item) => item.rowId === row.rowId);
    if (!nextRow) return;
    queueSave(row.rowId, { [field]: nextRow.values[field] } as ListingDraftPatch);
  }

  function isWorkbenchFieldDisabled(row: ListingWorkspaceRow, field: EditableField) {
    return (
      ["queued", "publishing"].includes(row.lifecycle) ||
      (field === "sku" && Boolean(row.values.inventory?.sku_on_property?.length))
    );
  }

  function focusWorkbenchCellEditor(rowId: string, field: EditableField, selectValue = false) {
    window.requestAnimationFrame(() => {
      const editor = document.querySelector(`[data-grid-focus-key="workbench:${rowId}:${field}"]`);

      if (
        editor instanceof HTMLInputElement ||
        editor instanceof HTMLTextAreaElement ||
        editor instanceof HTMLSelectElement
      ) {
        editor.focus({ preventScroll: true });

        if (selectValue && (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement)) {
          editor.select();
        }
      }
    });
  }

  function enterWorkbenchCellEdit(row: ListingWorkspaceRow, field: EditableField, selectValue = false) {
    if (isWorkbenchFieldDisabled(row, field)) return;
    setActiveCell({ field, rowId: row.rowId });
    setEditingCell({ field, rowId: row.rowId });
    focusWorkbenchCellEditor(row.rowId, field, selectValue);
  }

  function exitWorkbenchCellEdit(rowId: string, field: EditableField) {
    setEditingCell((current) =>
      current?.rowId === rowId && current.field === field ? null : current,
    );
  }

  function focusWorkbenchGrid(target: HTMLElement) {
    const grid = target.closest<HTMLElement>(".dataGrid");
    window.requestAnimationFrame(() => grid?.focus({ preventScroll: true }));
  }

  function handleWorkbenchEditorKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
    row: ListingWorkspaceRow,
    definition: ListingFieldDefinition,
    inDrawer: boolean,
  ) {
    if (inDrawer) return;

    const field = definition.id as EditableField;
    if (!isCellEditing(row.rowId, field)) return;
    const isExpanded = expandedCell?.rowId === row.rowId && expandedCell.field === field;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setExpandedCell((current) =>
        current?.rowId === row.rowId && current.field === field ? null : current,
      );
      exitWorkbenchCellEdit(row.rowId, field);
      focusWorkbenchGrid(event.currentTarget);
      return;
    }

    if (
      event.key === "Tab" ||
      (event.key === "Enter" && (isExpanded ? !event.shiftKey : definition.type !== "longText"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      void flushRow(row.rowId);
      setExpandedCell((current) =>
        current?.rowId === row.rowId && current.field === field ? null : current,
      );
      exitWorkbenchCellEdit(row.rowId, field);
      moveActiveCell(event.key === "Enter" ? 1 : 0, event.key === "Tab" ? (event.shiftKey ? -1 : 1) : 0);
      focusWorkbenchGrid(event.currentTarget);
    }
  }

  function handleWorkbenchGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!editingCell && activeCell && (event.key === "Enter" || event.key === "F2")) {
      const row = rowsRef.current.find((item) => item.rowId === activeCell.rowId);
      if (!row || isWorkbenchFieldDisabled(row, activeCell.field)) return;

      event.preventDefault();
      enterWorkbenchCellEdit(row, activeCell.field, true);
      return;
    }

    if (
      !editingCell &&
      activeCell &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const row = rowsRef.current.find((item) => item.rowId === activeCell.rowId);
      if (!row || isWorkbenchFieldDisabled(row, activeCell.field)) return;

      event.preventDefault();
      const definition = fieldById.get(activeCell.field);
      if (definition?.type !== "select" && definition?.type !== "boolean") {
        editField(row, activeCell.field, event.key);
      }
      enterWorkbenchCellEdit(row, activeCell.field);
      return;
    }

    handleGridKeyDown(event);
  }

  const loadRows = useCallback(async (append: boolean, cursorOverride?: string | null) => {
    if (!append && pendingChangesRef.current.size) {
      await Promise.all(Array.from(pendingChangesRef.current.keys()).map((rowId) => flushRow(rowId)));
      if (pendingChangesRef.current.size) return;
    }
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        limit: "100",
        search,
        shopId: String(selectedShopId),
        sort,
        view,
      });
      if (workspaceMode === "listings" && stateFilter) params.set("state", stateFilter);
      const cursor = cursorOverride ?? (append ? nextCursorRef.current : null);
      if (cursor) params.set("cursor", cursor);
      const page = await fetchJson<ListingRowsPage>(`/api/listing-workbench/rows?${params.toString()}`);
      if (append) {
        const existing = new Set(rowsRef.current.map((row) => row.rowId));
        replaceRowsFnRef.current([...rowsRef.current, ...page.rows.filter((row) => !existing.has(row.rowId))], { recordHistory: false });
      } else {
        hydrateRowsFnRef.current(page.rows);
      }
      nextCursorRef.current = page.nextCursor;
      setHasMore(page.hasMore);
      setListingStates(page.states);
      const url = new URL(window.location.href);
      url.searchParams.set("workbenchView", view);
      url.searchParams.set("workbenchSort", sort);
      if (workspaceMode === "listings" && stateFilter) url.searchParams.set("workbenchState", stateFilter); else url.searchParams.delete("workbenchState");
      if (search) url.searchParams.set("workbenchSearch", search); else url.searchParams.delete("workbenchSearch");
      window.history.replaceState(null, "", url);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Listing query failed." });
    } finally {
      setIsLoading(false);
    }
  }, [flushRow, rowsRef, search, selectedShopId, sort, stateFilter, view, workspaceMode]);

  useEffect(() => {
    if (firstQueryEffect.current) {
      firstQueryEffect.current = false;
      return;
    }
    void loadRows(false, null);
  }, [loadRows, sort, view]);

  useEffect(() => () => {
    for (const timer of saveTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!activeAttemptIds.length) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await fetchJson<{ attempts: Array<{ attemptId: number; draftId: number; error: string | null; jobId: number | null; status: string }> }>(
          `/api/listing-workbench/publish?attemptIds=${activeAttemptIds.join(",")}`,
        );
        const active = result.attempts.filter((attempt) => attempt.status === "queued" || attempt.status === "running");
        setActiveAttemptIds(active.map((attempt) => attempt.attemptId));
        replaceRowsFnRef.current(rowsRef.current.map((row) => {
          const attempt = result.attempts.find((item) => item.draftId === row.draftId);
          if (!attempt) return row;
          const lifecycle = attempt.status === "running" ? "publishing" : attempt.status === "queued" ? "queued" : attempt.status === "conflict" ? "conflict" : attempt.status === "failed" ? "failed" : row.lifecycle;
          return { ...row, lifecycle, publish: { attemptId: attempt.attemptId, error: attempt.error, jobId: attempt.jobId, status: attempt.status as NonNullable<ListingWorkspaceRow["publish"]>["status"] } };
        }), { recordHistory: false });
        if (!active.length) void loadRows(false, null);
      } catch {
        // Keep the visible row state and retry on the next interval.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeAttemptIds, loadRows, rowsRef]);

  useEffect(() => {
    if (!activeDeleteAttemptIds.length) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await fetchJson<{ attempts: ListingDeleteAttempt[] }>(
          `/api/listing-workbench/delete?attemptIds=${activeDeleteAttemptIds.join(",")}`,
        );
        const active = result.attempts.filter((attempt) => attempt.status === "queued" || attempt.status === "running");
        setActiveDeleteAttemptIds(active.map((attempt) => attempt.attemptId));
        replaceRowsFnRef.current(rowsRef.current.map((row) => {
          const attempt = result.attempts.find((item) => item.listingId === row.listingId);
          if (!attempt || !["queued", "running"].includes(attempt.status)) return row;
          return { ...row, lifecycle: "deleting" };
        }), { recordHistory: false });
        if (!active.length) {
          const failed = result.attempts.filter((attempt) => attempt.status === "failed");
          setNotice(failed.length
            ? { tone: "error", text: locale === "zh" ? `${failed.length} 个 Listing 删除失败，商品已保留。` : `${failed.length} Listings could not be deleted and were retained.` }
            : { tone: "success", text: locale === "zh" ? "选中的 Etsy Listing 已删除。" : "Selected Etsy Listings deleted." });
          await loadRows(false, null);
        }
      } catch {
        // Retry while the attempts are active.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeDeleteAttemptIds, loadRows, locale, rowsRef]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setSearch(searchInput.trim());
  }

  async function createDraft() {
    setIsLoading(true);
    try {
      const result = await fetchJson<{ row: ListingWorkspaceRow }>("/api/listing-workbench/drafts", {
        body: JSON.stringify({ shopId: selectedShopId }),
        method: "POST",
      });
      replaceRowsFnRef.current([result.row, ...rowsRef.current], { recordHistory: false });
      setActiveRowId(result.row.rowId);
      setWorkspaceMode("upload");
      setView("changed");
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Draft creation failed." });
    } finally {
      setIsLoading(false);
    }
  }

  function openDefaultsEditor() {
    setDefaultEditor(shopDefaults.values);
    setDefaultVariationGroups(variationGroupsFromInventory(shopDefaults.values.inventory));
    setDefaultClipboardNotice(null);
    setShowDefaults(true);
  }

  function defaultValuesWithVariations() {
    return {
      ...defaultEditor,
      inventory: defaultVariationGroups.length
        ? rebuildInventoryForVariationGroups(defaultEditor, defaultEditor.inventory, defaultVariationGroups)
        : null,
      sku: "",
      title: "",
    } satisfies ListingDraftValues;
  }

  function updateDefaultVariationGroups(updater: (groups: ListingVariationGroupDraft[]) => ListingVariationGroupDraft[]) {
    setDefaultVariationGroups((current) => updater(current));
  }

  function addDefaultVariationGroup() {
    updateDefaultVariationGroups((groups) => groups.length >= MAX_LISTING_VARIATION_GROUPS
      ? groups
      : [...groups, emptyVariationGroup(groups.length, locale, groups.map((group) => group.propertyId))]);
  }

  function removeDefaultVariationGroup(groupId: string) {
    updateDefaultVariationGroups((groups) => groups.filter((group) => group.id !== groupId));
  }

  function updateDefaultVariationGroupName(groupId: string, name: string) {
    updateDefaultVariationGroups((groups) => groups.map((group) => group.id === groupId ? { ...group, name } : group));
  }

  function addDefaultVariationValue(groupId: string) {
    updateDefaultVariationGroups((groups) => groups.map((group) => group.id === groupId ? {
      ...group,
      values: [...group.values, { id: variationDraftId("default-variation-value"), value: "" }],
    } : group));
  }

  function removeDefaultVariationValue(groupId: string, valueId: string) {
    updateDefaultVariationGroups((groups) => groups.map((group) => {
      if (group.id !== groupId || group.values.length <= 1) return group;
      return { ...group, values: group.values.filter((value) => value.id !== valueId) };
    }));
  }

  function updateDefaultVariationValue(groupId: string, valueId: string, nextValue: string) {
    updateDefaultVariationGroups((groups) => groups.map((group) => group.id === groupId ? {
      ...group,
      values: group.values.map((value) => value.id === valueId ? { ...value, value: nextValue } : value),
    } : group));
  }

  async function copyDefaultSettings() {
    let values: ListingDraftValues;
    try {
      values = defaultValuesWithVariations();
    } catch (error) {
      setDefaultClipboardNotice(error instanceof Error ? error.message : "Invalid default variations.");
      return;
    }
    try {
      await navigator.clipboard.writeText(defaultSettingsClipboardText(values));
      setDefaultClipboardNotice(locale === "zh" ? "整套默认设置已复制。" : "All defaults copied.");
    } catch {
      setDefaultClipboardNotice(locale === "zh" ? "浏览器未允许读取剪贴板，请使用 Ctrl/Cmd+C。" : "Clipboard access was denied. Use Ctrl/Cmd+C instead.");
    }
  }

  async function copyListingSettings(row: ListingWorkspaceRow) {
    try {
      await navigator.clipboard.writeText(defaultSettingsClipboardText({
        ...row.values,
        sku: "",
        title: "",
      }));
      setNotice({ tone: "success", text: locale === "zh" ? "该 Listing 的设置已复制，可在店铺默认上新设置中粘贴使用。" : "Listing settings copied. Paste them in shop listing defaults." });
    } catch {
      setNotice({ tone: "error", text: locale === "zh" ? "浏览器未允许写入剪贴板，请检查浏览器权限。" : "Clipboard access was denied. Check your browser permissions." });
    }
  }

  async function pasteDefaultSettings() {
    try {
      const text = await navigator.clipboard.readText();
      const next = defaultsFromClipboardText(defaultEditor, text);
      if (!next) {
        setDefaultClipboardNotice(locale === "zh" ? "剪贴板中没有可识别的默认设置。" : "No recognizable defaults were found in the clipboard.");
        return;
      }
      setDefaultEditor(next);
      setDefaultVariationGroups(variationGroupsFromInventory(next.inventory));
      setDefaultClipboardNotice(locale === "zh" ? "默认设置已粘贴，请检查后保存。" : "Defaults pasted. Review and save them.");
    } catch {
      setDefaultClipboardNotice(locale === "zh" ? "浏览器未允许粘贴，请在字段中使用 Ctrl/Cmd+V。" : "Clipboard access was denied. Paste directly into a field instead.");
    }
  }

  async function saveDefaults(event: FormEvent) {
    event.preventDefault();
    let values: ListingDraftValues;
    try {
      values = defaultValuesWithVariations();
    } catch (error) {
      setDefaultClipboardNotice(error instanceof Error ? error.message : "Invalid default variations.");
      return;
    }
    setIsLoading(true);
    try {
      const result = await fetchJson<ListingShopDefaults>("/api/listing-workbench/defaults", {
        body: JSON.stringify({ expectedVersion: shopDefaults.version, shopId: selectedShopId, values }),
        method: "PATCH",
      });
      setShopDefaults(result);
      setDefaultEditor(result.values);
      setDefaultVariationGroups(variationGroupsFromInventory(result.values.inventory));
      setShowDefaults(false);
      setNotice({ tone: "success", text: locale === "zh" ? "店铺默认上新设置已保存。" : "Shop listing defaults saved." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Defaults save failed." });
    } finally {
      setIsLoading(false);
    }
  }

  async function publishRowIds(rowIds: string[]) {
    await Promise.all(rowIds.map((rowId) => flushRow(rowId)));
    if (rowIds.some((rowId) => pendingChangesRef.current.has(rowId))) {
      setNotice({ tone: "error", text: locale === "zh" ? "仍有未保存或冲突的修改，暂时不能发布。" : "Unsaved or conflicting changes must be resolved before publishing." });
      return;
    }
    const rowIdSet = new Set(rowIds);
    const currentRows = rowsRef.current.filter((row) => rowIdSet.has(row.rowId) && row.draftId && row.draftVersion);
    if (!currentRows.length) return;
    setIsLoading(true);
    try {
      const result = await fetchJson<{ attempts: Array<{ attemptId: number; draftId: number; jobId: number | null; status: string }> }>(
        "/api/listing-workbench/publish",
        {
          body: JSON.stringify({
            confirmation: "CONFIRM",
            items: currentRows.map((row) => ({ draftId: row.draftId, version: row.draftVersion })),
            shopId: selectedShopId,
          }),
          method: "POST",
        },
      );
      setActiveAttemptIds(result.attempts.filter((attempt) => attempt.status === "queued").map((attempt) => attempt.attemptId));
      replaceRowsFnRef.current(rowsRef.current.map((row) => {
        const attempt = result.attempts.find((item) => item.draftId === row.draftId);
        if (!attempt) return row;
        return {
          ...row,
          lifecycle: attempt.status === "conflict" ? "conflict" : "queued",
          publish: { attemptId: attempt.attemptId, error: null, jobId: attempt.jobId, status: attempt.status as NonNullable<ListingWorkspaceRow["publish"]>["status"] },
        };
      }), { recordHistory: false });
      setNotice({ tone: "success", text: locale === "zh" ? "发布任务已进入队列。" : "Publish jobs queued." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Publish failed." });
    } finally {
      setIsLoading(false);
    }
  }

  async function publishSelected() {
    await requestPublishRowIds(Array.from(selectedRowIds));
  }

  async function requestPublishRowIds(rowIds: string[]) {
    const selected = rowsRef.current.filter((row) => rowIds.includes(row.rowId) && row.draftId);
    if (!selected.length) return;
    const includesExisting = selected.some((row) => Boolean(row.listingId));
    const message = includesExisting
      ? locale === "zh"
        ? `确认把选中的 ${selected.length} 项修改同步到 Etsy？`
        : `Sync changes for ${selected.length} selected Listings to Etsy?`
      : locale === "zh"
        ? `确认把选中的 ${selected.length} 个产品上传到 Etsy？`
        : `Upload ${selected.length} selected products to Etsy?`;
    if (!window.confirm(message)) return;
    await publishRowIds(rowIds);
  }

  async function discardDraft(row: ListingWorkspaceRow) {
    if (!row.draftId) return;
    const shouldOptimisticallyRemove = view !== "all";
    const previousRows = rowsRef.current;
    const previousSelectedRowIds = new Set(selectedRowIds);
    const previousActiveRowId = activeRowId;
    const previousExpandedCell = expandedCell;

    if (shouldOptimisticallyRemove) {
      const timer = saveTimersRef.current.get(row.rowId);
      if (timer) window.clearTimeout(timer);
      saveTimersRef.current.delete(row.rowId);
      replaceRowsFnRef.current(previousRows.filter((item) => item.rowId !== row.rowId), { recordHistory: false });
      setActiveRowId(null);
      if (expandedCell?.rowId === row.rowId) setExpandedCell(null);
    }

    try {
      await fetchJson(`/api/listing-workbench/drafts/${row.draftId}/discard`, { body: "{}", method: "POST" });
      pendingChangesRef.current.delete(row.rowId);
      setActiveRowId(null);
      if (!shouldOptimisticallyRemove || row.listingId) await loadRows(false, null);
    } catch (error) {
      if (shouldOptimisticallyRemove) {
        replaceRowsFnRef.current(previousRows, { recordHistory: false });
        setSelectedRowIds(previousSelectedRowIds);
        setActiveRowId(previousActiveRowId);
        setExpandedCell(previousExpandedCell);
        if (pendingChangesRef.current.has(row.rowId)) {
          saveTimersRef.current.set(row.rowId, window.setTimeout(() => void flushRowRef.current(row.rowId), 500));
        }
      }
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Discard failed." });
    }
  }

  async function deleteListingRows(rowsToDelete: ListingWorkspaceRow[], confirmation = "") {
    if (!rowsToDelete.length || rowsToDelete.some((row) => ["queued", "publishing", "deleting"].includes(row.lifecycle))) return;
    const previousRows = rowsRef.current;
    const previousSelectedRowIds = new Set(selectedRowIds);
    const previousActiveRowId = activeRowId;
    const previousExpandedCell = expandedCell;
    const localRowIds = new Set(
      workspaceMode === "listings"
        ? []
        : rowsToDelete
            .filter((row) => row.draftId && (row.kind === "existing" || !row.listingId))
            .map((row) => row.rowId),
    );

    if (localRowIds.size) {
      for (const rowId of localRowIds) {
        const timer = saveTimersRef.current.get(rowId);
        if (timer) window.clearTimeout(timer);
        saveTimersRef.current.delete(rowId);
      }
      replaceRowsFnRef.current(previousRows.filter((row) => !localRowIds.has(row.rowId)), { recordHistory: false });
      setSelectedRowIds(new Set(Array.from(selectedRowIds).filter((rowId) => !localRowIds.has(rowId))));
      if (activeRowId && localRowIds.has(activeRowId)) setActiveRowId(null);
      if (expandedCell && localRowIds.has(expandedCell.rowId)) setExpandedCell(null);
    }

    setIsLoading(true);
    try {
      const result = await fetchJson<{
        results: Array<{
          attemptId: number | null;
          draftId: number | null;
          error: string | null;
          jobId: number | null;
          listingId: number | null;
          status: "discarded" | "queued" | "rejected";
        }>;
      }>("/api/listing-workbench/delete", {
        body: JSON.stringify({
          confirmation,
          items: rowsToDelete.map((row) => ({ draftId: row.draftId, listingId: row.listingId })),
          mode: workspaceMode === "listings" ? "all" : "changed",
          shopId: selectedShopId,
        }),
        method: "POST",
      });
      const attemptIds = result.results.flatMap((item) => item.status === "queued" && item.attemptId ? [item.attemptId] : []);
      const rejected = result.results.filter((item) => item.status === "rejected");
      const discardedDraftIds = new Set(result.results.flatMap((item) => item.status === "discarded" && item.draftId ? [item.draftId] : []));
      for (const row of rowsToDelete) {
        if (row.draftId && discardedDraftIds.has(row.draftId)) pendingChangesRef.current.delete(row.rowId);
      }
      setActiveDeleteAttemptIds(attemptIds);
      setSelectedRowIds(new Set());
      setShowDeleteConfirmation(false);
      setDeleteConfirmation("");
      if (attemptIds.length) {
        const listingIds = new Set(result.results.flatMap((item) => item.status === "queued" && item.listingId ? [item.listingId] : []));
        replaceRowsFnRef.current(rowsRef.current.map((row) => row.listingId && listingIds.has(row.listingId) ? { ...row, lifecycle: "deleting" } : row), { recordHistory: false });
      }
      if (rejected.length) {
        setNotice({ tone: "error", text: rejected.map((item) => item.error).filter(Boolean).join(" ") });
      } else if (!attemptIds.length) {
        setNotice({ tone: "success", text: locale === "zh" ? "已放弃选中的本地草稿或修改。" : "Selected local drafts or changes discarded." });
      }
      if (!attemptIds.length || rejected.length) await loadRows(false, null);
    } catch (error) {
      if (localRowIds.size) {
        replaceRowsFnRef.current(previousRows, { recordHistory: false });
        setSelectedRowIds(previousSelectedRowIds);
        setActiveRowId(previousActiveRowId);
        setExpandedCell(previousExpandedCell);
        for (const rowId of localRowIds) {
          if (pendingChangesRef.current.has(rowId)) {
            saveTimersRef.current.set(rowId, window.setTimeout(() => void flushRowRef.current(rowId), 500));
          }
        }
      }
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Listing deletion failed." });
    } finally {
      setIsLoading(false);
    }
  }

  function requestDeleteSelected() {
    if (!selectedRows.length || selectedRowsIncludeLocked) return;
    if (workspaceMode === "listings") {
      setDeleteConfirmation("");
      setShowDeleteConfirmation(true);
      return;
    }
    if (window.confirm(locale === "zh" ? `删除或放弃选中的 ${selectedRows.length} 行？` : `Delete or discard ${selectedRows.length} selected rows?`)) {
      void deleteListingRows(selectedRows);
    }
  }

  async function uploadImages(row: ListingWorkspaceRow, images: File[]) {
    if ((!row.listingId && !row.draftId) || !images.length) return;
    if (row.images.length + images.length > 10) {
      setNotice({ tone: "error", text: locale === "zh" ? "每个 Listing 最多保留 10 张图片。" : "A Listing can have at most 10 images." });
      return;
    }
    if (row.listingId && !window.confirm(locale === "zh"
      ? `确认立即向 Etsy Listing 上传 ${images.length} 张图片？`
      : `Upload ${images.length} image(s) to this Etsy Listing now?`)) return;
    await flushRow(row.rowId);
    if (pendingChangesRef.current.has(row.rowId)) return;
    setIsMediaBusy(true);
    try {
      for (const image of images) {
        const body = new FormData();
        body.set("image", image, image.name);
        if (row.listingId) body.set("listingId", String(row.listingId));
        else body.set("draftId", String(row.draftId));
        if (row.listingId) body.set("confirmation", "CONFIRM");
        body.set("shopId", String(selectedShopId));
        await fetchFormJson("/api/listing-workbench/media", body);
      }
      await loadRows(false, null);
      setNotice({
        tone: "success",
        text: row.listingId
          ? locale === "zh" ? "图片已直接同步到 Etsy。" : "Images synced directly to Etsy."
          : locale === "zh" ? "图片已加入草稿，将在首次发布时上传到 Etsy。" : "Images were staged and will upload on first publish.",
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Image upload failed." });
    } finally {
      setIsMediaBusy(false);
    }
  }

  async function deleteImage(row: ListingWorkspaceRow, image: ListingWorkspaceRow["images"][number]) {
    if (!image.id) return;
    const staged = image.source === "draft";
    if ((staged && !row.draftId) || (!staged && !row.listingId)) return;
    const confirmed = window.confirm(staged
      ? locale === "zh" ? "从新建草稿中删除这张图片？" : "Remove this image from the new draft?"
      : locale === "zh" ? "删除这张 Etsy 图片？此操作会立即生效。" : "Delete this Etsy image now?");
    if (!confirmed) return;
    await flushRow(row.rowId);
    if (pendingChangesRef.current.has(row.rowId)) return;
    setIsMediaBusy(true);
    try {
      await fetchJson("/api/listing-workbench/media", {
        body: JSON.stringify(staged
          ? { draftId: row.draftId, mediaId: image.id, shopId: selectedShopId }
          : { confirmation: "CONFIRM", imageId: image.id, listingId: row.listingId, shopId: selectedShopId }),
        method: "DELETE",
      });
      await loadRows(false, null);
      setNotice({
        tone: "success",
        text: staged
          ? locale === "zh" ? "图片已从草稿移除。" : "Image removed from the draft."
          : locale === "zh" ? "图片已从 Etsy 删除。" : "Image deleted from Etsy.",
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Image delete failed." });
    } finally {
      setIsMediaBusy(false);
    }
  }

  async function saveImageAltText(event: FormEvent) {
    event.preventDefault();
    if (!imageAltEditor?.image.id) return;
    const row = rowsRef.current.find((item) => item.rowId === imageAltEditor.rowId);
    if (!row) {
      setImageAltEditor(null);
      return;
    }
    const staged = imageAltEditor.image.source === "draft";
    if ((staged && !row.draftId) || (!staged && !row.listingId)) return;
    await flushRow(row.rowId);
    if (pendingChangesRef.current.has(row.rowId)) return;
    setIsMediaBusy(true);
    try {
      await fetchJson("/api/listing-workbench/media", {
        body: JSON.stringify(staged
          ? {
              altText: imageAltEditor.value,
              draftId: row.draftId,
              mediaId: imageAltEditor.image.id,
              shopId: selectedShopId,
            }
          : {
              altText: imageAltEditor.value,
              confirmation: "CONFIRM",
              imageId: imageAltEditor.image.id,
              listingId: row.listingId,
              rank: imageAltEditor.image.rank,
              shopId: selectedShopId,
            }),
        method: "PATCH",
      });
      setImageAltEditor(null);
      await loadRows(false, null);
      setNotice({
        tone: "success",
        text: staged
          ? locale === "zh" ? "图片 ALT 文本已保存，将在首次发布时上传到 Etsy。" : "Image alt text saved and will upload on first publish."
          : locale === "zh" ? "图片 ALT 文本已同步到 Etsy。" : "Image alt text synced to Etsy.",
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Image alt text could not be saved." });
    } finally {
      setIsMediaBusy(false);
    }
  }

  async function reorderImages(row: ListingWorkspaceRow, fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || isMediaBusy) return;
    const previousImages = row.images;
    const nextImages = [...previousImages];
    const [moved] = nextImages.splice(fromIndex, 1);
    if (!moved) return;
    nextImages.splice(toIndex, 0, moved);
    if (nextImages.some((image) => !image.id || image.source !== moved.source)) return;
    await flushRow(row.rowId);
    if (pendingChangesRef.current.has(row.rowId)) return;
    replaceRow({ ...row, imageUrl: nextImages[0]?.url ?? "", images: nextImages });
    setIsMediaBusy(true);
    try {
      await fetchJson("/api/listing-workbench/media", {
        body: JSON.stringify(moved.source === "draft"
          ? {
              draftId: row.draftId,
              mediaIds: nextImages.map((image) => image.id),
              operation: "reorder",
              shopId: selectedShopId,
            }
          : {
              images: nextImages.map((image) => ({ altText: image.altText, id: image.id })),
              listingId: row.listingId,
              operation: "reorder",
              shopId: selectedShopId,
            }),
        method: "PATCH",
      });
      await loadRows(false, null);
      setNotice({
        tone: "success",
        text: moved.source === "draft"
          ? locale === "zh" ? "草稿图片顺序已保存。" : "Draft image order saved."
          : locale === "zh" ? "图片顺序已保存到本地，确认同步后才会更新 Etsy。" : "Image order saved locally and will update Etsy after publish confirmation.",
      });
    } catch (error) {
      replaceRow(row);
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Image order could not be saved." });
    } finally {
      setImageDrag(null);
      setIsMediaBusy(false);
    }
  }

  function applySavedView(savedView: ListingSavedView) {
    setWorkspaceMode(savedView.definition.filter === "all" ? "listings" : "upload");
    setActiveSavedViewId(savedView.id);
    setView(savedView.definition.filter === "all" ? "all" : "changed");
    setSort(savedView.definition.sort);
    setDensity(savedView.definition.density);
    if (savedView.definition.columns.length) {
      const savedFields = savedView.definition.columns
        .map((column) => column.fieldId)
        .filter((fieldId): fieldId is EditableField => fieldId !== "inventory" && editableFields.includes(fieldId as EditableField));
      const orderedFields = Array.from(new Set<EditableField>(["sku", ...savedFields.filter((fieldId) => fieldId !== "sku")]));
      setColumnOrder([...orderedFields, ...defaultColumnOrder.filter((fieldId) => !orderedFields.includes(fieldId))]);
      setColumnSizing((current) => ({
        ...current,
        ...Object.fromEntries(savedView.definition.columns.flatMap((column) => column.width ? [[column.fieldId, column.width]] : [])),
      }));
      setVisibleFields(new Set(savedView.definition.columns.filter((column) => !column.hidden && fieldById.has(column.fieldId as keyof ListingDraftValues)).map((column) => column.fieldId as keyof ListingDraftValues)));
    }
  }

  function openBatchUpload() {
    setWorkspaceMode("upload");
    setActiveSavedViewId(null);
    setView("changed");
  }

  function moveColumn(fieldId: EditableField, direction: -1 | 1) {
    setColumnOrder((current) => {
      const index = current.indexOf(fieldId);
      const target = index + direction;
      if (fieldId === "sku" || index < 0 || target <= 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function deleteSavedView(savedView: ListingSavedView) {
    if (!savedView.id) return;
    try {
      await fetchJson(`/api/listing-workbench/views?id=${savedView.id}&shopId=${selectedShopId}`, { method: "DELETE" });
      setSavedViews((current) => current.filter((item) => item.id !== savedView.id));
      if (activeSavedViewId === savedView.id) setActiveSavedViewId(null);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "View delete failed." });
    }
  }

  async function saveCurrentView(event: FormEvent) {
    event.preventDefault();
    const definition: ListingSavedViewDefinition = {
      columns: columnOrder.map((fieldId) => ({ fieldId, hidden: !visibleFields.has(fieldId), width: columnSizing[fieldId] ?? fieldById.get(fieldId)?.defaultWidth })),
      density,
      filter: view,
      pinnedColumns: ["lifecycle", "image", "sku"],
      sort,
    };
    try {
      await fetchJson("/api/listing-workbench/views", {
        body: JSON.stringify({ definition, name: viewName, shopId: selectedShopId }),
        method: "POST",
      });
      const result = await fetchJson<{ views: ListingSavedView[] }>(`/api/listing-workbench/views?shopId=${selectedShopId}`);
      setSavedViews(result.views);
      setViewName("");
      setNotice({ tone: "success", text: locale === "zh" ? "视图已保存。" : "View saved." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "View save failed." });
    }
  }

  function applyTablePaste(startRow: ListingWorkspaceRow, startField: EditableField, text: string) {
    const table = parseClipboardTable(text);
    if (!table.length) return false;
    const rowIndex = rowsRef.current.findIndex((row) => row.rowId === startRow.rowId);
    const fieldIndex = sheetFields.indexOf(startField);
    if (rowIndex < 0 || fieldIndex < 0) return false;
    table.forEach((values, rowOffset) => {
      const targetRow = rowsRef.current[rowIndex + rowOffset];
      if (!targetRow) return;
      values.forEach((value, columnOffset) => {
        const targetField = sheetFields[fieldIndex + columnOffset];
        if (!targetField) return;
        editField(targetRow, targetField, value);
      });
    });
    return true;
  }

  function startWorkbenchCellRangeSelection(
    rowId: string,
    field: EditableField,
    event: ReactPointerEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) {
    if (event.button !== 0) return;

    const focus = { field, rowId };
    const row = rowsRef.current.find((item) => item.rowId === rowId);
    const isActive = isCellActive(rowId, field);

    if (!event.shiftKey && isActive && row && !isWorkbenchFieldDisabled(row, field)) {
      stopCellRangeSelection();
      enterWorkbenchCellEdit(row, field);
      return;
    }

    event.preventDefault();
    event.currentTarget.closest<HTMLElement>(".dataGrid")?.focus({ preventScroll: true });
    workbenchCellSelectionDidMoveRef.current = event.shiftKey;
    startCellRangeSelection(focus.rowId, focus.field, event.shiftKey);
  }

  function extendWorkbenchCellRangeSelection(rowId: string, field: EditableField) {
    if (extendCellRangeSelection(rowId, field)) {
      workbenchCellSelectionDidMoveRef.current = true;
    }
  }

  function expandWorkbenchCellEditor(row: ListingWorkspaceRow, definition: ListingFieldDefinition) {
    if (definition.id === "inventory" || ["queued", "publishing"].includes(row.lifecycle)) return;
    const field = definition.id as EditableField;
    const supportsInlineExpansion = ["longText", "tags", "text"].includes(definition.type);

    if (supportsInlineExpansion) {
      setExpandedCell({ field, rowId: row.rowId });
    }
    enterWorkbenchCellEdit(row, field, !supportsInlineExpansion);
  }

  function handleWorkbenchCellClick(row: ListingWorkspaceRow, definition: ListingFieldDefinition) {
    if (workbenchCellSelectionDidMoveRef.current) {
      workbenchCellSelectionDidMoveRef.current = false;
      return;
    }
    expandWorkbenchCellEditor(row, definition);
  }

  function renderFieldEditor(row: ListingWorkspaceRow, definition: ListingFieldDefinition, inDrawer = false) {
    if (definition.id === "inventory") return null;
    const field = definition.id as EditableField;
    const value = valueAsText(row, field);
    const disabled = isWorkbenchFieldDisabled(row, field);
    return (
      <ListingGridCellEditor
        definition={definition}
        disabled={disabled}
        editing={inDrawer || isCellEditing(row.rowId, field)}
        expanded={!inDrawer && expandedCell?.rowId === row.rowId && expandedCell.field === field}
        field={field}
        inDrawer={inDrawer}
        focusScope={inDrawer ? "workbench-drawer" : "workbench"}
        locale={locale}
        onBlur={() => {
          void flushRow(row.rowId);
          if (!inDrawer) {
            setExpandedCell((current) =>
              current?.rowId === row.rowId && current.field === field ? null : current,
            );
            exitWorkbenchCellEdit(row.rowId, field);
          }
        }}
        onChange={(nextValue) => editField(row, field, nextValue)}
        onDoubleClick={inDrawer ? undefined : () => handleWorkbenchCellClick(row, definition)}
        onKeyDown={(event) => handleWorkbenchEditorKeyDown(event, row, definition, inDrawer)}
        onPointerDown={inDrawer ? undefined : (event) => startWorkbenchCellRangeSelection(row.rowId, field, event)}
        onPointerEnter={inDrawer ? undefined : () => extendWorkbenchCellRangeSelection(row.rowId, field)}
        rowId={row.rowId}
        value={value}
      />
    );
  }

  function renderDefaultEditor(definition: ListingFieldDefinition) {
    const field = definition.id as EditableField;
    const value = draftValueAsText(defaultEditor, field);
    const update = (rawValue: string) => setDefaultEditor((current) => ({
      ...current,
      [field]: parsedFieldValue(current, field, rawValue),
    }));
    const selectClipboard = {
      onCopy: (event: ReactClipboardEvent<HTMLSelectElement>) => {
        event.preventDefault();
        event.clipboardData.setData("text/plain", value);
      },
      onPaste: (event: ReactClipboardEvent<HTMLSelectElement>) => {
        const pasted = event.clipboardData.getData("text/plain");
        if (!pasted) return;
        event.preventDefault();
        update(normalizedDefaultClipboardValue(field, pasted));
      },
    };
    if (field === "state") {
      return <select className="workbenchCellControl" onChange={(event) => update(event.target.value)} value={value} {...selectClipboard}><option value="draft">{locale === "zh" ? "保存为 Etsy 草稿" : "Etsy draft"}</option><option value="active">{locale === "zh" ? "发布时上架" : "Activate on publish"}</option><option value="inactive">{locale === "zh" ? "发布时下架" : "Inactive on publish"}</option></select>;
    }
    if (field === "type") {
      return <select className="workbenchCellControl" onChange={(event) => update(event.target.value)} value={value} {...selectClipboard}><option value="physical">{locale === "zh" ? "实物" : "Physical"}</option><option value="download">{locale === "zh" ? "数字商品" : "Download"}</option></select>;
    }
    if (field === "whoMade") {
      return <select className="workbenchCellControl" onChange={(event) => update(event.target.value)} value={value} {...selectClipboard}><option value="i_did">{locale === "zh" ? "我制作" : "I did"}</option><option value="someone_else">{locale === "zh" ? "他人制作" : "Someone else"}</option><option value="collective">Collective</option></select>;
    }
    if (definition.type === "boolean") {
      return <select className="workbenchCellControl" onChange={(event) => update(event.target.value)} value={value} {...selectClipboard}><option value="true">{locale === "zh" ? "是" : "Yes"}</option><option value="false">{locale === "zh" ? "否" : "No"}</option></select>;
    }
    if (definition.type === "longText") {
      return <textarea className="workbenchDrawerTextarea" onChange={(event) => update(event.target.value)} value={value} />;
    }
    return <input className="workbenchCellControl" inputMode={definition.type === "money" || definition.type === "number" ? "decimal" : undefined} onChange={(event) => update(event.target.value)} step={definition.type === "money" ? "0.01" : definition.type === "number" ? "1" : undefined} type={definition.type === "money" || definition.type === "number" ? "number" : "text"} value={value} />;
  }

  function updateVariant(row: ListingWorkspaceRow, productIndex: number, field: "price" | "quantity" | "readiness" | "sku", rawValue: string) {
    if (!row.values.inventory) return;
    const inventory = JSON.parse(JSON.stringify(row.values.inventory)) as NonNullable<ListingDraftValues["inventory"]>;
    const product = inventory.products[productIndex];
    if (!product) return;
    const propertyIds = variationPropertyIds(inventory);
    if (field === "sku") {
      if (!inventory.sku_on_property?.length) return;
      product.sku = rawValue;
    }
    const offering = product.offerings[0];
    if (offering && field === "price") {
      offering.price = Number(rawValue) || 0;
      inventory.price_on_property = propertyIds;
    }
    if (offering && field === "quantity") {
      offering.quantity = Math.max(0, Math.round(Number(rawValue) || 0));
      inventory.quantity_on_property = propertyIds;
    }
    if (offering && field === "readiness") {
      offering.readiness_state_id = Number(rawValue) || null;
      inventory.readiness_state_on_property = propertyIds;
    }
    replaceRows(rowsRef.current.map((item) => item.rowId === row.rowId ? {
      ...item,
      dirtyFields: Array.from(new Set([...item.dirtyFields, "inventory"])),
      lifecycle: item.kind === "new" ? "draft" : "changed",
      values: { ...item.values, inventory },
    } : item));
    queueSave(row.rowId, { inventory });
  }

  function toggleVariantSkuOverrides(row: ListingWorkspaceRow, enabled: boolean) {
    if (!row.values.inventory) return;
    const inventory = JSON.parse(JSON.stringify(row.values.inventory)) as NonNullable<ListingDraftValues["inventory"]>;
    const propertyIds = variationPropertyIds(inventory);
    if (!propertyIds.length) return;

    const firstVariantSku = inventory.products.map((product) => product.sku?.trim() ?? "").find(Boolean) ?? "";
    const mainSku = row.values.sku.trim() || firstVariantSku;
    const nextSku = enabled ? "" : mainSku;
    inventory.sku_on_property = enabled ? propertyIds : [];
    inventory.products = inventory.products.map((product) => ({
      ...product,
      sku: enabled ? product.sku?.trim() || mainSku : mainSku,
    }));

    replaceRows(rowsRef.current.map((item) => item.rowId === row.rowId ? {
      ...item,
      dirtyFields: Array.from(new Set([...item.dirtyFields, "inventory", "sku"])),
      lifecycle: item.kind === "new" ? "draft" : "changed",
      values: { ...item.values, inventory, sku: nextSku },
    } : item));
    queueSave(row.rowId, { inventory, sku: nextSku });
  }

  function openVariantGroupEditor(row: ListingWorkspaceRow) {
    const groups = variationGroupsFromInventory(row.values.inventory);
    setVariantCombinationEditorRowId(null);
    setVariantGroupEditor({
      groups: groups.length ? groups : [emptyVariationGroup(0, locale)],
      rowId: row.rowId,
    });
  }

  function updateVariantGroups(updater: (groups: ListingVariationGroupDraft[]) => ListingVariationGroupDraft[]) {
    setVariantGroupEditor((current) => current ? { ...current, groups: updater(current.groups) } : null);
  }

  function addVariantGroup() {
    updateVariantGroups((groups) => {
      if (groups.length >= MAX_LISTING_VARIATION_GROUPS) return groups;
      return [...groups, emptyVariationGroup(groups.length, locale, groups.map((group) => group.propertyId))];
    });
  }

  function removeVariantGroup(groupId: string) {
    updateVariantGroups((groups) => groups.length <= 1 ? groups : groups.filter((group) => group.id !== groupId));
  }

  function updateVariantGroupName(groupId: string, name: string) {
    updateVariantGroups((groups) => groups.map((group) => group.id === groupId ? { ...group, name } : group));
  }

  function addVariantValue(groupId: string) {
    updateVariantGroups((groups) => groups.map((group) => group.id === groupId ? {
      ...group,
      values: [...group.values, { id: variationDraftId("variation-value"), value: "" }],
    } : group));
  }

  function removeVariantValue(groupId: string, valueId: string) {
    updateVariantGroups((groups) => groups.map((group) => {
      if (group.id !== groupId || group.values.length <= 1) return group;
      return { ...group, values: group.values.filter((value) => value.id !== valueId) };
    }));
  }

  function updateVariantValue(groupId: string, valueId: string, nextValue: string) {
    updateVariantGroups((groups) => groups.map((group) => group.id === groupId ? {
      ...group,
      values: group.values.map((value) => value.id === valueId ? { ...value, value: nextValue } : value),
    } : group));
  }

  function saveVariantGroups(row: ListingWorkspaceRow) {
    if (!variantGroupEditor || variantGroupEditor.rowId !== row.rowId) return;
    try {
      const inventory = rebuildInventoryForVariationGroups(row.values, row.values.inventory, variantGroupEditor.groups);
      const sku = inventory.sku_on_property?.length ? "" : row.values.sku;
      replaceRows(rowsRef.current.map((item) => item.rowId === row.rowId ? {
        ...item,
        dirtyFields: Array.from(new Set([...item.dirtyFields, "inventory", "sku"])),
        lifecycle: item.kind === "new" ? "draft" : "changed",
        values: { ...item.values, inventory, sku },
      } : item));
      queueSave(row.rowId, { inventory, sku });
      setVariantCombinationEditorRowId(null);
      setVariantGroupEditor(null);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Variation values could not be saved." });
    }
  }

  const columns = useMemo<DataGridColumn<ListingWorkspaceRow>[]>(() => {
    const fieldColumns = columnOrder
      .map((fieldId) => fieldById.get(fieldId))
      .filter((field): field is ListingFieldDefinition => Boolean(field && field.id !== "inventory" && visibleFields.has(field.id)))
      .map((definition): DataGridColumn<ListingWorkspaceRow> => ({
        cell: ({ row }) => <WorkbenchGridFieldCell definition={definition} fieldIndex={sheetFields.indexOf(definition.id as EditableField)} row={row.original} rowIndex={row.index} />,
        header: () => definition.label[locale],
        id: definition.id,
        meta: {
          className: `workbenchFieldCell field-${definition.id}`,
          stickyEdge: definition.id === "sku",
          stickyLeft: definition.id === "sku" ? 260 : undefined,
        },
        size: columnSizing[definition.id] ?? definition.defaultWidth,
      }));
    return [
      {
        cell: ({ row }) => <WorkbenchGridRowCheckbox rowId={row.original.rowId} rowIndex={row.index} />,
        header: () => <WorkbenchGridSelectAllCheckbox />,
        id: "select",
        enableResizing: false,
        meta: { align: "center", className: "workbenchSelectCell", stickyLeft: 0 },
        size: 52,
      },
      {
        cell: ({ row }) => <span className={`workbenchStatus tone-${statusTone(row.original.lifecycle)}`}>{["queued", "publishing"].includes(row.original.lifecycle) ? <LoaderCircle className="spin" size={13} /> : null}{lifecycleCopy[locale][row.original.lifecycle]}</span>,
        header: locale === "zh" ? "状态" : "Status",
        id: "lifecycle",
        enableResizing: false,
        meta: { className: "workbenchStickyStatus", stickyLeft: 52 },
        size: 126,
      },
      {
        cell: ({ row }) => row.original.imageUrl ? <Image alt="" className="workbenchThumb" height={52} src={row.original.imageUrl} unoptimized width={52} /> : <span className="workbenchThumb empty">-</span>,
        header: locale === "zh" ? "主图" : "Image",
        id: "image",
        enableResizing: false,
        meta: { stickyEdge: !visibleFields.has("sku"), stickyLeft: 178 },
        size: 82,
      },
      ...fieldColumns,
      {
        cell: ({ row }) => <span className="workbenchUpdatedAt">{formatDate(row.original.updatedAt, locale)}</span>,
        header: locale === "zh" ? "更新时间" : "Updated",
        id: "updatedAt",
        size: 164,
      },
      {
        cell: ({ row }) => <button className="button quiet compactButton" onClick={() => setActiveRowId(row.original.rowId)} type="button">{labels.details}<ChevronRight size={14} /></button>,
        header: locale === "zh" ? "操作" : "Actions",
        id: "actions",
        meta: { align: "end" },
        size: 116,
      },
    ];
  }, [columnOrder, columnSizing, labels.details, locale, sheetFields, visibleFields]);

  const minWidth = columns.reduce((total, column) => total + (columnSizing[String(column.id)] ?? Number(column.size ?? 160)), 0);
  const workbenchGridContextValue: WorkbenchGridContextValue = {
    allRowsSelected,
    extendRowSelection: extendWorkbenchRowSelection,
    isCellEditing,
    isCellExpanded: (rowId, field) => expandedCell?.rowId === rowId && expandedCell.field === field,
    isCellSelected,
    renderFieldEditor: (row, definition) => renderFieldEditor(row, definition),
    selectedRowIds,
    selectionBounds,
    startRowSelection: startWorkbenchRowSelection,
    toggleAllValidRows,
    toggleRowSelection: toggleWorkbenchRowSelection,
  };

  return (
    <section className="listingWorkbench">
      {notice ? <div className={notice.tone === "error" ? "notice errorNotice" : "notice successNotice"}>{notice.tone === "error" ? <AlertTriangle size={16} /> : <Check size={16} />}{notice.text}</div> : null}

      <div className="workbenchViewBar">
        <div className="workbenchViewTabs" role="tablist">
          {savedViews.map((savedView) => {
            const key = savedView.systemKey ?? `saved-${savedView.id}`;
            const active = workspaceMode === "listings" && (savedView.systemKey ? activeSavedViewId === null && view === savedView.systemKey : activeSavedViewId === savedView.id);
            const displayName = savedView.systemKey ? systemViewCopy[locale][savedView.systemKey] : savedView.name;
            return savedView.id ? (
              <span className={active ? "workbenchSavedView active" : "workbenchSavedView"} key={key}>
                <button aria-selected={active} className="workbenchViewTab" onClick={() => applySavedView(savedView)} role="tab" type="button">{displayName}</button>
                <button aria-label={`${locale === "zh" ? "删除视图" : "Delete view"} ${displayName}`} className="workbenchSavedViewDelete" onClick={() => void deleteSavedView(savedView)} type="button"><X size={12} /></button>
              </span>
            ) : <button aria-selected={active} className={active ? "workbenchViewTab active" : "workbenchViewTab"} key={key} onClick={() => applySavedView(savedView)} role="tab" type="button">{displayName}</button>;
          })}
          <button aria-selected={workspaceMode === "upload"} className={workspaceMode === "upload" ? "workbenchViewTab active" : "workbenchViewTab"} onClick={openBatchUpload} role="tab" type="button">{locale === "zh" ? "批量上传" : "Batch upload"}</button>
        </div>
        <div className="workbenchPrimaryActions">
          <button className="button quiet" disabled={isLoading} onClick={openDefaultsEditor} type="button"><Settings2 size={16} />{locale === "zh" ? "默认上新设置" : "Listing defaults"}</button>
          {workspaceMode === "upload" ? <button className="button quiet" disabled={isLoading} onClick={() => setShowUploadImporter(true)} type="button"><Upload size={16} />{locale === "zh" ? "批量粘贴导入" : "Paste/import"}</button> : null}
          {workspaceMode === "upload" ? <button className="button" disabled={isLoading} onClick={() => void createDraft()} type="button"><Plus size={16} />{locale === "zh" ? "新建未上传产品" : "New unuploaded product"}</button> : null}
        </div>
      </div>

      <div className="workbenchToolbar">
        <form className="workbenchSearch" onSubmit={submitSearch}>
          <Search aria-hidden="true" size={16} />
          <input aria-label={labels.search} onChange={(event) => setSearchInput(event.target.value)} placeholder={labels.search} value={searchInput} />
        </form>
        {workspaceMode === "listings" ? (
          <select aria-label={locale === "zh" ? "筛选上架状态" : "Filter listing state"} onChange={(event) => setStateFilter(event.target.value)} value={stateFilter}>
            <option value="">{locale === "zh" ? "全部状态" : "All states"}</option>
            {listingStates.map((state) => <option key={state} value={state}>{listingStateCopy[state]?.[locale] ?? state}</option>)}
          </select>
        ) : null}
        <select aria-label="Sort" onChange={(event) => setSort(event.target.value as ListingSort)} value={sort}>
          <option value="updated_desc">{locale === "zh" ? "最近更新" : "Recently updated"}</option>
          <option value="title_asc">{locale === "zh" ? "标题 A-Z" : "Title A-Z"}</option>
          <option value="price_desc">{locale === "zh" ? "价格从高到低" : "Price high to low"}</option>
          <option value="quantity_asc">{locale === "zh" ? "库存从低到高" : "Quantity low to high"}</option>
        </select>
        <details className="workbenchColumnsMenu">
          <summary><Columns3 size={15} />{labels.columns}</summary>
          <div className="workbenchColumnsPopover">
            {columnOrder.map((fieldId, index) => { const field = fieldById.get(fieldId)!; return <div className="workbenchColumnOption" key={field.id}><label><input checked={visibleFields.has(field.id)} onChange={(event) => setVisibleFields((current) => { const next = new Set(current); if (event.target.checked) next.add(field.id); else next.delete(field.id); return next; })} type="checkbox" /><span>{field.label[locale]}</span></label><span className="workbenchColumnOrderButtons"><button aria-label={`${locale === "zh" ? "上移" : "Move up"} ${field.label[locale]}`} disabled={index <= 1} onClick={() => moveColumn(fieldId, -1)} type="button">↑</button><button aria-label={`${locale === "zh" ? "下移" : "Move down"} ${field.label[locale]}`} disabled={fieldId === "sku" || index === columnOrder.length - 1} onClick={() => moveColumn(fieldId, 1)} type="button">↓</button></span></div>; })}
            <label><span>{locale === "zh" ? "密度" : "Density"}</span><select onChange={(event) => setDensity(event.target.value as "comfortable" | "compact")} value={density}><option value="comfortable">{locale === "zh" ? "舒适" : "Comfortable"}</option><option value="compact">{locale === "zh" ? "紧凑" : "Compact"}</option></select></label>
            <form className="workbenchSaveView" onSubmit={(event) => void saveCurrentView(event)}><input onChange={(event) => setViewName(event.target.value)} placeholder={labels.newView} required value={viewName} /><button className="button compactButton" type="submit"><Save size={14} />{labels.saveView}</button></form>
          </div>
        </details>
        <span className="workbenchPasteHint">{workspaceMode === "upload"
          ? locale === "zh" ? "此表只显示尚未上传到 Etsy 的本地产品。" : "This table only contains local products not yet uploaded to Etsy."
          : locale === "zh" ? "此表显示 Etsy 全部线上状态；编辑先保存为本地修改，确认同步后才会影响 Etsy。" : "All Etsy states appear here. Edits stay local until you confirm sync."}</span>
        <span className="workbenchSelectionCount">{labels.selected(selectedRowIds.size)}</span>
        <button className="button quiet" disabled={!selectedRows.length || selectedRowsIncludeLocked || isLoading} onClick={requestDeleteSelected} type="button"><Trash2 size={15} />{workspaceMode === "upload" ? (locale === "zh" ? "删除未上传产品" : "Delete unuploaded") : (locale === "zh" ? "永久删除 Etsy Listing" : "Delete from Etsy")}</button>
        <button className="button" disabled={!selectedDraftRows.length || isLoading} onClick={() => void publishSelected()} type="button"><Send size={15} />{workspaceMode === "upload" ? (locale === "zh" ? "确认上传选中产品" : "Confirm upload") : (locale === "zh" ? "确认同步选中修改" : "Confirm changes")}</button>
      </div>

      <div className={density === "compact" ? "workbenchGrid compact" : "workbenchGrid"}>
        <WorkbenchGridContext.Provider value={workbenchGridContextValue}>
          <DataGrid
            ariaLabel="Listing Workbench"
            className="listingWorkbenchGrid"
            columnSizing={columnSizing}
            columns={columns}
            data={rows}
            enableColumnResizing
            estimateRowHeight={density === "compact" ? 44 : 64}
            fillWidth
            getRowId={(row) => row.rowId}
            minWidth={Math.max(980, minWidth)}
            onCopy={(event) => {
              if (hasNativeTextSelection(event.target)) return;
              const text = copySelectionAsTsv();
              if (!text) return;
              event.preventDefault();
              event.clipboardData.setData("text/plain", text);
            }}
            onColumnSizingChange={setColumnSizing}
            onKeyDown={handleWorkbenchGridKeyDown}
            onPaste={(event) => {
              if (!activeCell) return;
              const startRow = rowsRef.current.find((row) => row.rowId === activeCell.rowId);
              const text = event.clipboardData.getData("text/plain");

              if (startRow && text && applyTablePaste(startRow, activeCell.field, text)) {
                event.preventDefault();
              }
            }}
            onPointerUp={() => {
              stopCellRangeSelection();
              stopWorkbenchRowSelection();
            }}
            overscan={12}
            rowClassName={(row) => `workbenchRow lifecycle-${row.original.lifecycle}`}
          />
        </WorkbenchGridContext.Provider>
      </div>

      <div className="workbenchPager">
        {hasMore ? <button className="button quiet" disabled={isLoading} onClick={() => void loadRows(true)} type="button">{isLoading ? <LoaderCircle className="spin" size={15} /> : null}{labels.loadMore}</button> : <span>{labels.allLoaded}</span>}
        {!rows.length && !isLoading ? <p>{labels.empty}</p> : null}
      </div>

      {activeRow ? (
        <div className="workbenchDrawerBackdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setActiveRowId(null); }}>
          <aside aria-label={labels.details} className="workbenchDrawer">
            <header>
              <div><span className={`workbenchStatus tone-${statusTone(activeRow.lifecycle)}`}>{lifecycleCopy[locale][activeRow.lifecycle]}</span><h2>{activeRow.values.title || (locale === "zh" ? "未命名 Listing" : "Untitled Listing")}</h2><p>{activeRow.listingId ? `Listing #${activeRow.listingId}` : locale === "zh" ? "新建草稿" : "New draft"}</p></div>
              <button aria-label={labels.close} className="iconButton" onClick={() => setActiveRowId(null)} type="button"><X size={18} /></button>
            </header>
            {Object.keys(activeRow.validationErrors).length ? <div className="workbenchValidationSummary"><AlertTriangle size={16} /><div>{Object.entries(activeRow.validationErrors).map(([field, error]) => <p key={field}><strong>{fieldById.get(field as keyof ListingDraftValues)?.label[locale] ?? field}:</strong> {error}</p>)}</div></div> : null}
            <section className="workbenchDrawerSection workbenchMediaSection">
              <div className="workbenchSectionHeading">
                <div>
                  <h3>{locale === "zh" ? "媒体" : "Media"}</h3>
                  <p>{activeRow.listingId
                    ? locale === "zh" ? "图片操作会立即同步到 Etsy。" : "Image changes sync to Etsy immediately."
                    : locale === "zh" ? "图片先保存在新建草稿中，首次发布时自动上传到 Etsy。" : "Images are staged with the new draft and uploaded on first publish."}</p>
                </div>
                <label className={isMediaBusy ? "button quiet disabled" : "button quiet"}>
                  <Upload size={15} />
                  {isMediaBusy ? (locale === "zh" ? "处理中" : "Working") : (locale === "zh" ? "上传图片" : "Upload images")}
                  <input
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    disabled={isMediaBusy}
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length) void uploadImages(activeRow, files);
                      event.currentTarget.value = "";
                    }}
                    type="file"
                  />
                </label>
              </div>
              {activeRow.images.length ? (
                <div className="workbenchMediaGrid">
                  {activeRow.images.map((image, index) => (
                    <figure
                      className={imageDrag?.rowId === activeRow.rowId && imageDrag.index !== index ? "isImageDropTarget" : undefined}
                      key={`${image.source}-${image.id ?? "image"}-${index}`}
                      onDragOver={(event) => {
                        if (imageDrag?.rowId !== activeRow.rowId || imageDrag.index === index) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (imageDrag?.rowId !== activeRow.rowId) return;
                        void reorderImages(activeRow, imageDrag.index, index);
                      }}
                    >
                      <button aria-label={`${locale === "zh" ? "查看图片" : "View image"} ${index + 1}`} className="workbenchMediaPreviewButton" onClick={() => setActiveImagePreviewUrl(image.url)} type="button">
                        <Image alt={image.altText} height={108} src={image.url} unoptimized width={108} />
                      </button>
                      {image.id ? (
                        <button
                          aria-label={`${locale === "zh" ? "拖动调整图片顺序" : "Drag to reorder image"} ${index + 1}`}
                          className="workbenchMediaDragHandle"
                          disabled={isMediaBusy}
                          draggable={!isMediaBusy}
                          onDragEnd={() => setImageDrag(null)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", String(image.id));
                            setImageDrag({ index, rowId: activeRow.rowId });
                          }}
                          title={locale === "zh" ? `第 ${index + 1} 张，拖动排序` : `Image ${index + 1}, drag to reorder`}
                          type="button"
                        >
                          <GripVertical aria-hidden="true" size={12} strokeWidth={2} />
                          <span>{index + 1}</span>
                        </button>
                      ) : null}
                      {image.source === "draft" ? <span className="workbenchMediaStagedBadge">{locale === "zh" ? "待发布" : "Staged"}</span> : null}
                      {image.id ? (
                        <>
                          <button
                            aria-label={`${locale === "zh" ? "编辑图片 ALT 文本" : "Edit image alt text"} ${index + 1}`}
                            className="workbenchMediaAltButton"
                            disabled={isMediaBusy}
                            onClick={() => setImageAltEditor({ image, rowId: activeRow.rowId, value: image.altText })}
                            title={locale === "zh" ? "编辑 ALT 文本" : "Edit alt text"}
                            type="button"
                          >
                            <Pencil aria-hidden="true" size={12} strokeWidth={2} />
                          </button>
                          <button aria-label={`${locale === "zh" ? "删除图片" : "Delete image"} ${index + 1}`} className="workbenchMediaDeleteButton" disabled={isMediaBusy} onClick={() => void deleteImage(activeRow, image)} title={locale === "zh" ? "删除图片" : "Delete image"} type="button">
                            <Image alt="" aria-hidden="true" className="workbenchMediaDeleteIcon" height={12} src="/images/listing-image-delete.svg" width={12} />
                          </button>
                        </>
                      ) : null}
                    </figure>
                  ))}
                </div>
              ) : <p className="emptyText">{locale === "zh" ? "暂无图片，可在这里选择一张或多张上传。" : "No images yet. Upload one or more images here."}</p>}
            </section>
            {(["basic", "commerce", "fulfillment"] as const).map((group) => (
              <section className="workbenchDrawerSection" key={group}>
                <h3>{group === "basic" ? (locale === "zh" ? "基础信息" : "Basics") : group === "commerce" ? (locale === "zh" ? "销售设置" : "Commerce") : (locale === "zh" ? "履约设置" : "Fulfillment")}</h3>
                <div className="workbenchDrawerFields">
                  {listingFieldDefinitions.filter((field) => field.group === group && field.id !== "inventory").map((definition) => <label className={definition.type === "longText" ? "wide" : ""} key={definition.id}><span>{definition.label[locale]}</span>{renderFieldEditor(activeRow, definition, true)}</label>)}
                </div>
              </section>
            ))}
            <section className="workbenchDrawerSection">
              <h3>{labels.variants}</h3>
              {(() => {
                const inventory = activeRow.values.inventory;
                const groups = variationGroupsFromInventory(inventory);
                const variantSkuOverridesEnabled = Boolean(inventory?.sku_on_property?.length);
                const isLocked = ["queued", "publishing"].includes(activeRow.lifecycle);
                return (
                  <div className={`workbenchVariantOverview ${variantSkuOverridesEnabled ? "hasVariantSkuOverrides" : ""}`}>
                    <div className="workbenchVariantOverviewHeader">
                      <p>{locale === "zh" ? "先确认变体变量；仅在需要单独调整时打开组合设置。" : "Review variation values first. Open combinations only when individual adjustments are needed."}</p>
                      <label className="workbenchVariantSkuToggle">
                        <input checked={variantSkuOverridesEnabled} disabled={isLocked || !groups.length || Boolean(activeVariantGroupEditor)} onChange={(event) => toggleVariantSkuOverrides(activeRow, event.target.checked)} type="checkbox" />
                        <span>{locale === "zh" ? "每个变体使用独立 SKU" : "Use an individual SKU for each variant"}</span>
                      </label>
                    </div>
                    <div className="workbenchVariantGroups">
                      {groups.length ? groups.map((group) => <div className="workbenchVariantGroup" key={group.id}><strong>{group.name}</strong><span>{group.values.map((value) => value.value).join(" / ")}</span></div>) : <p className="emptyText">{locale === "zh" ? "尚未添加变量。" : "No variation groups yet."}</p>}
                    </div>
                    <div className="workbenchVariantOverviewActions">
                      <button className="button quiet compactButton" disabled={isLocked} onClick={() => openVariantGroupEditor(activeRow)} type="button">
                        {groups.length ? (locale === "zh" ? "编辑变量" : "Edit variables") : (locale === "zh" ? "添加变量" : "Add variables")}
                      </button>
                      <span>{variantSkuOverridesEnabled ? (locale === "zh" ? "已启用独立 SKU，主表 SKU 将被变体 SKU 取代。" : "Individual SKUs are enabled and replace the main-table SKU.") : (locale === "zh" ? "当前使用主表 SKU；开启后可按组合填写 SKU。" : "The main-table SKU is active. Enable overrides to enter SKUs by combination.")}</span>
                      <button className="button quiet compactButton" disabled={isLocked || !groups.length || Boolean(activeVariantGroupEditor)} onClick={() => setVariantCombinationEditorRowId((current) => current === activeRow.rowId ? null : activeRow.rowId)} type="button">
                        {isVariantCombinationEditorOpen ? (locale === "zh" ? "收起组合设置" : "Hide combination settings") : (locale === "zh" ? "打开组合设置" : "Open combination settings")}
                      </button>
                    </div>
                  </div>
                );
              })()}
              {activeVariantGroupEditor ? (
                <div className="workbenchVariantEditor">
                  <div className="workbenchVariantEditorHeader">
                    <div><strong>{locale === "zh" ? "编辑变体变量" : "Edit variation groups"}</strong><p>{locale === "zh" ? `最多 ${MAX_LISTING_VARIATION_GROUPS} 组；保存后将重新生成对应组合。` : `Use up to ${MAX_LISTING_VARIATION_GROUPS} groups. Saving regenerates the matching combinations.`}</p></div>
                    <button aria-label={labels.close} className="iconButton quiet" onClick={() => setVariantGroupEditor(null)} type="button"><X size={16} /></button>
                  </div>
                  <div className="workbenchVariantEditorGroups">
                    {activeVariantGroupEditor.groups.map((group, groupIndex) => (
                      <section className="workbenchVariantEditorGroup" key={group.id}>
                        <div className="workbenchVariantEditorGroupHeader">
                          <label><span>{locale === "zh" ? `变量 ${groupIndex + 1} 名称` : `Variation ${groupIndex + 1} name`}</span><input className="workbenchCellControl" onChange={(event) => updateVariantGroupName(group.id, event.target.value)} value={group.name} /></label>
                          <button aria-label={locale === "zh" ? "删除变量" : "Remove variation"} className="iconButton quiet" disabled={activeVariantGroupEditor.groups.length <= 1} onClick={() => removeVariantGroup(group.id)} type="button"><X size={15} /></button>
                        </div>
                        <div className="workbenchVariantEditorValues">
                          {group.values.map((value, valueIndex) => <label key={value.id}><span>{locale === "zh" ? `值 ${valueIndex + 1}` : `Value ${valueIndex + 1}`}</span><input className="workbenchCellControl" onChange={(event) => updateVariantValue(group.id, value.id, event.target.value)} value={value.value} /><button aria-label={locale === "zh" ? "删除值" : "Remove value"} className="iconButton quiet" disabled={group.values.length <= 1} onClick={() => removeVariantValue(group.id, value.id)} type="button"><X size={14} /></button></label>)}
                        </div>
                        <button className="button quiet compactButton" onClick={() => addVariantValue(group.id)} type="button"><Plus size={14} />{locale === "zh" ? "添加值" : "Add value"}</button>
                      </section>
                    ))}
                  </div>
                  <div className="workbenchVariantEditorActions">
                    <button className="button quiet compactButton" disabled={activeVariantGroupEditor.groups.length >= MAX_LISTING_VARIATION_GROUPS} onClick={addVariantGroup} type="button"><Plus size={14} />{locale === "zh" ? "添加变量" : "Add variation"}</button>
                    <span>{locale === "zh" ? `${activeVariantGroupEditor.groups.length}/${MAX_LISTING_VARIATION_GROUPS} 组变量` : `${activeVariantGroupEditor.groups.length}/${MAX_LISTING_VARIATION_GROUPS} variation groups`}</span>
                    <button className="button quiet compactButton" onClick={() => setVariantGroupEditor(null)} type="button">{locale === "zh" ? "取消" : "Cancel"}</button>
                    <button className="button compactButton" onClick={() => saveVariantGroups(activeRow)} type="button"><Save size={14} />{locale === "zh" ? "保存变量" : "Save variations"}</button>
                  </div>
                </div>
              ) : null}
              {isVariantCombinationEditorOpen ? (activeRow.values.inventory?.products.length ? <div className="workbenchVariantTable"><div className="workbenchVariantHeader"><span>{locale === "zh" ? "选项" : "Options"}</span><span>SKU</span><span>{locale === "zh" ? "价格" : "Price"}</span><span>{locale === "zh" ? "数量" : "Qty"}</span><span>Readiness</span></div>{activeRow.values.inventory.products.map((product, index) => { const offering = product.offerings[0]; const options = product.property_values.map((property) => `${property.property_name ?? property.property_id}: ${property.values.join("/")}`).join(", ") || `#${index + 1}`; const rawPrice = offering?.price; const price = typeof rawPrice === "object" ? Number(rawPrice.amount) / Math.max(1, Number(rawPrice.divisor || 100)) : rawPrice ?? ""; return <div className="workbenchVariantRow" key={product.product_id ?? index}><span title={options}>{options}</span><input onChange={(event) => updateVariant(activeRow, index, "sku", event.target.value)} value={product.sku ?? ""} /><input onChange={(event) => updateVariant(activeRow, index, "price", event.target.value)} type="number" value={String(price)} /><input onChange={(event) => updateVariant(activeRow, index, "quantity", event.target.value)} type="number" value={String(offering?.quantity ?? 0)} /><input onChange={(event) => updateVariant(activeRow, index, "readiness", event.target.value)} type="number" value={String(offering?.readiness_state_id ?? "")} /></div>; })}</div> : <p className="emptyText">{locale === "zh" ? "当前 Listing 没有变体。" : "This listing has no variants."}</p>) : null}
            </section>
            <footer>
              {activeRow.draftId ? <button className="button quiet" disabled={["queued", "publishing"].includes(activeRow.lifecycle)} onClick={() => void discardDraft(activeRow)} type="button"><RotateCcw size={15} />{activeRow.listingId ? (locale === "zh" ? "放弃本地修改" : "Discard local changes") : (locale === "zh" ? "删除未上传产品" : "Delete unuploaded product")}</button> : null}
              <button className="button quiet" onClick={() => void copyListingSettings(activeRow)} type="button"><Copy size={15} />{locale === "zh" ? "复制设置" : "Copy settings"}</button>
              <button className="button" disabled={!activeRow.draftId || ["invalid", "queued", "publishing"].includes(activeRow.lifecycle)} onClick={() => void requestPublishRowIds([activeRow.rowId])} type="button"><Send size={15} />{activeRow.listingId ? (locale === "zh" ? "确认同步到 Etsy" : "Confirm Etsy changes") : (locale === "zh" ? "确认上传到 Etsy" : "Confirm Etsy upload")}</button>
            </footer>
          </aside>
        </div>
      ) : null}

      {showUploadImporter ? (
        <div className="workbenchModalBackdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowUploadImporter(false); }}>
          <div aria-modal="true" className="workbenchModal wide listingUploadImportModal" role="dialog">
            <header>
              <div>
                <h2>{locale === "zh" ? "批量粘贴未上传产品" : "Paste unuploaded products"}</h2>
                <p>{locale === "zh" ? "粘贴并校验后，产品会进入批量上传表；不会立即上传 Etsy。" : "After validation, products move into Batch upload and are not sent to Etsy yet."}</p>
              </div>
              <button aria-label={labels.close} className="iconButton" onClick={() => setShowUploadImporter(false)} type="button"><X size={18} /></button>
            </header>
            <div className="workbenchModalBody">
              <ListingUploadSheet
                locale={locale}
                onConverted={() => {
                  setShowUploadImporter(false);
                  setWorkspaceMode("upload");
                  setView("changed");
                  void loadRows(false, null);
                }}
                onEditDefaults={() => {
                  setShowUploadImporter(false);
                  openDefaultsEditor();
                }}
                selectedShopId={selectedShopId}
                shopDefaults={shopDefaults}
              />
            </div>
          </div>
        </div>
      ) : null}

      {showDeleteConfirmation ? (
        <div className="workbenchModalBackdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowDeleteConfirmation(false); }}>
          <div aria-modal="true" className="workbenchModal listingDeleteConfirmation" role="dialog">
            <header>
              <div>
                <h2>{locale === "zh" ? "永久删除 Etsy Listing" : "Permanently delete Etsy Listings"}</h2>
                <p>{locale === "zh" ? `将从 Etsy 永久删除 ${selectedRows.length} 个线上 Listing（包括草稿等状态）。此操作不可撤销。` : `${selectedRows.length} Etsy Listings, including drafts and other states, will be permanently deleted. This cannot be undone.`}</p>
              </div>
              <button aria-label={labels.close} className="iconButton" onClick={() => setShowDeleteConfirmation(false)} type="button"><X size={18} /></button>
            </header>
            <div className="workbenchModalBody">
              <ul className="listingDeleteTitleList">
                {selectedRows.slice(0, 20).map((row) => <li key={row.rowId}>{row.values.title || `Listing #${row.listingId}`}</li>)}
                {selectedRows.length > 20 ? <li>+{selectedRows.length - 20}</li> : null}
              </ul>
              <label>
                <span>{locale === "zh" ? "输入 DELETE 确认" : "Type DELETE to confirm"}</span>
                <input autoFocus onChange={(event) => setDeleteConfirmation(event.target.value)} value={deleteConfirmation} />
              </label>
            </div>
            <footer>
              <button className="button quiet" onClick={() => setShowDeleteConfirmation(false)} type="button">{locale === "zh" ? "取消" : "Cancel"}</button>
              <button className="button dangerButton" disabled={deleteConfirmation !== "DELETE" || isLoading} onClick={() => void deleteListingRows(selectedRows, deleteConfirmation)} type="button"><Trash2 size={15} />{locale === "zh" ? "永久删除" : "Delete permanently"}</button>
            </footer>
          </div>
        </div>
      ) : null}

      {imageAltEditor ? (
        <div className="workbenchModalBackdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !isMediaBusy) setImageAltEditor(null); }}>
          <form aria-label={locale === "zh" ? "编辑图片 ALT 文本" : "Edit image alt text"} className="workbenchModal imageAltTextModal" onSubmit={(event) => void saveImageAltText(event)}>
            <header>
              <div>
                <h2>{locale === "zh" ? "图片 ALT 文本" : "Image alt text"}</h2>
                <p>{imageAltEditor.image.source === "draft"
                  ? locale === "zh" ? "保存到草稿，首次发布时随图片上传到 Etsy。" : "Saved with the draft and uploaded to Etsy on first publish."
                  : locale === "zh" ? "保存后会立即同步到 Etsy。" : "Saving syncs the change to Etsy immediately."}</p>
              </div>
              <button aria-label={labels.close} className="iconButton" disabled={isMediaBusy} onClick={() => setImageAltEditor(null)} type="button"><X size={18} /></button>
            </header>
            <div className="workbenchModalBody imageAltTextBody">
              <Image alt="" height={120} src={imageAltEditor.image.url} unoptimized width={120} />
              <label>
                <span>{locale === "zh" ? "描述图片内容" : "Describe the image"}</span>
                <textarea
                  autoFocus
                  maxLength={500}
                  onChange={(event) => setImageAltEditor((current) => current ? { ...current, value: event.target.value } : current)}
                  placeholder={locale === "zh" ? "例如：黄色手工饼干压模，表面带卡通图案" : "For example: Yellow handmade cookie stamp with a cartoon design"}
                  rows={5}
                  value={imageAltEditor.value}
                />
                <small>{locale === "zh" ? "用于无障碍阅读和图片语义说明。" : "Used for accessibility and image meaning."}<b>{imageAltEditor.value.length}/500</b></small>
              </label>
            </div>
            <footer>
              <button className="button quiet" disabled={isMediaBusy} onClick={() => setImageAltEditor(null)} type="button">{locale === "zh" ? "取消" : "Cancel"}</button>
              <button className="button" disabled={isMediaBusy} type="submit">{isMediaBusy ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{locale === "zh" ? "保存 ALT 文本" : "Save alt text"}</button>
            </footer>
          </form>
        </div>
      ) : null}

      {activeImagePreviewUrl ? (
        <div
          aria-label={locale === "zh" ? "图片预览" : "Image preview"}
          aria-modal="true"
          className="workbenchImageLightbox"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setActiveImagePreviewUrl(null);
          }}
          role="dialog"
        >
          <div className="workbenchImageLightboxContent">
            <button
              aria-label={locale === "zh" ? "关闭图片预览" : "Close image preview"}
              className="workbenchImageLightboxClose"
              onClick={() => setActiveImagePreviewUrl(null)}
              type="button"
            >
              <X aria-hidden="true" size={20} />
            </button>
            <Image alt={locale === "zh" ? "Listing 图片预览" : "Listing image preview"} height={1600} src={activeImagePreviewUrl} unoptimized width={1600} />
          </div>
        </div>
      ) : null}

      {showDefaults ? (
        <div className="workbenchModalBackdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowDefaults(false); }}>
          <form className="workbenchModal" onSubmit={(event) => void saveDefaults(event)}>
            <header><div><h2>{locale === "zh" ? "店铺默认上新设置" : "Shop listing defaults"}</h2><p>{locale === "zh" ? "每次新建或批量粘贴时自动带入；标题和 SKU 始终按每一行单独填写。" : "Applied to every new or pasted draft. Title and SKU remain row-specific."}</p></div><button aria-label={labels.close} className="iconButton" onClick={() => setShowDefaults(false)} type="button"><X size={18} /></button></header>
            <div className="workbenchModalBody workbenchDrawerFields">
              {defaultSettingFields.map((fieldId) => { const definition = fieldById.get(fieldId)!; return <label className={definition.type === "longText" || definition.type === "tags" ? "wide" : ""} key={fieldId}><span>{definition.label[locale]}</span>{renderDefaultEditor(definition)}</label>; })}
              <section className="workbenchVariantEditor wide workbenchDefaultVariantEditor">
                <div className="workbenchVariantEditorHeader">
                  <div>
                    <strong>{locale === "zh" ? "默认多变量" : "Default variations"}</strong>
                    <p>{locale === "zh" ? "新建和批量上传时自动生成这些变量组合；价格、数量和处理模板使用上方默认值。" : "New and batch-uploaded listings receive these variation combinations, using the defaults above for price, quantity, and readiness."}</p>
                  </div>
                  <button className="button quiet compactButton" disabled={defaultVariationGroups.length >= MAX_LISTING_VARIATION_GROUPS} onClick={addDefaultVariationGroup} type="button"><Plus size={14} />{locale === "zh" ? "添加变量" : "Add variation"}</button>
                </div>
                {defaultVariationGroups.length ? (
                  <div className="workbenchVariantEditorGroups">
                    {defaultVariationGroups.map((group, groupIndex) => (
                      <section className="workbenchVariantEditorGroup" key={group.id}>
                        <div className="workbenchVariantEditorGroupHeader">
                          <label><span>{locale === "zh" ? `变量 ${groupIndex + 1} 名称` : `Variation ${groupIndex + 1} name`}</span><input className="workbenchCellControl" onChange={(event) => updateDefaultVariationGroupName(group.id, event.target.value)} value={group.name} /></label>
                          <button aria-label={locale === "zh" ? "删除变量" : "Remove variation"} className="iconButton quiet" onClick={() => removeDefaultVariationGroup(group.id)} type="button"><Trash2 size={15} /></button>
                        </div>
                        <div className="workbenchVariantEditorValues">
                          {group.values.map((value, valueIndex) => <label key={value.id}><span>{locale === "zh" ? `值 ${valueIndex + 1}` : `Value ${valueIndex + 1}`}</span><input className="workbenchCellControl" onChange={(event) => updateDefaultVariationValue(group.id, value.id, event.target.value)} value={value.value} /><button aria-label={locale === "zh" ? "删除值" : "Remove value"} className="iconButton quiet" disabled={group.values.length <= 1} onClick={() => removeDefaultVariationValue(group.id, value.id)} type="button"><X size={14} /></button></label>)}
                        </div>
                        <button className="button quiet compactButton" onClick={() => addDefaultVariationValue(group.id)} type="button"><Plus size={14} />{locale === "zh" ? "添加值" : "Add value"}</button>
                      </section>
                    ))}
                  </div>
                ) : <p className="emptyText">{locale === "zh" ? "未设置默认变量；点击“添加变量”后，后续新商品会自动带入。" : "No default variations yet. Add one to apply it to future listings."}</p>}
              </section>
            </div>
            <footer><span>{defaultClipboardNotice ?? (locale === "zh" ? `设置版本 ${shopDefaults.version}` : `Version ${shopDefaults.version}`)}</span><button className="button quiet" onClick={() => void copyDefaultSettings()} type="button"><Copy size={14} />{locale === "zh" ? "复制设置" : "Copy defaults"}</button><button className="button quiet" onClick={() => void pasteDefaultSettings()} type="button"><ClipboardPaste size={14} />{locale === "zh" ? "粘贴设置" : "Paste defaults"}</button><button className="button quiet" onClick={() => setShowDefaults(false)} type="button">{locale === "zh" ? "取消" : "Cancel"}</button><button className="button" disabled={isLoading} type="submit"><Save size={15} />{locale === "zh" ? "保存默认设置" : "Save defaults"}</button></footer>
          </form>
        </div>
      ) : null}

    </section>
  );
}
