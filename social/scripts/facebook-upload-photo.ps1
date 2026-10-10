# stdin is base64 image data. The Page token stays out of argv and stdout.
param([string]$Endpoint, [string]$ContentType)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$multipart = New-Object System.Net.Http.MultipartFormDataContent
try {
  if (-not $env:ANNULO_FACEBOOK_PAGE_TOKEN) { throw 'Missing Facebook Page token' }
  $photoBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $source = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,$photoBytes)
  $source.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue($ContentType)
  $multipart.Add($source, 'source', 'photo')
  $multipart.Add((New-Object System.Net.Http.StringContent('false')), 'published')
  $client.Timeout = [TimeSpan]::FromSeconds(120)
  $client.DefaultRequestHeaders.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $env:ANNULO_FACEBOOK_PAGE_TOKEN)
  $response = $client.PostAsync($Endpoint, $multipart).GetAwaiter().GetResult()
  $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  [Console]::Write($responseBody + "`n" + [int]$response.StatusCode)
} catch {
  [Console]::Error.Write('Facebook photo upload did not complete.')
  exit 1
} finally {
  $multipart.Dispose()
  $client.Dispose()
}
