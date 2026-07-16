# Requires Admin Privileges
if (-Not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Please run this script as Administrator."
    Exit
}

$extensionName = "AutoCaps"
$sourcePath = "$PSScriptRoot\$extensionName"

# Changed to AppData\Roaming folder
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\$extensionName"

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

# 3. Install Models
# FIX: Added parentheses around (Test-Path $modelsDir)
if ((Test-Path $modelsDir) -and (Get-ChildItem $modelsDir)) {
    Write-Host "Models are already installed. Skipping..."
} else {
    Write-Host "Installing Models..."
    # OPTION A: If you put a "models" folder next to setup.ps1, it will copy it over:
    $localModelsFolder = "$PSScriptRoot\models"
    if (Test-Path $localModelsFolder) {
        Copy-Item -Path "$localModelsFolder\*" -Destination $modelsDir -Recurse -Force
        Write-Host "Models copied successfully from local folder."
    } else {
        Write-Host "No local 'models' folder found."
        
        # OPTION B: Download from URL
        <#
        $modelZipPath = "$env:TEMP\models.zip"
        $modelDownloadLink = "YOUR_MODEL_DOWNLOAD_LINK_HERE"
        Write-Host "Downloading models..."
        Import-Module BitsTransfer
        Start-BitsTransfer -Source $modelDownloadLink -Destination $modelZipPath -Description "Downloading Models" -DisplayName "AutoCaps Setup"
        Write-Host "Extracting models..."
        Expand-Archive -Path $modelZipPath -DestinationPath $modelsDir -Force
        Remove-Item $modelZipPath
        Write-Host "Models installed successfully."
        #>
    }
}

# 4. Check for NVIDIA GPU & Install CUDA
Write-Host "Checking for NVIDIA GPU..."
$gpu = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" }

if ($gpu) {
    Write-Host "NVIDIA GPU Detected: $($gpu.Name)"
    
    # FIX: Added parentheses around (Test-Path $cudaDir)
    if ((Test-Path $cudaDir) -and (Get-ChildItem $cudaDir)) {
        Write-Host "CUDA tools are already installed. Skipping download..."
    } else {
        $zipPath = "$env:TEMP\cuda.zip"
        $downloadLink = "enter_url_here"
        
        try {
            Write-Host "Downloading CUDA tools (This might take a moment)..."
            Import-Module BitsTransfer
            Start-BitsTransfer -Source $downloadLink -Destination $zipPath -Description "Downloading CUDA Pack" -DisplayName "AutoCaps Setup"
            
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