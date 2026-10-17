import { useLayoutEffect, useRef } from 'react';

const dialogStack: HTMLElement[] = [];

/** Keep keyboard navigation within a modal and return focus to its opener. */
export function useDialogFocus<T extends HTMLElement>(initialFocus?: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialogStack.push(dialog);
    const isTopDialog = () => dialogStack.at(-1) === dialog;
    const previous = document.activeElement;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    )).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    const focusStart = () => {
      const preferred = initialFocus ? dialog.querySelector<HTMLElement>(initialFocus) : null;
      (preferred || focusable()[0] || dialog).focus({ preventScroll: true });
    };
    const keydown = (event: KeyboardEvent) => {
      if (!isTopDialog() || event.key !== 'Tab' || event.defaultPrevented) return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last!.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (isTopDialog() && event.target instanceof Node && !dialog.contains(event.target)) focusStart();
    };
    focusStart();
    dialog.addEventListener('keydown', keydown);
    document.addEventListener('focusin', containFocus);
    return () => {
      dialog.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', containFocus);
      const wasTop = isTopDialog();
      const index = dialogStack.lastIndexOf(dialog);
      if (index !== -1) dialogStack.splice(index, 1);
      if (wasTop && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return ref;
}
