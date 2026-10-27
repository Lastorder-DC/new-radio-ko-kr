export function validEventKey(key) {
  return Number.isFinite(key) || (typeof key === 'string' && key.length > 0 && key.length <= 512);
}

export function eventWasPosted(key, previous, history = []) {
  if (history.includes(key)) return true;
  return typeof key === 'number' && typeof previous === 'number' ? key <= previous : key === previous;
}

export function rememberEvent(key, history = []) {
  return typeof key === 'string' ? [...new Set([...history, key])].slice(-128) : history;
}
