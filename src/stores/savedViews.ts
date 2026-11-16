import { create } from "zustand";
import { listSavedViews, type SavedView } from "../database/savedViews";

/**
 * Saved views shared by the sidebar and the issue list and board, so a
 * change in one place shows everywhere without reloading.
 */
export const useSavedViews = create<{
  views: SavedView[] | null;
  load: () => Promise<void>;
  put: (view: SavedView) => void;
  drop: (id: string) => void;
}>()((set) => ({
  views: null,
  load: async () => {
    try {
      set({ views: await listSavedViews() });
    } catch {
      set((state) => ({ views: state.views ?? [] }));
    }
  },
  put: (view) =>
    set((state) => ({
      views: [
        ...(state.views ?? []).filter(({ id }) => id !== view.id),
        view,
      ].sort((a, b) => a.name.localeCompare(b.name)),
    })),
  drop: (id) =>
    set((state) => ({
      views: (state.views ?? []).filter((view) => view.id !== id),
    })),
}));
