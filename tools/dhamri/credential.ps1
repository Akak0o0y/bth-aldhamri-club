param([ValidateSet('protect', 'unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoding = New-Object System.Text.UTF8Encoding($false)
try {
    $inputValue = [Console]::In.ReadToEnd()
    if ($Operation -eq 'protect') {
        $data = $encoding.GetBytes($inputValue)
        $protected = [Security.Cryptography.ProtectedData]::Protect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Console]::Out.Write([Convert]::ToBase64String($protected))
    } else {
        $data = [Convert]::FromBase64String($inputValue)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Console]::Out.Write($encoding.GetString($plain))
    }
} catch {
    [Console]::Error.Write('Windows could not protect or unlock this login. Run dhamri login again.')
    exit 1
}
