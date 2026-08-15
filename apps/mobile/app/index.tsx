import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { getSecureItem } from '@/api/secure-storage';
import { useTheme } from '@/theme';

/**
 * La porte d'entrée de l'app.
 *
 * Avant elle, la route « / » ÉTAIT l'onboarding : chaque lancement remontrait
 * les slides de bienvenue, y compris à quelqu'un de connecté depuis des
 * semaines. Vu sur simulateur pendant le crible — l'onboarding est un péage
 * qu'on ne fait payer qu'une fois.
 *
 * La décision se fonde sur la présence d'un jeton de rafraîchissement, pas sur
 * sa validité : c'est un choix d'AIGUILLAGE, pas d'authentification. Un jeton
 * mort échouera proprement au premier appel authentifié, là où la session se
 * renouvelle ou se ferme — décider ici exigerait un aller-retour réseau avant
 * le premier écran, le pire moment pour en payer un.
 */
export default function EntryGate() {
  const theme = useTheme();
  const [destination, setDestination] = useState<'tabs' | 'welcome' | null>(null);

  useEffect(() => {
    let alive = true;

    void getSecureItem('try.refreshToken').then(
      (token) => {
        if (alive) setDestination(token ? 'tabs' : 'welcome');
      },
      () => {
        // Trousseau illisible : on retombe sur l'accueil public, jamais sur un
        // écran cassé.
        if (alive) setDestination('welcome');
      },
    );

    return () => {
      alive = false;
    };
  }, []);

  // Une frame ou deux le temps de lire le trousseau — un fond de la bonne
  // couleur suffit, un spinner ne ferait que clignoter.
  if (destination === null) {
    return <View style={{ flex: 1, backgroundColor: theme.background }} />;
  }

  return <Redirect href={destination === 'tabs' ? '/(tabs)' : ('/(onboarding)/welcome' as never)} />;
}
