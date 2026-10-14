# Install/update the Local File Hub Windows service. Run from any directory.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serviceName = 'LocalFileHub'
$displayName = 'Local File Hub File Sharing Service'
$logDir = Join-Path $root 'logs'
$installLog = Join-Path $logDir 'service-install.log'

function Write-Result {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    Add-Content -Path $installLog -Value $line -Encoding UTF8
}

function Stop-WithError {
    param([string]$Message)
    Write-Result "ERROR: $Message"
    exit 1
}

# Service creation and control require an elevated token. Preserve the child exit
# code so an elevated install failure is visible to the original PowerShell.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Requesting Administrator elevation...'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $arguments
    exit $child.ExitCode
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Resolve runtime tools explicitly; SCM services do not inherit the interactive
# user's PATH, so the absolute node.exe path is stored in service.config.
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCommand -or -not (Test-Path -LiteralPath $nodeCommand.Source)) {
    Stop-WithError 'Node.js was not found. Install Node.js 22.12+ and reopen PowerShell.'
}
$node = $nodeCommand.Source
$nodeVersionText = (& $node --version 2>&1 | Out-String).Trim()
$nodeVersion = $nodeVersionText.TrimStart('v') -as [version]
if (-not $nodeVersion -or $nodeVersion -lt [version]'22.12') {
    Stop-WithError "Node.js 22.12+ is required; found '$nodeVersionText'."
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) { Stop-WithError 'npm.cmd was not found. Install the Node.js LTS distribution.' }
$npm = $npmCommand.Source
$runner = Join-Path $root 'scripts\service-runner.mjs'
$serverEntry = Join-Path $root 'dist\apps\server\src\index.js'
$envFile = Join-Path $root '.env'
$source = Join-Path $PSScriptRoot 'windows-service\LocalFileHubService.cs'
$serviceDir = Join-Path $root 'tools\service'
$wrapper = Join-Path $serviceDir 'LocalFileHubService.exe'
$configPath = Join-Path $serviceDir 'service.config'

if (-not (Test-Path -LiteralPath $runner)) { Stop-WithError "Service runner not found: $runner" }
if (-not (Test-Path -LiteralPath $source)) { Stop-WithError "Service wrapper source not found: $source" }
if (-not (Test-Path -LiteralPath $envFile)) {
    Stop-WithError 'Missing .env. Copy .env.example to .env and set ADMIN_USERNAME and a strong ADMIN_PASSWORD before installing the production service.'
}

# Production startup requires explicitly configured credentials. Use dotenv's
# parser so quoted values and spaces work, and never print the secret itself.
Push-Location $root
try {
    $credentialCheck = "import dotenv from 'dotenv'; import { readFileSync } from 'node:fs'; const env = dotenv.parse(readFileSync('.env')); if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || Buffer.byteLength(env.ADMIN_PASSWORD, 'utf8') < 12) { console.error('ADMIN_USERNAME and an ADMIN_PASSWORD of at least 12 bytes are required in .env.'); process.exit(1); }"
    & $node --input-type=module -e $credentialCheck
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Production admin credentials are missing or too short.' }
} finally {
    Pop-Location
}

# Build the production TypeScript output loaded by service-runner.mjs. Dependencies
# must already be installed (npm ci); the installer does not download packages.
Write-Result 'Building production application...'
Push-Location $root
try {
    & $npm run build
    if ($LASTEXITCODE -ne 0) { Stop-WithError "npm run build failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}
if (-not (Test-Path -LiteralPath $serverEntry)) { Stop-WithError "Build did not produce $serverEntry" }

# Windows 10/11 ships the .NET Framework compiler with the Framework runtime.
$compilerCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { Stop-WithError 'Could not find the .NET Framework C# compiler (csc.exe). Enable/install .NET Framework 4.x.' }
New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    Write-Result "Stopping existing $serviceName service before updating..."
    Stop-Service -Name $serviceName -Force
    $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
}

Write-Result 'Compiling Windows service wrapper...'
$compilerArgs = @('/nologo', '/target:winexe', "/out:$wrapper", '/r:System.ServiceProcess.dll', $source)
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $wrapper)) {
    Stop-WithError "Could not compile Windows service wrapper (csc exit code $LASTEXITCODE)."
}

# UTF-8 without BOM is read correctly by the .NET wrapper, including paths with
# non-ASCII characters. The parser splits on the first '=' only.
$configText = "node=$node`r`nrunner=$runner`r`nroot=$root`r`n"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($configPath, $configText, $utf8NoBom)
Write-Result "Service config written: $configPath"

if (-not $service) {
    Write-Result "Creating service $serviceName..."
    New-Service -Name $serviceName -BinaryPathName ('"' + $wrapper + '"') `
        -DisplayName $displayName -StartupType Automatic `
        -Description 'Local File Hub Fastify file sharing service.' | Out-Null
} else {
    # Keep upgrades in place and repair a stale/unquoted ImagePath if necessary.
    $binaryPath = '"' + $wrapper + '"'
    & sc.exe config $serviceName binPath= $binaryPath start= auto | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Could not update the existing service ImagePath.' }
    Set-Service -Name $serviceName -StartupType Automatic -Description 'Local File Hub Fastify file sharing service.'
}

& sc.exe failure $serviceName 'reset=' '86400' 'actions=' 'restart/5000/restart/10000/restart/30000' | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-WithError 'Could not configure automatic service recovery.' }

Write-Result "Starting service $serviceName..."
Start-Service -Name $serviceName
$service = Get-Service -Name $serviceName
$service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
Write-Result "Service is $($service.Status)."
Write-Result 'Install/update completed. Use scripts\service.ps1 <start|stop|restart|status|uninstall>.'
Write-Result "Application logs: $(Join-Path $logDir 'server.log'), service.out.log, service.err.log"
