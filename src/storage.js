// Browser storage that never throws. Private windows and some embedded
// viewers block localStorage; the game then simply forgets between visits.

export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not saved */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to remove */
    }
  },
};
