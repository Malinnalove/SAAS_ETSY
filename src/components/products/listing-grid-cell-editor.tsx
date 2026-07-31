"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Locale } from "@/shared/i18n";
import type {
  ListingFieldDefinition,
  ListingUploadField,
} from "@/shared/types/listing-workbench";

export function ListingGridCellEditor({
  definition,
  disabled = false,
  editing,
  expanded,
  field,
  focusScope = "workbench",
  inDrawer = false,
  locale,
  onBlur,
  onChange,
  onDoubleClick,
  onKeyDown,
  onPointerDown,
  onPointerEnter,
  placeholder,
  rowId,
  value,
}: {
  definition: ListingFieldDefinition;
  disabled?: boolean;
  editing: boolean;
  expanded: boolean;
  field: ListingUploadField;
  focusScope?: string;
  inDrawer?: boolean;
  locale: Locale;
  onBlur: () => void;
  onChange: (value: string) => void;
  onDoubleClick?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
  onPointerEnter?: () => void;
  placeholder?: string;
  rowId: string;
  value: string;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const expandedEditorRef = useRef<HTMLDivElement | null>(null);
  const wasEditingRef = useRef(editing);

  useEffect(() => {
    if (!editing || !wasEditingRef.current) setDraftValue(value);
    wasEditingRef.current = editing;
  }, [editing, value]);

  useEffect(() => {
    const editor = expandedEditorRef.current;
    if (!expanded || !editor) return;
    const grid = editor.closest<HTMLElement>(".dataGrid");
    const gridCell = editor.closest<HTMLElement>(".dataGridCell");
    if (!grid || !gridCell) return;

    const updatePlacement = () => {
      const gridBounds = grid.getBoundingClientRect();
      const cellBounds = gridCell.getBoundingClientRect();
      const spaceBelow = gridBounds.bottom - cellBounds.top;
      const spaceAbove = cellBounds.bottom - gridBounds.top;
      editor.classList.toggle(
        "opens-upward",
        spaceBelow < editor.offsetHeight + 8 && spaceAbove > spaceBelow,
      );
    };

    updatePlacement();
    grid.addEventListener("scroll", updatePlacement, { passive: true });
    window.addEventListener("resize", updatePlacement);
    return () => {
      grid.removeEventListener("scroll", updatePlacement);
      window.removeEventListener("resize", updatePlacement);
    };
  }, [expanded]);

  const displayedValue = editing ? draftValue : value;
  const common = {
    "data-grid-focus-key": `${focusScope}:${rowId}:${field}`,
    disabled,
    onBlur,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setDraftValue(event.target.value);
      onChange(event.target.value);
    },
    onDoubleClick: onDoubleClick
      ? (event: React.MouseEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
          event.preventDefault();
          event.stopPropagation();
          onDoubleClick();
        }
      : undefined,
    onKeyDown,
    onPointerDown,
    onPointerEnter,
    placeholder,
    tabIndex: editing ? 0 : -1,
    value: displayedValue,
  };

  if (expanded && !inDrawer) {
    return (
      <div className="workbenchInlineCellEditor" onPointerDown={(event) => event.stopPropagation()} ref={expandedEditorRef}>
        <textarea
          aria-label={definition.label[locale]}
          autoFocus
          className="workbenchInlineCellTextarea"
          readOnly={!editing}
          rows={4}
          spellCheck={false}
          {...common}
        />
        <div aria-hidden="true" className="workbenchInlineCellFooter">
          <span><kbd>Shift</kbd><kbd>Enter</kbd>{locale === "zh" ? "换行" : "new line"}</span>
          <span><kbd>Enter</kbd>{locale === "zh" ? "完成" : "done"}</span>
          <span><kbd>Esc</kbd>{locale === "zh" ? "收起" : "collapse"}</span>
        </div>
      </div>
    );
  }

  if (field === "state") {
    return <select className="workbenchCellControl" {...common}><option value="active">{locale === "zh" ? "上架" : "Active"}</option><option value="inactive">{locale === "zh" ? "下架" : "Inactive"}</option><option value="draft">{locale === "zh" ? "草稿" : "Draft"}</option></select>;
  }
  if (field === "type") {
    return <select className="workbenchCellControl" {...common}><option value="physical">{locale === "zh" ? "实物" : "Physical"}</option><option value="download">{locale === "zh" ? "数字商品" : "Download"}</option></select>;
  }
  if (field === "whoMade") {
    return <select className="workbenchCellControl" {...common}><option value="i_did">{locale === "zh" ? "我制作" : "I did"}</option><option value="someone_else">{locale === "zh" ? "他人制作" : "Someone else"}</option><option value="collective">Collective</option></select>;
  }
  if (definition.type === "boolean") {
    return <select className="workbenchCellControl" {...common}><option value="true">{locale === "zh" ? "是" : "Yes"}</option><option value="false">{locale === "zh" ? "否" : "No"}</option></select>;
  }
  if (definition.type === "longText") {
    return (
      <textarea
        className={inDrawer ? "workbenchDrawerTextarea" : "workbenchCellControl workbenchCellTextarea"}
        readOnly={!editing}
        {...common}
      />
    );
  }
  return (
    <input
      className="workbenchCellControl"
      inputMode={definition.type === "money" || definition.type === "number" ? "decimal" : undefined}
      readOnly={!editing}
      step={definition.type === "money" ? "0.01" : definition.type === "number" ? "1" : undefined}
      type={definition.type === "money" || definition.type === "number" ? "number" : "text"}
      {...common}
    />
  );
}
