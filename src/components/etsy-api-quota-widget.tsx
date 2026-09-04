"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Eye, EyeOff, X } from "lucide-react";
import { compactNumber } from "@/shared/format/commerce";
import { intlLocale, type Locale } from "@/shared/i18n";
import type { EtsyShopData } from "@/shared/types/etsy";

type QuotaTone = "danger" | "neutral" | "success" | "warning";
type WidgetPosition = {
  x: number;
  y: number;
};

const quotaBarHeights = [34, 52, 72, 58, 86];
const widgetMargin = 12;
const apiQuotaWidgetVisibilityEvent = "etsy-api-quota-widget-visibility-change";
const visibilityStorageKey = "etsy-api-quota-widget-visible";

function readCookie(name: string) {
  try {
    return document.cookie
      .split("; ")
      .find((item) => item.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null;
  } catch {
    return null;
  }
}

function readApiQuotaWidgetVisibility() {
  try {
    const stored = window.localStorage.getItem(visibilityStorageKey) ?? readCookie(visibilityStorageKey);
    return stored !== "false";
  } catch {
    return readCookie(visibilityStorageKey) !== "false";
  }
}

function saveApiQuotaWidgetVisibility(visible: boolean) {
  const value = String(visible);

  try {
    window.localStorage.setItem(visibilityStorageKey, value);
  } catch {
    // Cookie persistence below is a fallback.
  }

  try {
    document.cookie = `${visibilityStorageKey}=${encodeURIComponent(value)}; max-age=31536000; path=/; samesite=lax`;
  } catch {
    // The local preference remains available for the current visit.
  }

  window.dispatchEvent(new Event(apiQuotaWidgetVisibilityEvent));
}

function boundedQuotaPercent(remaining: number | null | undefined, limit: number | null | undefined) {
  if (typeof remaining !== "number" || typeof limit !== "number" || limit <= 0) {
    return null;
  }

  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

function quotaTone(percentValue: number | null): QuotaTone {
  if (percentValue === null) return "neutral";
  if (percentValue <= 10) return "danger";
  if (percentValue <= 25) return "warning";
  return "success";
}

function quotaUpdatedAt(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function clampPosition(position: WidgetPosition, width: number, height: number): WidgetPosition {
  const maxX = Math.max(widgetMargin, window.innerWidth - width - widgetMargin);
  const maxY = Math.max(widgetMargin, window.innerHeight - height - widgetMargin);

  return {
    x: Math.min(Math.max(widgetMargin, position.x), maxX),
    y: Math.min(Math.max(widgetMargin, position.y), maxY),
  };
}

function readSavedPosition(storageKey: string) {
  let saved: string | null = null;

  try {
    saved = window.localStorage?.getItem(storageKey) ?? null;
  } catch {
    saved = null;
  }

  saved = saved ?? readPositionCookie(storageKey);

  try {
    if (!saved) return null;
    const parsed = JSON.parse(saved) as Partial<WidgetPosition>;
    return typeof parsed.x === "number" && typeof parsed.y === "number"
      ? {
          x: parsed.x,
          y: parsed.y,
        }
      : null;
  } catch {
    return null;
  }
}

function savePosition(storageKey: string, position: WidgetPosition) {
  const serialized = JSON.stringify(position);

  try {
    window.localStorage?.setItem(storageKey, serialized);
  } catch {
    // Fall back to a cookie below.
  }

  writePositionCookie(storageKey, serialized);
}

function positionCookieName(storageKey: string) {
  return storageKey.replace(/[^a-z0-9_-]/gi, "_");
}

function readPositionCookie(storageKey: string) {
  const name = `${positionCookieName(storageKey)}=`;
  let value: string | null = null;

  try {
    value =
      document.cookie
        .split("; ")
        .find((item) => item.startsWith(name))
        ?.slice(name.length) ?? null;
  } catch {
    return null;
  }

  return value ? decodeURIComponent(value) : null;
}

function writePositionCookie(storageKey: string, serialized: string) {
  try {
    document.cookie = `${positionCookieName(storageKey)}=${encodeURIComponent(serialized)}; max-age=31536000; path=/; samesite=lax`;
  } catch {
    // Position persistence is a convenience; dragging still works without it.
  }
}

export function EtsyApiQuotaWidget({
  locale,
  selectedShop,
}: {
  locale: Locale;
  selectedShop: EtsyShopData | null;
}) {
  const widgetRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ offsetX: number; offsetY: number; pointerId: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState<WidgetPosition | null>(null);
  const [isVisible, setIsVisible] = useState(true);
  const storageKey = selectedShop ? "etsy-api-quota-widget" : null;

  const copy = useMemo(
    () =>
      locale === "zh"
        ? {
            aria: "Etsy API 今日剩余额度",
            dailyLimit: (value: string) => `日额度 ${value}`,
            dailyLimitUnknown: "日额度 --",
            remaining: "今日剩余",
            title: `Etsy API ${selectedShop?.connection.apiSlot ?? 1}`,
            updated: "更新",
            waiting: "等待 Etsy 响应头",
          }
        : {
            aria: "Etsy API remaining calls today",
            dailyLimit: (value: string) => `Daily limit ${value}`,
            dailyLimitUnknown: "Daily limit --",
            remaining: "Remaining today",
            title: `Etsy API ${selectedShop?.connection.apiSlot ?? 1}`,
            updated: "Updated",
            waiting: "Waiting for Etsy header",
          },
    [locale, selectedShop?.connection.apiSlot],
  );

  const moveTo = useCallback((nextPosition: WidgetPosition) => {
    const widget = widgetRef.current;
    if (!widget) return nextPosition;

    const rect = widget.getBoundingClientRect();
    const clamped = clampPosition(nextPosition, rect.width, rect.height);
    setPosition(clamped);
    return clamped;
  }, []);

  useLayoutEffect(() => {
    const syncVisibility = () => setIsVisible(readApiQuotaWidgetVisibility());
    syncVisibility();

    window.addEventListener(apiQuotaWidgetVisibilityEvent, syncVisibility);
    window.addEventListener("storage", syncVisibility);
    return () => {
      window.removeEventListener(apiQuotaWidgetVisibilityEvent, syncVisibility);
      window.removeEventListener("storage", syncVisibility);
    };
  }, []);

  useLayoutEffect(() => {
    if (!storageKey || !isVisible) return;

    const widget = widgetRef.current;
    if (!widget) return;

    const rect = widget.getBoundingClientRect();
    const savedPosition = readSavedPosition(storageKey);
    const defaultPosition = {
      x: window.innerWidth - rect.width - 18,
      y: window.innerHeight - rect.height - 18,
    };
    const initialPosition = clampPosition(savedPosition ?? defaultPosition, rect.width, rect.height);
    setPosition(initialPosition);

    const handleResize = () => {
      const currentWidget = widgetRef.current;
      if (!currentWidget) return;

      const currentRect = currentWidget.getBoundingClientRect();
      setPosition((currentPosition) => {
        const nextPosition = clampPosition(currentPosition ?? initialPosition, currentRect.width, currentRect.height);
        return nextPosition;
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isVisible, storageKey]);

  if (!selectedShop || !isVisible) return null;

  const quota = selectedShop.apiQuota;
  const percentValue = boundedQuotaPercent(quota?.remainingToday, quota?.limitPerDay);
  const tone = quotaTone(percentValue);
  const activeBars = percentValue === null ? 0 : Math.ceil(percentValue / 20);
  const remaining =
    typeof quota?.remainingToday === "number" ? compactNumber(quota.remainingToday, locale) : "--";
  const dailyLimit =
    typeof quota?.limitPerDay === "number"
      ? copy.dailyLimit(compactNumber(quota.limitPerDay, locale))
      : copy.dailyLimitUnknown;
  const widgetStyle = {
    "--quota-value": `${percentValue ?? 0}%`,
    visibility: position ? "visible" : "hidden",
    ...(position
      ? {
          bottom: "auto",
          left: `${position.x}px`,
          right: "auto",
          top: `${position.y}px`,
        }
      : {}),
  } as CSSProperties & Record<"--quota-value", string>;

  function persistCurrentPosition(nextPosition: WidgetPosition) {
    if (storageKey) {
      savePosition(storageKey, nextPosition);
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const widget = widgetRef.current;
    if (!widget) return;

    const rect = widget.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      pointerId: event.pointerId,
    };
    widget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.preventDefault();
    const nextPosition = moveTo({
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    });
    persistCurrentPosition(nextPosition);
  }

  function finishDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const widget = widgetRef.current;
    if (widget?.hasPointerCapture(event.pointerId)) {
      widget.releasePointerCapture(event.pointerId);
    }

    const nextPosition = moveTo({
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY,
    });
    persistCurrentPosition(nextPosition);
    dragRef.current = null;
    setIsDragging(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!position || !["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)) return;

    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    const nextPosition = moveTo({
      x: position.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      y: position.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
    });
    persistCurrentPosition(nextPosition);
  }

  function closeWidget() {
    saveApiQuotaWidgetVisibility(false);
    setIsVisible(false);
  }

  return (
    <aside
      aria-label={copy.aria}
      className={`apiQuotaWidget tone-${tone}${isDragging ? " dragging" : ""}`}
      onKeyDown={handleKeyDown}
      onPointerCancel={finishDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      ref={widgetRef}
      style={widgetStyle}
      tabIndex={0}
    >
      <div className="apiQuotaGauge">
        <span>{percentValue === null ? "--" : `${Math.round(percentValue)}%`}</span>
      </div>
      <div className="apiQuotaBody">
        <div className="apiQuotaHeader">
          <span>{copy.title}</span>
          <strong>{remaining}</strong>
          <button
            aria-label={locale === "zh" ? "关闭悬浮卡片" : "Close floating card"}
            className="apiQuotaWidgetClose"
            onClick={closeWidget}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          >
            <X aria-hidden="true" size={14} strokeWidth={2.5} />
          </button>
        </div>
        <div className="apiQuotaMeta">
          <span>{copy.remaining}</span>
          <span>{dailyLimit}</span>
        </div>
        <div className="apiQuotaBars" aria-hidden="true">
          {quotaBarHeights.map((height, index) => (
            <span className={index < activeBars ? "active" : ""} key={height} style={{ height: `${height}%` }} />
          ))}
        </div>
        <small>{quota?.updatedAt ? `${copy.updated} ${quotaUpdatedAt(quota.updatedAt, locale)}` : copy.waiting}</small>
      </div>
    </aside>
  );
}

export function ApiQuotaWidgetSettings({ locale }: { locale: Locale }) {
  const [enabled, setEnabled] = useState(true);

  useLayoutEffect(() => {
    const syncVisibility = () => setEnabled(readApiQuotaWidgetVisibility());
    syncVisibility();
    window.addEventListener(apiQuotaWidgetVisibilityEvent, syncVisibility);
    window.addEventListener("storage", syncVisibility);
    return () => {
      window.removeEventListener(apiQuotaWidgetVisibilityEvent, syncVisibility);
      window.removeEventListener("storage", syncVisibility);
    };
  }, []);

  const copy = locale === "zh"
    ? {
        description: "显示或隐藏右下角可拖动的 Etsy API 额度卡片。关闭后可在这里重新开启。",
        disabled: "已关闭",
        enabled: "已开启",
        title: "悬浮 API 额度卡片",
      }
    : {
        description: "Show or hide the draggable Etsy API quota card. You can turn it back on here after closing it.",
        disabled: "Off",
        enabled: "On",
        title: "Floating API quota card",
      };

  function toggleVisibility() {
    const nextValue = !enabled;
    saveApiQuotaWidgetVisibility(nextValue);
    setEnabled(nextValue);
  }

  return (
    <div className="settingsRow quotaWidgetSettingsRow">
      <div>
        <strong>{copy.title}</strong>
        <small>{copy.description}</small>
      </div>
      <button
        aria-pressed={enabled}
        className={enabled ? "button secondary" : "button quiet"}
        onClick={toggleVisibility}
        type="button"
      >
        {enabled ? <Eye aria-hidden="true" size={16} /> : <EyeOff aria-hidden="true" size={16} />}
        {enabled ? copy.enabled : copy.disabled}
      </button>
    </div>
  );
}
