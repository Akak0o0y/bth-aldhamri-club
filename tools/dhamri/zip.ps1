param([string]$SourceDirectory, [string]$DestinationZip)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $DestinationZip) { throw 'Release ZIP already exists.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($SourceDirectory, $DestinationZip, [IO.Compression.CompressionLevel]::Optimal, $false)
