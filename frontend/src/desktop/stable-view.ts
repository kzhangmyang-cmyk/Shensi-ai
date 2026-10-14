/** Patch existing view nodes so background observations cannot detach focused controls. */
export function patchStableView(host: HTMLElement, html: string): void {
  const template = host.ownerDocument.createElement("template");
  template.innerHTML = html;
  const key = (node: Node): string => {
    if (node.nodeType !== 1) return String(node.nodeType);
    const element = node as Element;
    return [element.tagName, element.id || element.getAttribute("data-view-key")
      || element.getAttribute("data-candidate-id") || element.getAttribute("name")
      || element.getAttribute("data-outreach-review") || element.getAttribute("data-douyin-action")
      || element.getAttribute("class")?.split(/\s+/u)[0] || ""].join(":");
  };
  const patch = (parent: Node, desired: Node) => {
    const remaining = [...parent.childNodes];
    let cursor = parent.firstChild;
    for (const next of [...desired.childNodes]) {
      const index = remaining.findIndex((node) => key(node) === key(next));
      const current = index < 0 ? next.cloneNode(true) : remaining.splice(index, 1)[0]!;
      if (current !== cursor) parent.insertBefore(current, cursor);
      if (current.nodeType === 1 && next.nodeType === 1) {
        const element = current as HTMLElement;
        const target = next as HTMLElement;
        const preserveOpen = element.tagName === "DETAILS";
        for (const attribute of [...element.attributes]) {
          if (preserveOpen && attribute.name === "open") continue;
          if (!target.hasAttribute(attribute.name)) element.removeAttribute(attribute.name);
        }
        for (const attribute of [...target.attributes]) {
          if (preserveOpen && attribute.name === "open") continue;
          if (element.getAttribute(attribute.name) !== attribute.value) element.setAttribute(attribute.name, attribute.value);
        }
        if (element.tagName === "INPUT") {
          const input = element as HTMLInputElement;
          const targetInput = target as HTMLInputElement;
          if (input.value !== targetInput.value) input.value = targetInput.value;
          input.checked = targetInput.checked;
        } else if (element.tagName === "TEXTAREA") {
          const input = element as HTMLTextAreaElement;
          if (input.value !== (target as HTMLTextAreaElement).value) input.value = (target as HTMLTextAreaElement).value;
        }
        if (!target.hasAttribute("data-stable-preserve-children")) {
          patch(current, next);
        }
      } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      cursor = current.nextSibling;
    }
    remaining.forEach((node) => parent.removeChild(node));
  };
  patch(host, template.content);
}
