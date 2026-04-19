import { writable } from 'svelte/store';

function createToastStore() {
  const { subscribe, update } = writable([]);
  let _id = 0;

  function show(message, type = 'info', duration = 3500) {
    const id = ++_id;
    update(list => [...list, { id, message, type }]);
    setTimeout(() => dismiss(id), duration);
    return id;
  }

  function dismiss(id) {
    update(list => list.filter(t => t.id !== id));
  }

  return {
    subscribe,
    show,
    dismiss,
    success: (msg, dur) => show(msg, 'success', dur),
    error:   (msg, dur) => show(msg, 'error', dur ?? 6000),
    warn:    (msg, dur) => show(msg, 'warn', dur),
    info:    (msg, dur) => show(msg, 'info', dur),
  };
}

export const toast = createToastStore();
