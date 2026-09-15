# ============================================================
# Local File Hub service control script (start / stop on demand)
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\service.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts\service.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts\service.ps1 restart
#   powershell -ExecutionPolicy Bypass -File scripts\service.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\service.ps1 uninstall
# ============================================================
$ErrorActionPreference = 'Stop'
$action = $args[0]
$serviceName = 'LocalFileHub'

# Elevate for privileged actions (start/stop/restart/uninstall need Administrator)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($action -ne 'status' -and -not $isAdmin) {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $action"
    exit 0
}

switch ($action) {
    'start' {
        sc.exe start $serviceName
        Start-Sleep -Seconds 2
        sc.exe query $serviceName | Select-String 'STATE'
    }
    'stop' {
        sc.exe stop $serviceName
        Start-Sleep -Seconds 2
        sc.exe query $serviceName | Select-String 'STATE'
    }
    'restart' {
        sc.exe stop $serviceName
        Start-Sleep -Seconds 2
        sc.exe start $serviceName
        Start-Sleep -Seconds 2
        sc.exe query $serviceName | Select-String 'STATE'
    }
    'status' {
        $q = sc.exe query $serviceName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Service $serviceName is not installed."
        } else {
            $q | Select-String 'STATE|SERVICE_NAME'
        }
    }
    'uninstall' {
        sc.exe stop $serviceName 2>$null | Out-Null
        Start-Sleep -Seconds 1
        sc.exe delete $serviceName
        Write-Host "Service $serviceName uninstalled."
    }
    default {
        Write-Host 'Usage: service.ps1 <start|stop|restart|status|uninstall>'
        exit 1
    }
}
