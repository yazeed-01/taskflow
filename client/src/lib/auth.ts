const KEY = 'taskflow.token';

// localStorage can throw (private mode, blocked storage); treat that as "signed out".
export const getToken = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const setToken = (token: string) => {
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* ignore */
  }
};

export const clearToken = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};
