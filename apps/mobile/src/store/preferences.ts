import { create } from 'zustand';

/**
 * Local UI state only.
 *
 * Server state lives in TanStack Query and is never duplicated here — two copies
 * of the same truth is how a favourite ends up filled on one screen and hollow on
 * another. This store holds things the server has no opinion about: the current
 * filter draft, the last known coordinates, a dismissed prompt.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface SearchFilters {
  categoryIds: string[];
  maxPrice?: number;
  freeOnly?: boolean;
  radiusMeters: number;
  sort: 'RELEVANCE' | 'DISTANCE' | 'PRICE_ASC' | 'RATING' | 'SOONEST';
}

interface PreferencesState {
  /** Null until the user grants location or picks a city. */
  coordinates: Coordinates | null;
  cityId: string | null;
  locationPermission: 'undetermined' | 'granted' | 'denied';
  hasSeenLocationPrimer: boolean;
  filters: SearchFilters;

  setCoordinates: (coordinates: Coordinates | null) => void;
  setCityId: (cityId: string | null) => void;
  setLocationPermission: (status: PreferencesState['locationPermission']) => void;
  markLocationPrimerSeen: () => void;
  setFilters: (filters: Partial<SearchFilters>) => void;
  resetFilters: () => void;
}

export const DEFAULT_FILTERS: SearchFilters = {
  categoryIds: [],
  radiusMeters: 5000,
  sort: 'RELEVANCE',
};

export const usePreferences = create<PreferencesState>((set) => ({
  coordinates: null,
  cityId: null,
  locationPermission: 'undetermined',
  hasSeenLocationPrimer: false,
  filters: DEFAULT_FILTERS,

  setCoordinates: (coordinates) => set({ coordinates }),
  setCityId: (cityId) => set({ cityId }),
  setLocationPermission: (locationPermission) => set({ locationPermission }),
  markLocationPrimerSeen: () => set({ hasSeenLocationPrimer: true }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
}));
