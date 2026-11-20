$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$artifactDir = "C:\Users\sankh\.gemini\antigravity\brain\b60fb957-d163-40db-99a7-8f3ec1865193"

function Take-Snap($url, $file, $delay=3000) {
    $outPath = Join-Path $artifactDir $file
    Write-Host "Capturing $file from $url ..."
    cmd.exe /c "`"$chrome`" --headless=new --screenshot=`"$outPath`" --window-size=1440,900 --virtual-time-budget=$delay $url" | Out-Null
    if (Test-Path $outPath) {
        $len = (Get-Item $outPath).Length
        Write-Host "âœ“ Captured $file ($len bytes)"
    } else {
        Write-Host "âœ— Failed to capture $file"
    }
}

# 1. Overview
Take-Snap "http://localhost:4600/?view=overview" "01_overview_dashboard.png" 3000

# 2. Run Demo Use Case
Write-Host "Running PR #418 Code Review & Security Swarm Use Case..."
$res = Invoke-RestMethod -Uri "http://localhost:4600/api/demo/run-usecase" -Method Post
Write-Host "âœ“ Swarm executed: $($res.useCase) (Root: $($res.rootId), SecChild: $($res.secChildId))"
Take-Snap "http://localhost:4600/?view=overview" "02_demo_swarm_executed.png" 3000

# 3. Terminal & Steer Drawer
Take-Snap "http://localhost:4600/?view=overview&drawer=true" "03_terminal_steer_drawer.png" 3500

# 4. Sandboxes Fleet
Take-Snap "http://localhost:4600/?view=sandboxes" "04_sandboxes_fleet.png" 3000

# 5. Audit & Replay Ledger
Take-Snap "http://localhost:4600/?view=ledger" "05_audit_replay_ledger.png" 3000

# 6. Memory Core
Take-Snap "http://localhost:4600/?view=memory" "06_memory_core_subsystem.png" 3000

# 7. Security & Workflows
Take-Snap "http://localhost:4600/?view=security" "07_security_workflows.png" 3000

# 8. OneCLI Runner
Take-Snap "http://localhost:4600/?onecli=true" "08_onecli_runner.png" 3500

Write-Host "All snapshots captured successfully!"
