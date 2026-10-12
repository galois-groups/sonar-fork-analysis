# TODO: sign the release archive too.
$version = git describe --tags
Write-Output "Releasing $version"
