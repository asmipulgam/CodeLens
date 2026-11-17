export const env = {
  /** True when the in-browser mock backend is active (local dev and demo builds only). */
  useMocks: import.meta.env.VITE_USE_MOCKS === 'true',
} as const;
