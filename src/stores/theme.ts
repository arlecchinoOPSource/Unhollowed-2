import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "light" | "dark";

export const useTheme = create<{ theme: Theme; toggleTheme: () => void }>()(
  persist(
    (set) => ({
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      toggleTheme: () =>
        set(({ theme }) => ({ theme: theme === "light" ? "dark" : "light" })),
    }),
    { name: "unhollowed-2-appearance" },
  ),
);

document.documentElement.dataset.theme = useTheme.getState().theme;
useTheme.subscribe(({ theme }) => {
  document.documentElement.dataset.theme = theme;
});
