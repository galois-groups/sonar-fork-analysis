#!/bin/sh
# TODO: sign the release archive too.
version=`git describe --tags`
echo "Releasing $version"
