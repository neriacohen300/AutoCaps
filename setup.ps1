# Requires Admin Privileges
if (-Not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Please run this script as Administrator."
    Exit
}

$extensionName = "AutoCaps"
$sourcePath = "$PSScriptRoot\$extensionName"

# Changed to AppData\Roaming folder
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionName"

# פונקציית הורדה חכמה וחסינת תקלות עם Fallback
function Download-File {
    param (
        [string]$Url,
        [string]$Path
    )
    Write-Host "Downloading $Url to $Path..."
    
    # ביטול זמני של ה-Progress Bar ב-Invoke-WebRequest למניעת איטיות בגרסאות PowerShell ישנות
    $oldProgressPreference = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    
    try {
        # ניסיון ראשון בעזרת BITS (הכי יציב להורדות גדולות עם פס התקדמות מערכתי)
        Start-BitsTransfer -Source $Url -Destination $Path -ErrorAction Stop
    } catch {
        Write-Warning "BITS transfer failed. Retrying with Invoke-WebRequest..."
        try {
            Invoke-WebRequest -Uri $Url -OutFile $Path -ErrorAction Stop
        } catch {
            Write-Warning "Invoke-WebRequest failed. Trying with .NET WebClient..."
            try {
                $webClient = New-Object System.Net.WebClient
                $webClient.DownloadFile($Url, $Path)
            } catch {
                $ProgressPreference = $oldProgressPreference
                throw "Failed to download $Url. Error: $_"
            }
        }
    }
    
    $ProgressPreference = $oldProgressPreference
}

# 1. Install Extension to Premiere Pro CEP Folder
Write-Host "Installing AutoCaps Extension..."
if (!(Test-Path $cepDir)) {
    New-Item -ItemType Directory -Force -Path $cepDir | Out-Null
}
Copy-Item -Path "$sourcePath\*" -Destination $cepDir -Recurse -Force
Write-Host "Extension installed in Roaming AppData."

# 2. Setup AppData\Local Directories
$localAppData = $env:LOCALAPPDATA
$autoCapsDir = "$localAppData\AutoCaps"
$modelsDir = "$autoCapsDir\models"
$cudaDir = "$autoCapsDir\cuda"

Write-Host "Creating Directories..."
if (!(Test-Path $modelsDir)) { New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null }
if (!(Test-Path $cudaDir)) { New-Item -ItemType Directory -Force -Path $cudaDir | Out-Null }


# 3. Check for NVIDIA GPU & Install CUDA
Write-Host "Checking for NVIDIA GPU..."
$gpu = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" }

if ($gpu) {
    Write-Host "NVIDIA GPU Detected: $($gpu.Name)"
    
    if ((Test-Path $cudaDir) -and (Get-ChildItem $cudaDir)) {
        Write-Host "CUDA tools are already installed. Skipping download..."
    } else {
        $zipPath = "$env:TEMP\cuda.zip"
        $downloadLink = "https://github.com/neriacohen300/AutoCaps/releases/download/CUDA/cuda-toolkit-download.zip"
        
        try {
            Write-Host "Downloading CUDA tools (This might take a moment)..."
            Download-File -Url $downloadLink -Path $zipPath
            
            Write-Host "`nExtracting CUDA tools to $cudaDir..."
            Expand-Archive -Path $zipPath -DestinationPath $cudaDir -Force
            
            Remove-Item $zipPath
            Write-Host "CUDA tools installed successfully in AutoCaps folder."
        } catch {
            Write-Warning "Failed to download or extract CUDA tools: $_"
        }
    }
} else {
    Write-Host "No NVIDIA GPU detected. Skipping CUDA download (CPU mode will be required)."
}

Write-Host "Installation Complete! Please restart Premiere Pro."