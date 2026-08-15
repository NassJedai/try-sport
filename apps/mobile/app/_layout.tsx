// Polyfill AVANT tout autre import applicatif — voir le fichier lui-même.
import '@/lib/crypto-polyfill';

import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { lightTheme, darkTheme } from '@try/design-tokens';
import { queryClient } from '@/api/query-client';
import { setUnauthenticatedHandler } from '@/api/client';
import { useIsDark } from '@/theme';

export default function RootLayout() {
  const router = useRouter();
  const isDark = useIsDark();
  const theme = isDark ? darkTheme : lightTheme;

  useEffect(() => {
    // One place decides what an expired session does, rather than every screen
    // handling its own 401.
    setUnauthenticatedHandler(() => {
      router.replace('/(auth)/sign-in');
    });
  }, [router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style={isDark ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.background },
              // Native stack animation; runs off the JS thread.
              animation: 'slide_from_right',
            }}
          >
            <Stack.Screen name="(tabs)" />
            {/* Ces groupes n'ont pas de _layout propre : chaque écran est une
                route de premier niveau et doit être nommé tel quel — nommer le
                groupe déclenche « No route named … » à chaque démarrage. */}
            <Stack.Screen name="(onboarding)/index" options={{ animation: 'fade' }} />
            <Stack.Screen name="(onboarding)/interests" options={{ animation: 'fade' }} />
            <Stack.Screen name="(onboarding)/location" options={{ animation: 'fade' }} />
            <Stack.Screen name="(auth)/sign-in" options={{ presentation: 'modal' }} />
            <Stack.Screen
              name="offer/[id]"
              options={{ animation: 'slide_from_right' }}
            />
            <Stack.Screen
              name="booking/[id]/qr"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
