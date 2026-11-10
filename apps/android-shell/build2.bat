@echo off
cd /d "%~dp0"
if not exist build\classes mkdir build\classes
"D:\Program Files\Android\sdk\build-tools\34.0.0\aapt2.exe" compile --dir res -o build\res.zip || exit /b 1
"D:\Program Files\Android\sdk\build-tools\34.0.0\aapt2.exe" link -I "D:\Program Files\Android\sdk\platforms\android-34\android.jar" --manifest AndroidManifest.xml build\res.zip -o build_base.apk || exit /b 1
rd /s /q build\classes 2>nul
mkdir build\classes
"D:\Program Files\Android\Android Studio\jbr\bin\javac.exe" -source 8 -target 8 -bootclasspath "D:\Program Files\Android\sdk\platforms\android-34\android.jar;D:\Program Files\Android\sdk\build-tools\34.0.0\core-lambda-stubs.jar" -d build\classes src\com\myco\phone\*.java || exit /b 1
rem 2026-09-29: d8 改喂 classes.jar 全量（原 4-class 显式列表漏 PermChrome/PageSeen/FileOpen 等顶层类，
rem 一路靠历史残留 classes.dex 兜底=埋雷；与 run_d8.bat 同做法，jar 也免疫散 .class 的 d8 NPE）。
"D:\Program Files\Android\Android Studio\jbr\bin\jar.exe" cf build\classes.jar -C build\classes . || exit /b 1
java -cp "D:\Program Files\Android\sdk\build-tools\36.1.0\lib\d8.jar" com.android.tools.r8.D8 --lib "D:\Program Files\Android\sdk\platforms\android-34\android.jar" --release --min-api 24 --output build build\classes.jar || exit /b 1
python _pack.py || exit /b 1
"D:\Program Files\Android\sdk\build-tools\34.0.0\zipalign.exe" -f 4 myco-phone.apk myco-phone-aligned.apk || exit /b 1
call run_sign.bat || exit /b 1
echo BUILD OK
