$extensionName = "AutoCaps-AE"
$sourceAE      = Join-Path $PSScriptRoot "ae"
$sourceBackend = Join-Path $PSScriptRoot "backend"

function Download-File-Fast {
    param ([string]$Url, [string]$Path)
    [System.Net.ServicePointManager]::CheckCertificateRevocationList = $false
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            curl.exe --ssl-no-revoke -L -o $Path $Url
            if ((Test-Path $Path) -and (Get-Item $Path).Length -gt 0) {
                $ProgressPreference = $oldProgress
                return
            }
        }
        $client = New-Object System.Net.Http.HttpClient
        $response = $client.GetAsync($Url).Result
        if ($response.IsSuccessStatusCode) {
            $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Create)
            $response.Content.CopyToAsync($fs).Wait()
            $fs.Close()
        }
        $client.Dispose()
    } catch {
        Write-Warning "Fast download failed. Trying fallback BITS transfer..."
        Import-Module BitsTransfer
        Start-BitsTransfer -Source $Url -Destination $Path -Description "AutoCaps Download Fallback"
    } finally {
        $ProgressPreference = $oldProgress
    }
}

# 1. התקנת קבצי ה-CEP של After Effects (תיקייה נפרדת מ"AutoCaps" של פרמייר,
#    כך ששני הפאנלים יכולים להיות מותקנים במקביל בלי להתנגש)
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionName"
Write-Host "Installing After Effects Extension..." -ForegroundColor Cyan

if (Test-Path $sourceAE) {
    if (!(Test-Path $cepDir)) {
        New-Item -ItemType Directory -Force -Path $cepDir | Out-Null
    }
    Copy-Item -Path "$sourceAE\*" -Destination $cepDir -Recurse -Force
    Write-Host "Successfully installed to: $cepDir" -ForegroundColor Green
} else {
    Write-Error "Source folder 'ae' not found! Make sure you didn't rename it."
    Exit 1
}

# 2. תיקיית ה-Backend המשותפת (זהה לגרסת פרימייר - נמנע מהורדה כפולה של המודל/CUDA)
$autoCapsDir = "$env:LOCALAPPDATA\AutoCaps"
$backendDir  = "$autoCapsDir\backend"
$modelsDir   = "$autoCapsDir\models"
$cudaDir     = "$autoCapsDir\cuda"

$dirs = @($autoCapsDir, $backendDir, $modelsDir, $cudaDir)
foreach ($dir in $dirs) {
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

Write-Host "Installing transcription engine..." -ForegroundColor Cyan
if (Test-Path $sourceBackend) {
    Copy-Item -Path "$sourceBackend\*" -Destination $backendDir -Recurse -Force
    Write-Host "Backend engine installed successfully." -ForegroundColor Green
} else {
    Write-Warning "Source folder 'backend' not found. Skipping backend files copy (fine if the Premiere version already installed it)."
}

# 3. GPU check (same as Premiere installer)
Write-Host "Checking for NVIDIA GPU..." -ForegroundColor Cyan
$gpu = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" }
if ($gpu) {
    Write-Host "NVIDIA GPU detected: $($gpu.Name)" -ForegroundColor Green
    if (-not ((Test-Path $cudaDir) -and (Get-ChildItem $cudaDir))) {
        Write-Host "Downloading CUDA toolkit dependencies..." -ForegroundColor Yellow
        $zipPath = "$env:TEMP\cuda.zip"
        $downloadLink = "https://github.com/neriacohen300/AutoCaps/releases/download/CUDA/cuda-toolkit-download.zip"
        try {
            Download-File-Fast -Url $downloadLink -Path $zipPath
            Expand-Archive -Path $zipPath -DestinationPath $cudaDir -Force
            Remove-Item $zipPath -Force
            Write-Host "CUDA tools installed successfully." -ForegroundColor Green
        } catch {
            Write-Warning "Could not download CUDA. The engine will fall back to CPU."
        }
    } else {
        Write-Host "CUDA tools already installed." -ForegroundColor Green
    }
} else {
    Write-Host "No NVIDIA GPU detected. Subtitles will run on CPU mode." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Installation Completed!" -ForegroundColor Green
Write-Host "IMPORTANT: You still need to do ONE manual step inside After Effects" -ForegroundColor Yellow
Write-Host "before AutoCaps can render audio. See README_AE.txt." -ForegroundColor Yellow
