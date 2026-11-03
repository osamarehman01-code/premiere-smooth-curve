@echo off
rem Installs Premiere Smooth Curve for the current Windows user (no admin needed).
setlocal
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.pronk.smooth"
echo Installing Premiere Smooth Curve to "%DEST%"
for %%v in (9 10 11 12 13) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul
robocopy "%~dp0." "%DEST%" /E /NFL /NDL /NJH /NJS /NP /XD .git .github tests docs /XF install.bat install.sh README.md LICENSE .gitignore >nul
if %ERRORLEVEL% GEQ 8 (echo Copy failed. & pause & exit /b 1)
echo Done. Restart Premiere Pro, then open Window ^> Extensions ^> Premiere Smooth Curve.
pause
