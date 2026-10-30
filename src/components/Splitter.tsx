import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { clampPane, paneLimits } from "../settings/layout";
import { t, type TranslationKey } from "../lib/i18n";

export function Splitter({
  vertical,
  shell,
  pane,
  value,
  reset,
  enabled,
  change,
  label,
  controls,
}: {
  vertical: boolean;
  shell: RefObject<HTMLElement | null>;
  pane: RefObject<HTMLElement | null>;
  value: number;
  reset: number;
  enabled: boolean;
  change: (value: number) => void;
  label: TranslationKey;
  controls: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const preferred = useRef(value);
  preferred.current = value;
  const variable = vertical ? "--sidebar-width" : "--panel-height";
  const drag = useRef<
    | {
        id: number;
        start: number;
        value: number;
        current: number;
        minimum: number;
        maximum: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  const [geometry, setGeometry] = useState({
    now: value,
    ...paneLimits(vertical, vertical ? window.innerWidth : window.innerHeight),
  });

  const limits = () => {
    const element = pane.current;
    const parent = element?.parentElement;
    if (!element || !parent)
      return {
        ...paneLimits(
          vertical,
          vertical ? window.innerWidth : window.innerHeight
        ),
        reserve: vertical ? 284 : 160,
      };
    const fixed = vertical
      ? 0
      : [...parent.children]
          .filter(
            (child) =>
              child !== element &&
              child !== bar.current &&
              !child.hasAttribute("data-editor-fill")
          )
          .reduce(
            (height, child) => height + child.getBoundingClientRect().height,
            0
          );
    return {
      ...paneLimits(
        vertical,
        vertical
          ? parent.getBoundingClientRect().width
          : parent.getBoundingClientRect().height,
        fixed
      ),
      reserve: vertical ? 284 : 124 + fixed,
    };
  };

  const preview = (size: number) =>
    shell.current?.style.setProperty(variable, `${size}px`);

  const cancel = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    if (bar.current?.hasPointerCapture(current.id))
      bar.current.releasePointerCapture(current.id);
    preview(preferred.current);
  };

  useEffect(() => {
    const element = pane.current;
    if (!element?.parentElement) return;

    const update = () => {
      if (!element.isConnected) return;
      const bounds = limits();
      if (!vertical) {
        shell.current?.style.setProperty(
          "--panel-limit",
          `${bounds.maximum}px`
        );
        shell.current?.style.setProperty(
          "--panel-reserve",
          `${bounds.reserve}px`
        );
      }
      const now = Math.round(
        vertical
          ? element.getBoundingClientRect().width
          : element.getBoundingClientRect().height
      );
      setGeometry((previous) =>
        previous.now === now &&
        previous.minimum === bounds.minimum &&
        previous.maximum === bounds.maximum
          ? previous
          : { now, ...bounds }
      );
    };
    const observer = new ResizeObserver(update);

    const observe = () => {
      observer.disconnect();
      observer.observe(element);
      if (!element.parentElement) return;
      observer.observe(element.parentElement);
      if (!vertical)
        for (const child of element.parentElement.children)
          observer.observe(child);
    };
    observe();
    const siblings = new MutationObserver(() => {
      observe();
      update();
    });
    siblings.observe(element.parentElement, { childList: true });
    update();

    window.addEventListener("blur", cancel);
    return () => {
      observer.disconnect();
      siblings.disconnect();
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [vertical, pane, shell]);

  const finish = (event: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(current.id))
      event.currentTarget.releasePointerCapture(current.id);
    if (cancel) preview(preferred.current);
    else if (current.moved) {
      const bounds = limits();
      const size = clampPane(current.current, bounds.minimum, bounds.maximum);
      preview(size);
      if (size !== preferred.current)
        change(Math.max(vertical ? 170 : 100, size));
    }
  };
  return (
    <div
      ref={bar}
      className={`pane-resizer ${vertical ? "vertical" : "horizontal"}`}
      role="separator"
      aria-label={t(label)}
      aria-controls={controls}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={geometry.minimum}
      aria-valuemax={geometry.maximum}
      aria-valuenow={geometry.now}
      aria-valuetext={t("layout.size", { count: geometry.now })}
      aria-disabled={!enabled}
      tabIndex={enabled ? 0 : -1}
      title={t("layout.resizeHint")}
      onPointerDown={(event) => {
        if (!enabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        const rect = pane.current?.getBoundingClientRect();
        const size = rect ? (vertical ? rect.width : rect.height) : value;
        drag.current = {
          id: event.pointerId,
          start: vertical ? event.clientX : event.clientY,
          value: size,
          current: size,
          ...limits(),
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        const delta = vertical
          ? event.clientX - current.start
          : current.start - event.clientY;
        const size = clampPane(
          current.value + delta,
          current.minimum,
          current.maximum
        );
        current.current = size;
        current.moved ||= size !== Math.round(current.value);
        preview(size);
      }}
      onPointerUp={(event) => finish(event, false)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onDoubleClick={() => {
        if (enabled) {
          const bounds = limits();
          change(
            Math.max(
              vertical ? 170 : 100,
              clampPane(reset, bounds.minimum, bounds.maximum)
            )
          );
        }
      }}
      onKeyDown={(event) => {
        if (!enabled) return;
        if (event.key === "Escape" && drag.current) {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return;
        }
        const smaller = vertical ? "ArrowLeft" : "ArrowDown";
        const larger = vertical ? "ArrowRight" : "ArrowUp";
        if (![smaller, larger, "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = limits();
        const delta = event.shiftKey ? 50 : 10;
        const size =
          event.key === "Home"
            ? bounds.minimum
            : event.key === "End"
              ? bounds.maximum
              : clampPane(
                  geometry.now + (event.key === larger ? delta : -delta),
                  bounds.minimum,
                  bounds.maximum
                );
        preview(size);
        change(Math.max(vertical ? 170 : 100, size));
      }}
    />
  );
}
