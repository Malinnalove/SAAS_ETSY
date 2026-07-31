"use client";

import {
  flexRender,
  getCoreRowModel,
  type ColumnDef,
  type ColumnSizingState,
  type OnChangeFn,
  type Row,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ClipboardEventHandler,
  type CSSProperties,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type RefObject,
  type ReactNode,
  type UIEventHandler,
  useMemo,
  useRef,
} from "react";

export type DataGridColumnMeta = {
  align?: "center" | "end" | "start";
  className?: string;
  grow?: number;
  headerClassName?: string;
  stickyEdge?: boolean;
  stickyLeft?: number;
};

export type DataGridColumn<TData> = ColumnDef<TData, unknown> & {
  meta?: DataGridColumnMeta;
};

type DataGridProps<TData> = {
  ariaLabel?: string;
  className?: string;
  columns: DataGridColumn<TData>[];
  columnSizing?: ColumnSizingState;
  data: TData[];
  enableColumnResizing?: boolean;
  estimateRowHeight?: number;
  fillWidth?: boolean;
  getRowId?: (row: TData, index: number) => string;
  headerClassName?: string;
  minWidth?: number;
  onCopy?: ClipboardEventHandler<HTMLDivElement>;
  onColumnSizingChange?: OnChangeFn<ColumnSizingState>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  onPaste?: ClipboardEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  overscan?: number;
  renderAfterRow?: (row: Row<TData>, rowIndex: number) => ReactNode;
  rowClassName?: (row: Row<TData>, rowIndex: number) => string | undefined;
  rowStyle?: (row: Row<TData>, rowIndex: number) => CSSProperties | undefined;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
};

function columnStyle(size: number, grow = 0, stickyLeft?: number): CSSProperties {
  return {
    flex: `${grow} 0 ${size}px`,
    left: stickyLeft,
    position: stickyLeft === undefined ? undefined : "sticky",
    width: size,
    zIndex: stickyLeft === undefined ? undefined : 2,
  };
}

export function DataGrid<TData>({
  ariaLabel,
  className = "",
  columns,
  columnSizing,
  data,
  enableColumnResizing = false,
  estimateRowHeight = 52,
  fillWidth = false,
  getRowId,
  headerClassName = "",
  minWidth = 980,
  onCopy,
  onColumnSizingChange,
  onKeyDown,
  onPaste,
  onPointerUp,
  onScroll,
  overscan = 10,
  renderAfterRow,
  rowClassName,
  rowStyle,
  scrollContainerRef,
}: DataGridProps<TData>) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = scrollContainerRef ?? internalScrollRef;
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    columns,
    columnResizeMode: "onChange",
    data,
    enableColumnResizing,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
    onColumnSizingChange,
    state: columnSizing ? { columnSizing } : undefined,
    defaultColumn: {
      minSize: 72,
      size: 160,
    },
  });
  const rows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => estimateRowHeight,
    getScrollElement: () => scrollRef.current,
    overscan,
  });
  const measuredVirtualRows = rowVirtualizer.getVirtualItems();
  const virtualRows = measuredVirtualRows.length
    ? measuredVirtualRows
    : rows.slice(0, Math.min(rows.length, overscan + 12)).map((_, index) => ({
        end: (index + 1) * estimateRowHeight,
        index,
        key: index,
        lane: 0,
        size: estimateRowHeight,
        start: index * estimateRowHeight,
      }));
  const totalSize = Math.max(rowVirtualizer.getTotalSize(), rows.length * estimateRowHeight);
  const totalWidth = Math.max(minWidth, table.getTotalSize());
  const canvasWidth = fillWidth ? `max(100%, ${totalWidth}px)` : totalWidth;
  const headerGroups = table.getHeaderGroups();
  const firstHeaderGroup = headerGroups[0];
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? totalSize - virtualRows[virtualRows.length - 1].end
    : 0;
  const rootClassName = ["dataGrid", className].filter(Boolean).join(" ");

  const headerCells = useMemo(
    () =>
      firstHeaderGroup?.headers.map((header) => {
        const meta = header.column.columnDef.meta as DataGridColumnMeta | undefined;
        const cellClassName = [
          "dataGridHeaderCell",
          meta?.headerClassName,
          meta?.align ? `align-${meta.align}` : "",
          meta?.stickyLeft === undefined ? "" : "is-sticky",
          meta?.stickyEdge ? "sticky-edge" : "",
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <div
            className={cellClassName}
            key={header.id}
            role="columnheader"
            style={columnStyle(header.getSize(), meta?.grow ?? 0, meta?.stickyLeft)}
          >
            {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
            {enableColumnResizing && header.column.getCanResize() ? (
              <div
                aria-label={`Resize ${header.id}`}
                className={header.column.getIsResizing() ? "dataGridColumnResizer active" : "dataGridColumnResizer"}
                onDoubleClick={() => header.column.resetSize()}
                onMouseDown={header.getResizeHandler()}
                onTouchStart={header.getResizeHandler()}
                role="separator"
              />
            ) : null}
          </div>
        );
      }) ?? [],
    [enableColumnResizing, firstHeaderGroup],
  );

  return (
    <div
      aria-label={ariaLabel}
      className={rootClassName}
      onCopy={onCopy}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onPointerUp={onPointerUp}
      onScroll={onScroll}
      ref={scrollRef}
      role="grid"
      tabIndex={0}
    >
      <div className="dataGridCanvas" style={{ minWidth: canvasWidth, width: canvasWidth }}>
        <div className={["dataGridHeader", headerClassName].filter(Boolean).join(" ")} role="row">
          {headerCells}
        </div>
        <div className="dataGridBody" style={{ height: totalSize }}>
          {paddingTop > 0 ? <div aria-hidden="true" style={{ height: paddingTop }} /> : null}
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            const classNameForRow = ["dataGridRow", rowClassName?.(row, virtualRow.index)]
              .filter(Boolean)
              .join(" ");

            return (
              <div
                className={classNameForRow}
                data-index={virtualRow.index}
                key={row.id}
                ref={rowVirtualizer.measureElement}
                role="row"
                style={rowStyle?.(row, virtualRow.index)}
              >
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as DataGridColumnMeta | undefined;
                  const cellClassName = [
                    "dataGridCell",
                    meta?.className,
                    meta?.align ? `align-${meta.align}` : "",
                    meta?.stickyLeft === undefined ? "" : "is-sticky",
                    meta?.stickyEdge ? "sticky-edge" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <div
                      className={cellClassName}
                      key={cell.id}
                      role="gridcell"
                      style={columnStyle(cell.column.getSize(), meta?.grow ?? 0, meta?.stickyLeft)}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </div>
                  );
                })}
                {renderAfterRow?.(row, virtualRow.index)}
              </div>
            );
          })}
          {paddingBottom > 0 ? <div aria-hidden="true" style={{ height: paddingBottom }} /> : null}
        </div>
      </div>
    </div>
  );
}
