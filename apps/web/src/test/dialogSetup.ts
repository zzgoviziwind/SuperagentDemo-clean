// jsdom does not implement native modal state, autofocus, or focus restoration.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  const invokers = new WeakMap<HTMLDialogElement, HTMLElement>();
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) {
      if (document.activeElement instanceof HTMLElement) invokers.set(this, document.activeElement);
      this.open = true;
      (this.querySelector<HTMLElement>("[autofocus]") ?? this.querySelector("button"))?.focus();
    } },
    close: { configurable: true, value(this: HTMLDialogElement) {
      this.open = false;
      invokers.get(this)?.focus();
      invokers.delete(this);
    } },
  });
}
