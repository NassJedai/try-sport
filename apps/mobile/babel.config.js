/**
 * Configuration Babel de l'app mobile.
 *
 * Obligatoire, et son absence ne se voit ni au typecheck ni à la compilation du
 * bundle : l'app plante seulement à l'exécution, à l'import de Reanimated
 * (« Exception in HostFunction »).
 *
 * `babel-preset-expo` fait deux choses indispensables ici :
 *   - il transforme les « worklets » de Reanimated, ces fonctions qui doivent
 *     s'exécuter sur le thread d'animation plutôt que sur le thread JS — c'est
 *     ce qui garde les animations fluides quand l'app est occupée ;
 *   - il câble le routage par fichiers d'Expo Router.
 *
 * Le plugin worklets doit rester en DERNIER dans la liste des plugins.
 */
module.exports = function babelConfig(api) {
  api.cache(true);

  return {
    presets: [['babel-preset-expo', { unstable_transformImportMeta: true }]],
    plugins: ['react-native-worklets/plugin'],
  };
};
