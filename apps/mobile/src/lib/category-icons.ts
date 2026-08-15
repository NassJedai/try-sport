/**
 * L'emoji de chaque discipline, indexé par le slug d'icône du référentiel.
 *
 * Des emoji plutôt qu'une police d'icônes : zéro dépendance, zéro chargement,
 * rendu natif sur chaque plateforme — exactement le choix d'Airbnb pour ses
 * premières barres de catégories. La table vit côté client parce que c'est une
 * décision de PRÉSENTATION : le serveur dit « dumbbell », chaque client en fait
 * ce que son medium rend le mieux.
 *
 * Le repli est un emoji neutre : une discipline ajoutée côté serveur apparaît
 * sobre plutôt que cassée, sans mise à jour de l'app.
 */
const ICONS: Record<string, string> = {
  dumbbell: '🏋️',
  zap: '⚡',
  flower: '🤸',
  lotus: '🧘',
  'boxing-glove': '🥊',
  kettlebell: '💪',
  bike: '🚴',
  racket: '🏓',
  'tennis-ball': '🎾',
  mountain: '🧗',
  music: '💃',
  waves: '🏊',
  sword: '🥋',
  'user-check': '🎯',
  'heart-pulse': '💆',
  footprints: '🏃',
};

export function categoryEmoji(icon: string): string {
  return ICONS[icon] ?? '🏅';
}
