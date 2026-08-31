#!/usr/bin/env bash
# Lance le filet de fumée Maestro sur le simulateur iOS déjà démarré, avec
# Expo Go installé et le bundler Metro déjà en écoute sur :8081
# (`pnpm --filter @try/mobile dev`, ou `pnpm mobile`).
#
# Maestro est un binaire externe (~/.maestro/bin), pas une dépendance npm du
# dépôt — voir CLAUDE.md, la règle Expo sur les dépendances natives ne
# s'applique pas ici. Il embarque son propre CLI mais a besoin d'une JVM pour
# tourner. Si aucune n'est installée sur la machine (pas de droits admin pour
# `brew install openjdk`), utiliser un JDK portable téléchargé dans le home :
#
#   curl -fsSL -o /tmp/temurin21.tar.gz \
#     "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
#   mkdir -p ~/.local/jdk && tar -xzf /tmp/temurin21.tar.gz -C ~/.local/jdk
#   mv ~/.local/jdk/jdk-*/ ~/.local/jdk/current
#
# Ce script détecte ce JDK portable s'il existe et si aucun JAVA_HOME n'est
# déjà défini ; sinon Maestro utilise la JVM système normalement.
set -euo pipefail

if [ -z "${JAVA_HOME:-}" ] && [ -x "$HOME/.local/jdk/current/Contents/Home/bin/java" ]; then
  export JAVA_HOME="$HOME/.local/jdk/current/Contents/Home"
fi

if ! command -v maestro >/dev/null 2>&1; then
  echo "maestro introuvable. Installe-le avec : curl -fsSL https://get.maestro.mobile.dev | bash" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec maestro test "$SCRIPT_DIR/smoke.yaml"
