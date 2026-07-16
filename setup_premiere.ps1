$extensionName = "AutoCaps"
$sourcePremiere = Join-Path $PSScriptRoot "premiere"
$sourceBackend  = Join-Path $PSScriptRoot "backend"

# פונקציית הורדה מהירה במיוחד
function Download-File-Fast {
    param (
        [string]$Url,
        [string]$Path
    )
    # ביטול בדיקת ביטול תעודות אבטחה עבור .NET (פותר את הבעיה ב-PowerShell)
    [System.Net.ServicePointManager]::CheckCertificateRevocationList = $false
    
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    
    try {
        # ניסיון 1: שימוש ב-curl המובנה של ווינדוס עם עקיפת בדיקת ה-Revocation
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            Write-Host "Downloading via curl (Max Speed with SSL fix)..." -ForegroundColor Gray
            # הוספנו --ssl-no-revoke כדי לפתור את שגיאה 35
            curl.exe --ssl-no-revoke -L -o $Path $Url
            if ((Test-Path $Path) -and (Get-Item $Path).Length -gt 0) {
                $ProgressPreference = $oldProgress
                return
            }
        }
        
        # ניסיון 2: שימוש ב-.NET HttpClient המהיר
        Write-Host "Downloading via .NET HttpClient..." -ForegroundColor Gray
        $client = New-Object System.Net.Http.HttpClient
        $response = $client.GetAsync($Url).Result
        if ($response.IsSuccessStatusCode) {
            $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Create)
            $response.Content.CopyToAsync($fs).Wait()
            $fs.Close()
        }
        $client.Dispose()
    }
    catch {
        # ניסיון 3: פולבק אחרון ל-BITS במקרה של תקלה
        Write-Warning "Fast download failed. Trying fallback BITS transfer..."
        Import-Module BitsTransfer
        Start-BitsTransfer -Source $Url -Destination $Path -Description "AutoCaps Download Fallback"
    }
    finally {
        $ProgressPreference = $oldProgress
    }
}

# 1. התקנת קבצי ה-CEP של פרמייר
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionName"
Write-Host "Installing Premiere Pro Extension..." -ForegroundColor Cyan

if (Test-Path $sourcePremiere) {
    if (!(Test-Path $cepDir)) {
        New-Item -ItemType Directory -Force -Path $cepDir | Out-Null
    }
    Copy-Item -Path "$sourcePremiere\*" -Destination $cepDir -Recurse -Force
    Write-Host "Successfully installed to: $cepDir" -ForegroundColor Green
} else {
    Write-Error "Source folder 'premiere' not found! Make sure you didn't rename it."
    Exit 1
}

# 2. הגדרת תיקיית המערכת המשותפת ב-AppData Local (ה-Backend בתוך תיקיית AutoCaps)
$autoCapsDir = "$env:LOCALAPPDATA\AutoCaps"
$backendDir  = "$autoCapsDir\backend"
$modelsDir   = "$autoCapsDir\models"
$cudaDir     = "$autoCapsDir\cuda"

# יצירת התיקיות
$dirs = @($autoCapsDir, $backendDir, $modelsDir, $cudaDir)
foreach ($dir in $dirs) {
    if (!(Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
}

# 3. העתקת קבצי ה-Backend (ה-EXE ותיקיית _internal לתוך AutoCaps\backend)
Write-Host "Installing transcription engine..." -ForegroundColor Cyan
if (Test-Path $sourceBackend) {
    Copy-Item -Path "$sourceBackend\*" -Destination $backendDir -Recurse -Force
    Write-Host "Backend engine installed successfully." -ForegroundColor Green
} else {
    Write-Warning "Source folder 'backend' not found. Skipping backend files copy."
}

# 4. בדיקת כרטיס מסך של NVIDIA והורדת CUDA מהירה
Write-Host "Checking for NVIDIA GPU..." -ForegroundColor Cyan
$gpu = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" }

if ($gpu) {
    Write-Host "NVIDIA GPU detected: $($gpu.Name)" -ForegroundColor Green
    if ((Test-Path $cudaDir) -and (Get-ChildItem $cudaDir)) {
        Write-Host "CUDA tools already installed." -ForegroundColor Green
    } else {
        Write-Host "Downloading CUDA toolkit dependencies (Optimized Speed)..." -ForegroundColor Yellow
        $zipPath = "$env:TEMP\cuda.zip"
        
        # החלף את הקישור כאן בקישור ל-CUDA ZIP שלך
        $downloadLink = "https://github.com/neriacohen300/AutoCaps/releases/download/CUDA/cuda-toolkit-download.zip" 
        
        try {
            Download-File-Fast -Url $downloadLink -Path $zipPath
            Write-Host "Extracting CUDA tools to $cudaDir..." -ForegroundColor Yellow
            Expand-Archive -Path $zipPath -DestinationPath $cudaDir -Force
            Remove-Item $zipPath -Force
            Write-Host "CUDA tools installed successfully." -ForegroundColor Green
        } catch {
            Write-Warning "Could not download CUDA. The engine will fall back to CPU."
        }
    }
} else {
    Write-Host "No NVIDIA GPU detected. Subtitles will run on CPU mode." -ForegroundColor Yellow
}

Write-Host "Installation Completed! Please restart Premiere Pro." -ForegroundColor Green