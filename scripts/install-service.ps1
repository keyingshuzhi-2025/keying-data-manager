# ============================================================
# Local File Hub service installer (requires Administrator, auto UAC)
# Wraps the Node.js app in a real SCM service (C# wrapper),
# with auto-restart on crash and file logging.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
# ============================================================
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:LogFile = Join-Path $root 'logs\service-install.log'
New-Item -ItemType Directory -Force -Path (Split-Path $script:LogFile) | Out-Null

function Write-Result {
    param([string]$Message, [int]$Code = 0)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    Add-Content -Path $script:LogFile -Value $line -Encoding UTF8
    if ($Code -ne 0) { exit $Code }
}

# ---- 1. Elevate to Administrator ----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Result 'Not running as Administrator, requesting UAC elevation...'
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Write-Result 'Elevated instance finished. See log above.'
    exit 0
}

# ---- 2. Validate environment ----
$node = (Get-Command node -ErrorAction Stop).Source
$wrapper = Join-Path $root 'tools\service\LocalFileHubService.exe'
$runner = Join-Path $root 'scripts\service-runner.mjs'
$serviceName = 'LocalFileHub'
$displayName = 'Local File Hub File Sharing Service'
if (-not (Test-Path $wrapper)) { Write-Result "Wrapper not found: $wrapper (compile tools\service\LocalFileHubService.cs first)" 1 }
if (-not (Test-Path $runner)) { Write-Result "Runner not found: $runner" 1 }

# ---- 3. Remove existing service with same name ----
sc.exe stop $serviceName 2>$null | Out-Null
Start-Sleep -Seconds 1
sc.exe delete $serviceName 2>$null | Out-Null
Start-Sleep -Seconds 1

# ---- 4. Generate wrapper config (node / runner / root) ----
$configPath = Join-Path (Split-Path $wrapper) 'service.config'
$configText = "node=$node`r`nrunner=$runner`r`nroot=$root`r`n"
Set-Content -Path $configPath -Value $configText -Encoding ASCII
Write-Result "Wrapper config written: $configPath"

# ---- 5. Create service (C# wrapper exe as service binary, no spaces in path) ----
Write-Result "Creating service $serviceName ..."
try {
    New-Service -Name $serviceName -BinaryPathName $wrapper -DisplayName $displayName `
        -StartupType Automatic -Description 'LAN file sharing service (Local File Hub), Fastify + better-sqlite3.' | Out-Null
    Write-Result 'Service created.'
} catch {
    Write-Result "Failed to create service: $($_.Exception.Message)" 1
}

# ---- 6. Auto restart on crash: restart after 5s, then 10s/30s backoff ----
sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
Write-Result 'Failure recovery configured (auto restart on crash).'

# ---- 7. Start the service ----
$start = sc.exe start $serviceName 2>&1
Write-Result "sc start output: $($start -join ' ')"
Start-Sleep -Seconds 4
$query = sc.exe query $serviceName 2>&1 | Select-String 'STATE'
Write-Result "Service state: $($query -join ' ')"

Write-Result 'Install done! Control commands:'
Write-Result '  start       sc start LocalFileHub  (or scripts\service.ps1 start)'
Write-Result '  stop        sc stop LocalFileHub   (or scripts\service.ps1 stop)'
Write-Result '  status      sc query LocalFileHub  (or scripts\service.ps1 status)'
Write-Result '  logs        logs\server.log, logs\service.out.log'
exit 0
