# Control the Local File Hub Windows service.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\service.ps1 <start|stop|restart|status|uninstall>
param([string]$Action)

$ErrorActionPreference = 'Stop'
$serviceName = 'LocalFileHub'
$Action = $Action.ToLowerInvariant()

if ($Action -notin @('start', 'stop', 'restart', 'status', 'uninstall')) {
    Write-Host 'Usage: service.ps1 <start|stop|restart|status|uninstall>'
    exit 2
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Action -ne 'status' -and -not $isAdmin) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $Action"
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $arguments
    exit $child.ExitCode
}

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "Service $serviceName is not installed."
    if ($Action -eq 'status') { exit 3 }
    exit 1
}

switch ($Action) {
    'start' {
        if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
            Start-Service -Name $serviceName
            $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
        }
    }
    'stop' {
        if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
            Stop-Service -Name $serviceName -Force
            $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
        }
    }
    'restart' {
        if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
            Stop-Service -Name $serviceName -Force
            $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
        }
        Start-Service -Name $serviceName
        $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
    }
    'status' {
        $service.Refresh()
        Write-Host "${serviceName}: $($service.Status)"
        exit 0
    }
    'uninstall' {
        if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
            Stop-Service -Name $serviceName -Force
            $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(30))
        }
        & sc.exe delete $serviceName
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Write-Host "Service $serviceName removed. Windows may finish deleting it after open handles close."
        exit 0
    }
}

$service.Refresh()
Write-Host "${serviceName}: $($service.Status)"
