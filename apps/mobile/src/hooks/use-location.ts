import { useCallback } from 'react';
import * as Location from 'expo-location';
import { usePreferences } from '@/store/preferences';

/**
 * Location access.
 *
 * The system dialog is only ever raised after our own primer screen has
 * explained why. Asking cold is the single fastest way to get a permanent denial,
 * and on iOS the OS prompt can only be shown once.
 */
export function useLocation() {
  const setCoordinates = usePreferences((state) => state.setCoordinates);
  const setLocationPermission = usePreferences((state) => state.setLocationPermission);
  const coordinates = usePreferences((state) => state.coordinates);
  const permission = usePreferences((state) => state.locationPermission);

  const request = useCallback(async (): Promise<boolean> => {
    const { status } = await Location.requestForegroundPermissionsAsync();

    if (status !== Location.PermissionStatus.GRANTED) {
      setLocationPermission('denied');
      return false;
    }

    setLocationPermission('granted');

    try {
      /**
       * Balanced accuracy, not Highest. Discovery ranks by "a few hundred metres";
       * GPS-grade precision would cost battery and a visible delay for nothing.
       */
      const position = await Location.getLastKnownPositionAsync({ maxAge: 300_000 });
      const resolved =
        position ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));

      setCoordinates({
        latitude: resolved.coords.latitude,
        longitude: resolved.coords.longitude,
      });
      return true;
    } catch {
      // Permission granted but no fix (indoors, airplane mode). The city
      // fallback keeps discovery working rather than showing an empty screen.
      return false;
    }
  }, [setCoordinates, setLocationPermission]);

  return { coordinates, permission, request };
}
