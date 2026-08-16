import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import type { ColorValue } from 'react-native';
import { typography } from '@try/design-tokens';
import { useTheme } from '@/theme';

/**
 * Five tabs, matching how people actually use the product: find something, see
 * it on a map, check what they booked, revisit what they saved, manage themselves.
 */
/**
 * L'onglet actif se distingue par le poids et la taille, pas seulement par la
 * couleur.
 *
 * La comparaison qui porte l'information n'est pas « actif contre fond » mais
 * « actif contre les quatre voisins ». Aucune couleur ne peut la tenir ici : sur
 * un fond clair, l'état actif doit être sombre pour être lisible, donc de
 * luminance voisine du gris inactif, donc à ~1,1:1 de lui. Une valeur assez
 * claire pour s'en détacher serait invisible sur la page. Le contraste WCAG ne
 * mesurant que la luminance, la teinte ne rattrape rien — et deux utilisateurs
 * sur cent ne la perçoivent pas.
 */
function TabIcon({
  glyph,
  color,
  focused,
}: {
  glyph: string;
  color: ColorValue;
  focused: boolean;
}) {
  return (
    <Text
      style={{ fontSize: focused ? 25 : 22, fontWeight: focused ? '900' : '400', color }}
      accessible={false}
    >
      {glyph}
    </Text>
  );
}

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accentText,
        tabBarInactiveTintColor: theme.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.background,
          borderTopColor: theme.border,
        },
        tabBarLabelStyle: {
          fontSize: typography.caption.fontSize,
        },
        tabBarLabel: ({ focused, color, children }) => (
          <Text style={{ fontSize: typography.caption.fontSize, fontWeight: focused ? '800' : '500', color }}>
            {children}
          </Text>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Explorer',
          tabBarIcon: ({ color, focused }) => <TabIcon glyph="◎" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: 'Carte',
          tabBarIcon: ({ color, focused }) => <TabIcon glyph="⌖" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="bookings"
        options={{
          title: 'Réservations',
          tabBarIcon: ({ color, focused }) => <TabIcon glyph="▤" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: 'Favoris',
          tabBarIcon: ({ color, focused }) => <TabIcon glyph="♥" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profil',
          tabBarIcon: ({ color, focused }) => <TabIcon glyph="◍" color={color} focused={focused} />,
        }}
      />
    </Tabs>
  );
}
