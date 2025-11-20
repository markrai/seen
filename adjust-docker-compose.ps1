param(
    [string]$InputFile = "docker-compose.custom.yml",
    [string]$OutputFile = "docker-compose.custom.tmp.yml",
    [string]$Dockerfile = "Dockerfile",
    [int]$UseGPU = 0
)

$lines = Get-Content $InputFile
$output = @()
$inReservations = $false

foreach ($line in $lines) {
    # Replace dockerfile
    if ($line -match 'dockerfile:\s+Dockerfile') {
        $output += $line -replace 'dockerfile:\s+Dockerfile[^\s]*', "dockerfile: $Dockerfile"
    }
    # Skip GPU reservations section if not using GPU
    elseif (-not $UseGPU -and $line -match '^\s+reservations:') {
        $inReservations = $true
        continue
    }
    elseif ($inReservations) {
        # Check if we've exited the reservations section (next top-level key)
        if ($line -match '^\s+\w+:' -and -not $line -match '^\s+(devices|reservations):') {
            $inReservations = $false
            $output += $line
        }
        # Skip all lines within reservations section
        else {
            continue
        }
    }
    else {
        $output += $line
    }
}

$output | Set-Content $OutputFile

