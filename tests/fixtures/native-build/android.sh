set -euo pipefail
[[ $(git rev-parse HEAD) == "$GITHUB_SHA" && $(git rev-parse --is-shallow-repository) == false ]]
[[ $RELEASE_SIGNING_ENABLED == false && ! -v RELEASE_KEYSTORE_BASE64 && ! -v RELEASE_KEYSTORE_PASSWORD && ! -v RELEASE_KEY_ALIAS && ! -v RELEASE_KEY_PASSWORD ]]
java -version 2>&1 | grep -E 'version "21\.'
test -f "$ANDROID_HOME/platforms/android-36/android.jar"
test -x "$ANDROID_HOME/build-tools/36.0.0/apksigner"
mkdir -p -- "$RELEASE_ARTIFACT_DIR"
printf '%s\n' "android $RELEASE_VERSION $GITHUB_SHA" > "$RELEASE_ARTIFACT_DIR/build.txt"
