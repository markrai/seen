try {
    $gpus = Get-CimInstance Win32_VideoController -ErrorAction Stop
    $found = $false
    
    foreach ($gpu in $gpus) {
        if (($gpu.Name -like '*NVIDIA*') -or 
            ($gpu.AdapterCompatibility -like '*NVIDIA*') -or 
            ($gpu.PNPDeviceID -like '*VEN_10DE*')) {
            $found = $true
            break
        }
    }
    
    if ($found) {
        Write-Output '1'
    } else {
        Write-Output '0'
    }
} catch {
    Write-Output '0'
}

