# Horizons Android app (Capacitor wrapper)

This folder wraps the web editor (`newIDE/app`) into a native Android app
using Capacitor. The AI features (BYOK GLM + Gemini team) run inside the
WebView and call the providers directly (both Z.ai and Google allow
browser/CORS calls, verified for the `https://localhost` Capacitor origin).

## Build the APK

Prerequisites: Node 18+, JDK 21 (full JDK with javac), Android SDK
(platform 36, build-tools 35.0.0, platform-tools).

```bash
# 1. Build the web editor (from the repo root)
cd newIDE/app
npm install          # downloads prebuilt libGD.js automatically
npm run build        # -> newIDE/app/build

# 2. Copy the web build into the wrapper and sync
cd ../../android-app
npm install
mkdir -p www
cp -r ../newIDE/app/build/* www/
npx cap sync android

# 3. Sign (one-time): create android/keystore.properties with
#    storeFile=<path to your .keystore>, storePassword=..., keyAlias=..., keyPassword=...
#    (see app/build.gradle - release signing reads keystore.properties)

# 4. Build
cd android
export ANDROID_HOME=/path/to/android-sdk
./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

Without a keystore the release build fails at `validateSigningRelease`;
you can build an unsigned/debug APK instead with `./gradlew assembleDebug`.
