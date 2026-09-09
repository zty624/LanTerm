export const $ = (id) => document.getElementById(id);

export function el(tag, className, value = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

export function text(node, value) {
  if (node.textContent !== String(value)) node.textContent = value;
}

// Reuse nodes so polling preserves focus and scroll position.
export function reconcile(parent, items, create, update) {
  const old = new Map([...parent.children].map((node) => [node.dataset.key, node]));
  items.forEach((item, index) => {
    const key = String(item.key);
    const node = old.get(key) || create(item);
    node.dataset.key = key;
    old.delete(key);
    update(node, item);
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  });
  for (const node of old.values()) node.remove();
}
