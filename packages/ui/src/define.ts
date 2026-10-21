/**
 * `customElements.define` throws if the name is taken. With micro-frontends that happens as soon as
 * the host and a remote both load this library (two bundles, or one shared and one not), so every
 * element is registered at most once, by whoever comes first.
 */
export function defineOnce(name: string, element: CustomElementConstructor): void {
  if (typeof customElements === 'undefined' || customElements.get(name)) return
  customElements.define(name, element)
}
