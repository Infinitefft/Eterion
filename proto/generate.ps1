[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
$pluginDir = Join-Path $repoRoot ".cache\grpc-tools"
$protoFile = "eterion_agent/agent.proto"
$goModule = "github.com/Infinitefft/Eterion/services/api"

if (-not (Test-Path -LiteralPath $pythonExe)) {
    throw "Python virtual environment not found at $pythonExe"
}

foreach ($plugin in @("protoc-gen-go.exe", "protoc-gen-go-grpc.exe")) {
    $pluginPath = Join-Path $pluginDir $plugin
    if (-not (Test-Path -LiteralPath $pluginPath)) {
        throw "Required protobuf plugin not found at $pluginPath"
    }
}

$env:Path = "$pluginDir;$env:Path"

Push-Location $repoRoot
try {
    & $pythonExe -m grpc_tools.protoc `
        -Iproto `
        --go_out=services/api `
        "--go_opt=module=$goModule" `
        --go-grpc_out=services/api `
        "--go-grpc_opt=module=$goModule" `
        --python_out=services/agent/src `
        --pyi_out=services/agent/src `
        --grpc_python_out=services/agent/src `
        $protoFile

    if ($LASTEXITCODE -ne 0) {
        throw "Protobuf generation failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Output "Generated Go and Python gRPC bindings."
